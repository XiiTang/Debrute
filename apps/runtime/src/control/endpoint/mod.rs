//! Current-user native endpoint ownership and transport adapters.

use std::{error::Error, fmt, io, time::Duration};

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::{MacOsControlEndpoint, MacOsControlOwner};
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{WindowsControlEndpoint, WindowsControlOwner};

/// The result of atomically ensuring the current user's Control endpoint.
#[derive(Debug)]
pub enum EndpointClaim<Owner, Connection> {
    Owner(Owner),
    Existing(Connection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlEndpointKind {
    MacOsUnixDomainSocket,
    WindowsNamedPipe,
}

/// Platform Adapter contract shared by Unix sockets and Windows named pipes.
pub trait ControlEndpointAdapter {
    const KIND: ControlEndpointKind;
    type Owner: ControlEndpointOwnerAdapter<Connection = Self::Connection>;
    type Connection;

    /// Connects only when a Runtime already owns the endpoint.
    ///
    /// # Errors
    /// Returns [`EndpointError`] without claiming ownership or starting Runtime.
    fn connect_existing(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError>;

    /// Connects to the current owner or atomically becomes the owner.
    ///
    /// # Errors
    ///
    /// Returns [`EndpointError`] when the endpoint cannot be connected, claimed,
    /// or securely materialized before `startup_wait` expires, or when the
    /// existing connection cannot be bounded by `handshake_timeout`.
    fn claim_or_connect(
        &self,
        startup_wait: Duration,
        handshake_timeout: Duration,
    ) -> Result<EndpointClaim<Self::Owner, Self::Connection>, EndpointError>;
}

/// Platform owner contract for accepting only a current-user native peer.
pub trait ControlEndpointOwnerAdapter {
    type Connection;

    /// Accepts one kernel-identified current-user connection.
    ///
    /// # Errors
    ///
    /// Returns [`EndpointError`] when transport accept, peer inspection,
    /// current-user authorization, or timeout setup fails.
    fn accept_current_user(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError>;
}

#[derive(Debug)]
pub enum EndpointError {
    Absent,
    Io(io::Error),
    EndpointDirectoryOwnerMismatch { expected: u32, actual: u32 },
    PeerUserMismatch { expected: u32, actual: u32 },
    PeerSidMismatch,
    StartupTimedOut,
}

impl EndpointError {
    #[must_use]
    pub fn is_absent(&self) -> bool {
        match self {
            Self::Absent | Self::StartupTimedOut => true,
            Self::Io(error) => matches!(
                error.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::WouldBlock
                    | io::ErrorKind::TimedOut
            ),
            Self::EndpointDirectoryOwnerMismatch { .. }
            | Self::PeerUserMismatch { .. }
            | Self::PeerSidMismatch => false,
        }
    }
}

impl fmt::Display for EndpointError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => formatter.write_str("Control endpoint is absent"),
            Self::Io(error) => write!(formatter, "Control endpoint failed: {error}"),
            Self::EndpointDirectoryOwnerMismatch { expected, actual } => write!(
                formatter,
                "Control endpoint directory user {actual} does not match Runtime user {expected}"
            ),
            Self::PeerUserMismatch { expected, actual } => write!(
                formatter,
                "Control peer user {actual} does not match Runtime user {expected}"
            ),
            Self::PeerSidMismatch => {
                formatter.write_str("Control peer SID does not match Runtime user SID")
            }
            Self::StartupTimedOut => formatter.write_str("Control endpoint startup timed out"),
        }
    }
}

impl Error for EndpointError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Absent
            | Self::EndpointDirectoryOwnerMismatch { .. }
            | Self::PeerUserMismatch { .. }
            | Self::PeerSidMismatch
            | Self::StartupTimedOut => None,
        }
    }
}

impl From<io::Error> for EndpointError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
