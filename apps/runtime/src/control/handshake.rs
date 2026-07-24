use std::{
    error::Error,
    fmt,
    io::{self, Read, Write},
};

use super::{
    CONTROL_PROTOCOL_VERSION, ClientMessage, ClientRole, FrameDecodeError, FrameEncodeError,
    HandshakeRejection, PRODUCT_VERSION, RuntimeStatus, ServerMessage, encode_frame,
    encode_server_frame, read_frame, read_server_frame, validate_handshake,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedHandshake {
    pub instance_id: String,
    pub status: RuntimeStatus,
}

#[derive(Debug)]
pub enum ClientHandshakeError {
    Encode(FrameEncodeError),
    Write(io::Error),
    Decode(FrameDecodeError),
    Rejected(HandshakeRejection),
    IncompatibleProtocolVersion { received: u32 },
    IncompatibleProductVersion { received: String },
    UnexpectedMessage,
}

#[derive(Debug)]
pub enum ServerHandshakeError {
    Decode(FrameDecodeError),
    Encode(FrameEncodeError),
    Write(io::Error),
    Rejected(HandshakeRejection),
}

/// Sends the mandatory client handshake and validates the Runtime response.
///
/// # Errors
///
/// Returns [`ClientHandshakeError`] when framing or transport fails, Runtime
/// rejects the peer, or the response does not exactly match this product.
pub fn request_handshake(
    stream: &mut (impl Read + Write),
    role: ClientRole,
) -> Result<AcceptedHandshake, ClientHandshakeError> {
    let message = ClientMessage::handshake(role);
    let frame = encode_frame(&message).map_err(ClientHandshakeError::Encode)?;
    stream
        .write_all(&frame)
        .map_err(ClientHandshakeError::Write)?;
    stream.flush().map_err(ClientHandshakeError::Write)?;

    match read_server_frame(stream).map_err(ClientHandshakeError::Decode)? {
        ServerMessage::HandshakeAccepted {
            instance_id,
            protocol_version,
            product_version,
            status,
        } => {
            if protocol_version != CONTROL_PROTOCOL_VERSION {
                return Err(ClientHandshakeError::IncompatibleProtocolVersion {
                    received: protocol_version,
                });
            }
            if product_version != PRODUCT_VERSION {
                return Err(ClientHandshakeError::IncompatibleProductVersion {
                    received: product_version,
                });
            }
            Ok(AcceptedHandshake {
                instance_id,
                status,
            })
        }
        ServerMessage::HandshakeRejected { reason } => Err(ClientHandshakeError::Rejected(reason)),
        ServerMessage::Response { .. } | ServerMessage::Event { .. } => {
            Err(ClientHandshakeError::UnexpectedMessage)
        }
    }
}

/// Validates the mandatory first client frame and writes one typed response.
///
/// # Errors
///
/// Returns [`ServerHandshakeError`] for framing or transport failure, or after
/// a typed incompatibility rejection has been delivered.
pub fn serve_handshake(
    stream: &mut (impl Read + Write),
    instance_id: &str,
    status: RuntimeStatus,
) -> Result<ClientRole, ServerHandshakeError> {
    let role = read_handshake_request(stream)?;
    write_server_message(
        stream,
        &ServerMessage::handshake_accepted(instance_id, status),
    )?;
    Ok(role)
}

pub(super) fn read_handshake_request(
    stream: &mut (impl Read + Write),
) -> Result<ClientRole, ServerHandshakeError> {
    let message = read_frame(stream).map_err(ServerHandshakeError::Decode)?;
    match validate_handshake(&message) {
        Ok(role) => Ok(role),
        Err(reason) => {
            write_server_message(stream, &ServerMessage::handshake_rejected(reason))?;
            Err(ServerHandshakeError::Rejected(reason))
        }
    }
}

pub(super) fn write_server_message(
    stream: &mut impl Write,
    message: &ServerMessage,
) -> Result<(), ServerHandshakeError> {
    let frame = encode_server_frame(message).map_err(ServerHandshakeError::Encode)?;
    stream
        .write_all(&frame)
        .map_err(ServerHandshakeError::Write)?;
    stream.flush().map_err(ServerHandshakeError::Write)
}

impl fmt::Display for ClientHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(error) => {
                write!(formatter, "Control handshake cannot be encoded: {error}")
            }
            Self::Write(error) => write!(formatter, "Control handshake cannot be written: {error}"),
            Self::Decode(error) => {
                write!(formatter, "Control handshake response is invalid: {error}")
            }
            Self::Rejected(reason) => {
                write!(formatter, "Runtime rejected Control handshake: {reason:?}")
            }
            Self::IncompatibleProtocolVersion { received } => write!(
                formatter,
                "Runtime Control protocol version is incompatible: {received}"
            ),
            Self::IncompatibleProductVersion { received } => write!(
                formatter,
                "Runtime product version is incompatible: {received}"
            ),
            Self::UnexpectedMessage => {
                formatter.write_str("Runtime sent a product message before handshake acceptance")
            }
        }
    }
}

impl Error for ClientHandshakeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Encode(error) => Some(error),
            Self::Write(error) => Some(error),
            Self::Decode(error) => Some(error),
            Self::Rejected(_)
            | Self::IncompatibleProtocolVersion { .. }
            | Self::IncompatibleProductVersion { .. }
            | Self::UnexpectedMessage => None,
        }
    }
}

impl fmt::Display for ServerHandshakeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => {
                write!(formatter, "Control handshake request is invalid: {error}")
            }
            Self::Encode(error) => write!(
                formatter,
                "Control handshake response cannot be encoded: {error}"
            ),
            Self::Write(error) => write!(
                formatter,
                "Control handshake response cannot be written: {error}"
            ),
            Self::Rejected(reason) => {
                write!(formatter, "Control handshake was rejected: {reason:?}")
            }
        }
    }
}

impl Error for ServerHandshakeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode(error) => Some(error),
            Self::Encode(error) => Some(error),
            Self::Write(error) => Some(error),
            Self::Rejected(_) => None,
        }
    }
}
