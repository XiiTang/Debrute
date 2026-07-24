use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
    thread,
    time::Duration,
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

    /// Waits for `Ready`, writes `request` once, and waits for its response.
    ///
    /// Transport failure after the write is an unknown outcome. This method
    /// never reconnects or writes the request again.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when the role is not authorized,
    /// Runtime cannot reach `Ready`, framing fails, or the connection is lost.
    pub fn wait_ready_and_request(
        &mut self,
        request_id: impl Into<String>,
        request: ControlRequest,
    ) -> Result<ControlResponse, NativeControlClientError> {
        authorize_request(self.role, &request).map_err(NativeControlClientError::Role)?;
        self.wait_until_ready()?;
        let request_id = request_id.into();
        self.send_request(&request_id, request)
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

    fn wait_until_ready(&mut self) -> Result<(), NativeControlClientError> {
        while self.status == RuntimeStatus::Starting {
            let request_id = uuid::Uuid::new_v4().to_string();
            match self.send_request(&request_id, ControlRequest::Inspect)? {
                ControlResponse::Inspection { status, .. } => self.status = status,
                _ => return Err(NativeControlClientError::UnexpectedMessage),
            }
            if self.status == RuntimeStatus::Starting {
                thread::sleep(Duration::from_millis(25));
            }
        }
        match self.status {
            RuntimeStatus::Ready => Ok(()),
            RuntimeStatus::Exiting | RuntimeStatus::Replacing => {
                Err(NativeControlClientError::RuntimeStopping {
                    status: self.status,
                })
            }
            RuntimeStatus::Starting => unreachable!("Starting loop ended"),
        }
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
    /// Completes the bounded handshake and then removes the transport timeout
    /// before any product request can be issued.
    ///
    /// # Errors
    ///
    /// Returns [`NativeControlClientError`] when the handshake fails or the
    /// native transport cannot restore its normal blocking behavior.
    pub fn handshake_and_clear_timeouts(
        mut stream: Stream,
        role: ClientRole,
    ) -> Result<Self, NativeControlClientError> {
        let accepted =
            request_handshake(&mut stream, role).map_err(NativeControlClientError::Handshake)?;
        stream
            .clear_handshake_timeouts()
            .map_err(NativeControlClientError::ConnectionConfiguration)?;
        Ok(Self {
            stream: Some(stream),
            role,
            instance_id: accepted.instance_id,
            status: accepted.status,
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
            | Self::RuntimeLost
            | Self::UnexpectedMessage
            | Self::MismatchedResponse { .. } => None,
        }
    }
}
