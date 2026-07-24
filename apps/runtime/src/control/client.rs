use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
    thread,
    time::{Duration, Instant},
};

use super::{
    ClientHandshakeError, ClientMessage, ClientRole, ControlEvent, ControlRequest, ControlResponse,
    FrameDecodeError, FrameEncodeError, RoleViolation, RuntimeStatus, ServerMessage,
    authorize_request, encode_frame, frame::is_connection_closed, read_server_frame,
    request_handshake,
};

pub struct NativeControlClient<Stream> {
    stream: Option<Stream>,
    role: ClientRole,
    instance_id: String,
    status: RuntimeStatus,
    ready_observed: bool,
}

impl<Stream: Read + Write> NativeControlClient<Stream> {
    /// Completes the mandatory handshake over an already bounded connection.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when the handshake fails.
    pub fn handshake(
        mut stream: Stream,
        role: ClientRole,
    ) -> Result<Self, NativeControlClientError> {
        let accepted =
            request_handshake(&mut stream, role).map_err(NativeControlClientError::Handshake)?;
        Ok(Self {
            stream: Some(stream),
            role,
            instance_id: accepted.instance_id,
            status: accepted.status,
            ready_observed: accepted.status == RuntimeStatus::Ready,
        })
    }

    #[must_use]
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    #[must_use]
    pub const fn status(&self) -> RuntimeStatus {
        self.status
    }

    /// Requests the closed Runtime inspection snapshot without waiting for
    /// business readiness.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when framing fails or the
    /// connection is lost. The request is never replayed.
    pub fn inspect(
        &mut self,
        request_id: impl Into<String>,
    ) -> Result<ControlResponse, NativeControlClientError> {
        let request = ControlRequest::Inspect;
        authorize_request(self.role, &request).map_err(NativeControlClientError::Role)?;
        let request_id = request_id.into();
        self.send_request(&request_id, request)
    }

    /// Sends Product Quit without waiting for Runtime readiness.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when framing fails or the
    /// connection is lost. The request is never replayed.
    pub fn quit_product(
        &mut self,
        request_id: impl Into<String>,
    ) -> Result<ControlResponse, NativeControlClientError> {
        let request = ControlRequest::QuitProduct;
        authorize_request(self.role, &request).map_err(NativeControlClientError::Role)?;
        let request_id = request_id.into();
        self.send_request(&request_id, request)
    }

    fn send_request(
        &mut self,
        request_id: &str,
        request: ControlRequest,
    ) -> Result<ControlResponse, NativeControlClientError> {
        let frame = encode_frame(&ClientMessage::request(request_id, request))
            .map_err(NativeControlClientError::Encode)?;
        let write_result = match self.stream.as_mut() {
            Some(stream) => stream.write_all(&frame).and_then(|()| stream.flush()),
            None => return Err(NativeControlClientError::RuntimeLost),
        };
        if let Err(error) = write_result {
            self.stream.take();
            return Err(NativeControlClientError::Write(error));
        }
        self.read_response(request_id)
    }

    fn read_response(
        &mut self,
        expected_request_id: &str,
    ) -> Result<ControlResponse, NativeControlClientError> {
        match self.read_message()? {
            ServerMessage::Response {
                request_id,
                response,
            } if request_id == expected_request_id => Ok(response),
            ServerMessage::Response { request_id, .. } => {
                Err(NativeControlClientError::MismatchedResponse {
                    expected: expected_request_id.to_owned(),
                    actual: request_id,
                })
            }
            ServerMessage::Event {
                event:
                    ControlEvent::DesktopWindowOpenRequested { .. }
                    | ControlEvent::DesktopRecentProjectsChanged { .. }
                    | ControlEvent::DesktopWindowFocusRequested { .. }
                    | ControlEvent::ProductExiting
                    | ControlEvent::ProductReplacing,
            }
            | ServerMessage::HandshakeAccepted { .. }
            | ServerMessage::HandshakeRejected { .. } => {
                Err(NativeControlClientError::UnexpectedMessage)
            }
        }
    }

