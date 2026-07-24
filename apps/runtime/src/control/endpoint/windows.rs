use std::{io, time::Duration};

use debrute_native_control::{
    WindowsControlConnection, WindowsControlEndpoint as NativeWindowsControlEndpoint,
    WindowsControlOwner as NativeWindowsControlOwner, WindowsEndpointClaim,
};

use super::{
    ControlEndpointAdapter, ControlEndpointKind, ControlEndpointOwnerAdapter, EndpointClaim,
    EndpointError,
};

#[derive(Debug, Clone)]
pub struct WindowsControlEndpoint(NativeWindowsControlEndpoint);

impl WindowsControlEndpoint {
    /// Resolves the named-pipe endpoint scoped to the current Windows user.
    ///
    /// # Errors
    ///
    /// Returns an endpoint error when the current user identity or pipe name
    /// cannot be resolved.
    pub fn for_current_user() -> Result<Self, EndpointError> {
        NativeWindowsControlEndpoint::for_current_user()
            .map(Self)
            .map_err(EndpointError::Io)
    }

    #[must_use]
    pub fn pipe_name(&self) -> &str {
        self.0.pipe_name()
    }

    /// Connects to the endpoint to wake a blocked owner accept.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when the wake connection cannot be
    /// opened.
    pub fn wake_accept(&self) -> io::Result<WindowsControlConnection> {
        self.0.wake_accept()
    }
}

impl ControlEndpointAdapter for WindowsControlEndpoint {
    const KIND: ControlEndpointKind = ControlEndpointKind::WindowsNamedPipe;
    type Owner = WindowsControlOwner;
    type Connection = WindowsControlConnection;

    fn connect_existing(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError> {
        self.0
            .connect_existing()
            .map(|mut connection| {
                connection.set_read_timeout(Some(handshake_timeout));
                connection
            })
            .map_err(EndpointError::Io)
    }

    fn claim_or_connect(
        &self,
        startup_wait: Duration,
        handshake_timeout: Duration,
    ) -> Result<EndpointClaim<Self::Owner, Self::Connection>, EndpointError> {
        self.0
            .claim_or_connect(startup_wait)
            .map(|claim| match claim {
                WindowsEndpointClaim::Owner(owner) => {
                    EndpointClaim::Owner(WindowsControlOwner(owner))
                }
                WindowsEndpointClaim::Existing(mut connection) => {
                    connection.set_read_timeout(Some(handshake_timeout));
                    EndpointClaim::Existing(connection)
                }
            })
            .map_err(|error| {
                if error.kind() == io::ErrorKind::TimedOut {
                    EndpointError::StartupTimedOut
                } else {
                    EndpointError::Io(error)
                }
            })
    }
}

#[derive(Debug)]
pub struct WindowsControlOwner(NativeWindowsControlOwner);

impl ControlEndpointOwnerAdapter for WindowsControlOwner {
    type Connection = WindowsControlConnection;

    fn accept_current_user(
        &self,
        handshake_timeout: Duration,
    ) -> Result<Self::Connection, EndpointError> {
        self.0
            .accept_current_user()
            .map(|mut connection| {
                connection.set_read_timeout(Some(handshake_timeout));
                connection
            })
            .map_err(|error| {
                if error.kind() == io::ErrorKind::PermissionDenied {
                    EndpointError::PeerSidMismatch
                } else {
                    EndpointError::Io(error)
                }
            })
    }
}
