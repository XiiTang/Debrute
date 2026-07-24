//! The closed native Control Channel protocol.

mod client;
mod desktop;
pub mod endpoint;
mod frame;
mod handshake;
mod protocol;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod server;
mod writer;

pub use client::{NativeControlClient, NativeControlClientError};
pub use desktop::{DesktopOpenError, DesktopOpenResult};
pub use frame::{
    FrameDecodeError, FrameEncodeError, MAX_CONTROL_FRAME_BYTES, encode_frame, encode_server_frame,
    read_frame, read_server_frame,
};
pub use handshake::{
    AcceptedHandshake, ClientHandshakeError, ServerHandshakeError, request_handshake,
    serve_handshake,
};
pub use protocol::{
    ActivationIntent, ActivationOutcome, CONTROL_OUTBOUND_QUEUE_CAPACITY, CONTROL_PROTOCOL,
    CONTROL_PROTOCOL_VERSION, ClientMessage, ClientRole, ControlErrorCode, ControlEvent,
    ControlRequest, ControlResponse, HandshakeRejection, PRODUCT_VERSION, ProjectFrontend,
    RecentProject, RoleViolation, RuntimeStatus, ServerMessage, WorkbenchRoute, authorize_request,
    validate_handshake,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use server::{
    ControlServerError, ControlTransport, RuntimeActionError, RuntimeActivationService,
    RuntimeControlState, WorkbenchInstallError, serve_control_connection,
};
pub use writer::OutboundError;
