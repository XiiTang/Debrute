use std::{
    error::Error,
    fmt,
    io::{self, Read},
};

use serde::{Serialize, de::DeserializeOwned};

use super::{ClientMessage, ServerMessage};

pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum FrameEncodeError {
    PayloadTooLarge { length: usize, maximum: usize },
    InvalidMessage(serde_json::Error),
}

#[derive(Debug)]
pub enum FrameDecodeError {
    Read(io::Error),
    EmptyPayload,
    PayloadTooLarge { length: usize, maximum: usize },
    InvalidMessage(serde_json::Error),
}

impl fmt::Display for FrameEncodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge { length, maximum } => {
                write!(
                    formatter,
                    "Control payload is {length} bytes; maximum is {maximum}"
                )
            }
            Self::InvalidMessage(error) => {
                write!(formatter, "Control message cannot be encoded: {error}")
            }
        }
    }
}

impl Error for FrameEncodeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::PayloadTooLarge { .. } => None,
            Self::InvalidMessage(error) => Some(error),
        }
    }
}

impl fmt::Display for FrameDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(error) => write!(formatter, "Control frame cannot be read: {error}"),
            Self::EmptyPayload => formatter.write_str("Control frame payload is empty"),
            Self::PayloadTooLarge { length, maximum } => {
                write!(
                    formatter,
                    "Control payload is {length} bytes; maximum is {maximum}"
                )
            }
            Self::InvalidMessage(error) => write!(formatter, "Control payload is invalid: {error}"),
        }
    }
}

impl Error for FrameDecodeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read(error) => Some(error),
            Self::InvalidMessage(error) => Some(error),
            Self::EmptyPayload | Self::PayloadTooLarge { .. } => None,
        }
    }
}

/// Encodes one closed client message into a complete Control frame.
///
/// # Errors
///
/// Returns [`FrameEncodeError`] when the JSON payload cannot be serialized or
/// exceeds the Control Channel's one-MiB limit.
pub fn encode_frame(message: &ClientMessage) -> Result<Vec<u8>, FrameEncodeError> {
    encode_json_frame(message)
}

/// Encodes one closed server message into a complete Control frame.
///
/// # Errors
///
/// Returns [`FrameEncodeError`] when the JSON payload cannot be serialized or
/// exceeds the Control Channel's one-MiB limit.
pub fn encode_server_frame(message: &ServerMessage) -> Result<Vec<u8>, FrameEncodeError> {
    encode_json_frame(message)
}

fn encode_json_frame(message: &impl Serialize) -> Result<Vec<u8>, FrameEncodeError> {
    let payload = serde_json::to_vec(message).map_err(FrameEncodeError::InvalidMessage)?;
    if payload.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameEncodeError::PayloadTooLarge {
            length: payload.len(),
            maximum: MAX_CONTROL_FRAME_BYTES,
        });
    }

    let payload_length =
        u32::try_from(payload.len()).map_err(|_| FrameEncodeError::PayloadTooLarge {
            length: payload.len(),
            maximum: MAX_CONTROL_FRAME_BYTES,
        })?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// Reads and decodes exactly one closed client message from a Control stream.
///
/// Bytes after the declared payload remain in `reader` for the next frame.
///
/// # Errors
///
/// Returns [`FrameDecodeError`] for incomplete input, an empty or oversized
/// payload, invalid UTF-8/JSON, or a message outside the closed schema.
pub fn read_frame(reader: &mut impl Read) -> Result<ClientMessage, FrameDecodeError> {
    read_json_frame(reader)
}

/// Reads and decodes exactly one closed server message from a Control stream.
///
/// Bytes after the declared payload remain in `reader` for the next frame.
///
/// # Errors
///
/// Returns [`FrameDecodeError`] for incomplete input, an empty or oversized
/// payload, invalid UTF-8/JSON, or a message outside the closed schema.
pub fn read_server_frame(reader: &mut impl Read) -> Result<ServerMessage, FrameDecodeError> {
    read_json_frame(reader)
}

fn read_json_frame<T: DeserializeOwned>(reader: &mut impl Read) -> Result<T, FrameDecodeError> {
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(FrameDecodeError::Read)?;
    let payload_length = u32::from_be_bytes(header) as usize;
    if payload_length == 0 {
        return Err(FrameDecodeError::EmptyPayload);
    }
    if payload_length > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameDecodeError::PayloadTooLarge {
            length: payload_length,
            maximum: MAX_CONTROL_FRAME_BYTES,
        });
    }

    let mut payload = vec![0_u8; payload_length];
    reader
        .read_exact(&mut payload)
        .map_err(FrameDecodeError::Read)?;
    serde_json::from_slice(&payload).map_err(FrameDecodeError::InvalidMessage)
}

pub(super) fn is_connection_closed(error: &FrameDecodeError) -> bool {
    matches!(
        error,
        FrameDecodeError::Read(error)
            if matches!(
                error.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
            )
    )
}