    fn read_message(&mut self) -> Result<ServerMessage, NativeControlClientError> {
        let result = match self.stream.as_mut() {
            Some(stream) => read_server_frame(stream),
            None => return Err(NativeControlClientError::RuntimeLost),
        };
        result.map_err(|error| {
            self.stream.take();
            if is_connection_closed(&error) {
                NativeControlClientError::RuntimeLost
            } else {
                NativeControlClientError::Decode(error)
            }
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl<Stream: super::ControlTransport> NativeControlClient<Stream> {
    /// Waits for `Ready` until one absolute deadline, writes `request` once,
    /// and then waits for its response without the readiness timeout.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when the role is not authorized,
    /// Runtime misses the deadline, framing fails, or the connection is lost.
    pub fn wait_ready_and_request_until(
        &mut self,
        deadline: Instant,
        request_id: impl Into<String>,
        request: ControlRequest,
    ) -> Result<ControlResponse, NativeControlClientError> {
        authorize_request(self.role, &request).map_err(NativeControlClientError::Role)?;
        self.wait_until_ready(deadline)?;
        let request_id = request_id.into();
        self.send_request(&request_id, request)
    }

    fn wait_until_ready(&mut self, deadline: Instant) -> Result<(), NativeControlClientError> {
        loop {
            if self.ready_observed {
                self.configure_io_timeout(None)?;
                return Ok(());
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or(NativeControlClientError::RuntimeReadyTimeout)?;
            match self.status {
                RuntimeStatus::Ready => {
                    self.ready_observed = true;
                    self.configure_io_timeout(None)?;
                    return Ok(());
                }
                RuntimeStatus::Exiting | RuntimeStatus::Replacing => {
                    return Err(NativeControlClientError::RuntimeStopping {
                        status: self.status,
                    });
                }
                RuntimeStatus::Starting => {}
            }
            self.configure_io_timeout(Some(remaining))?;
            let request_id = uuid::Uuid::new_v4().to_string();
            match self.send_request(&request_id, ControlRequest::Inspect) {
                Ok(ControlResponse::Inspection { status, .. }) => {
                    self.status = status;
                    if status == RuntimeStatus::Ready {
                        deadline
                            .checked_duration_since(Instant::now())
                            .filter(|remaining| !remaining.is_zero())
                            .ok_or(NativeControlClientError::RuntimeReadyTimeout)?;
                        self.ready_observed = true;
                        self.configure_io_timeout(None)?;
                        return Ok(());
                    }
                }
                Ok(_) => return Err(NativeControlClientError::UnexpectedMessage),
                Err(error) if is_timeout_error(&error) => {
                    return Err(NativeControlClientError::RuntimeReadyTimeout);
                }
                Err(error) => return Err(error),
            }
            if self.status == RuntimeStatus::Starting {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .filter(|remaining| !remaining.is_zero())
                    .ok_or(NativeControlClientError::RuntimeReadyTimeout)?;
                thread::sleep(Duration::from_millis(25).min(remaining));
            }
        }
    }

    fn configure_io_timeout(
        &mut self,
        timeout: Option<Duration>,
    ) -> Result<(), NativeControlClientError> {
        self.stream
            .as_mut()
            .ok_or(NativeControlClientError::RuntimeLost)?
            .set_io_timeout(timeout)
            .map_err(NativeControlClientError::ConnectionConfiguration)
    }

    /// Completes the handshake within one absolute deadline and then removes
    /// the transport timeout before any product request can be issued.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when the handshake fails or the
    /// native transport cannot restore its normal blocking behavior.
    pub fn handshake_and_clear_timeouts(
        mut stream: Stream,
        role: ClientRole,
        deadline: Instant,
    ) -> Result<Self, NativeControlClientError> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(NativeControlClientError::HandshakeDeadlineExceeded)?;
        stream
            .set_io_timeout(Some(remaining))
            .map_err(NativeControlClientError::ConnectionConfiguration)?;
        let accepted = request_handshake(&mut stream, role).map_err(|error| {
            if is_handshake_timeout(&error) && Instant::now() >= deadline {
                NativeControlClientError::HandshakeDeadlineExceeded
            } else {
                NativeControlClientError::Handshake(error)
            }
        })?;
        deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(NativeControlClientError::HandshakeDeadlineExceeded)?;
        stream
            .clear_handshake_timeouts()
            .map_err(NativeControlClientError::ConnectionConfiguration)?;
        Ok(Self {
            stream: Some(stream),
            role,
            instance_id: accepted.instance_id,
            status: accepted.status,
            ready_observed: accepted.status == RuntimeStatus::Ready,
        })
    }
}

#[derive(Debug)]
pub enum NativeControlClientError {
    Handshake(ClientHandshakeError),
    ConnectionConfiguration(io::Error),
    Role(RoleViolation),
    Encode(FrameEncodeError),
    Write(io::Error),
    Decode(FrameDecodeError),
    RuntimeStopping { status: RuntimeStatus },
    HandshakeDeadlineExceeded,
    RuntimeReadyTimeout,
    RuntimeLost,
    UnexpectedMessage,
    MismatchedResponse { expected: String, actual: String },
}

impl fmt::Display for NativeControlClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Handshake(error) => write!(formatter, "{error}"),
            Self::ConnectionConfiguration(error) => {
                write!(formatter, "Control connection cannot finish setup: {error}")
            }
            Self::Role(error) => write!(formatter, "{error}"),
            Self::Encode(error) => write!(formatter, "Control request cannot be encoded: {error}"),
            Self::Write(error) => write!(formatter, "Control request cannot be written: {error}"),
            Self::Decode(error) => write!(formatter, "Control response is invalid: {error}"),
            Self::RuntimeStopping { status } => {
                write!(formatter, "Runtime is stopping: {status:?}")
            }
            Self::HandshakeDeadlineExceeded => {
                formatter.write_str("Control handshake missed its absolute deadline")
            }
            Self::RuntimeReadyTimeout => {
                formatter.write_str("Runtime did not become Ready before the absolute deadline")
            }
            Self::RuntimeLost => formatter.write_str("Runtime connection was lost"),
            Self::UnexpectedMessage => formatter.write_str("Runtime sent an unexpected message"),
            Self::MismatchedResponse { expected, actual } => write!(
                formatter,
                "Runtime response id {actual} does not match request {expected}"
            ),
        }
    }
}

impl Error for NativeControlClientError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Handshake(error) => Some(error),
            Self::ConnectionConfiguration(error) | Self::Write(error) => Some(error),
            Self::Role(error) => Some(error),
            Self::Encode(error) => Some(error),
            Self::Decode(error) => Some(error),
            Self::RuntimeStopping { .. }
            | Self::HandshakeDeadlineExceeded
            | Self::RuntimeReadyTimeout
            | Self::RuntimeLost
            | Self::UnexpectedMessage
            | Self::MismatchedResponse { .. } => None,
        }
    }
}

impl NativeControlClientError {
    #[must_use]
    pub fn is_handshake_timeout(&self) -> bool {
        matches!(self, Self::HandshakeDeadlineExceeded)
            || matches!(self, Self::Handshake(error) if is_handshake_timeout(error))
    }
}

fn is_timeout_error(error: &NativeControlClientError) -> bool {
    matches!(
        error,
        NativeControlClientError::Decode(FrameDecodeError::Read(error))
            | NativeControlClientError::Write(error)
            if is_io_timeout(error)
    )
}

fn is_handshake_timeout(error: &ClientHandshakeError) -> bool {
    matches!(
        error,
        ClientHandshakeError::Decode(FrameDecodeError::Read(error))
            | ClientHandshakeError::Write(error)
            if is_io_timeout(error)
    )
}

fn is_io_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}
