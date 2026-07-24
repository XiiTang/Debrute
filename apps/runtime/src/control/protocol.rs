use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};
use ts_rs::TS;

pub const CONTROL_PROTOCOL: &str = "debrute-control";
pub const CONTROL_PROTOCOL_VERSION: u32 = 2;
pub const CONTROL_OUTBOUND_QUEUE_CAPACITY: usize = 64;
pub const PRODUCT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum ClientRole {
    Launcher,
    Cli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum RuntimeStatus {
    Starting,
    Ready,
    Exiting,
    Replacing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ClientMessage {
    Handshake {
        protocol: String,
        protocol_version: u32,
        product_version: String,
        role: ClientRole,
    },
    Request {
        request_id: String,
        request: ControlRequest,
    },
}

impl ClientMessage {
    #[must_use]
    pub fn handshake(role: ClientRole) -> Self {
        Self::Handshake {
            protocol: CONTROL_PROTOCOL.to_owned(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            product_version: PRODUCT_VERSION.to_owned(),
            role,
        }
    }

    #[must_use]
    pub fn request(request_id: impl Into<String>, request: ControlRequest) -> Self {
        Self::Request {
            request_id: request_id.into(),
            request,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ControlRequest {
    Activate { intent: ActivationIntent },
    Inspect,
    CreateCliAuthorization,
    RegisterDevWorkbenchOrigin { origin: String },
    CreateDesktopLaunchTicket { window_key: String },
    DesktopWindowClosed { window_key: String },
    QuitProduct,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ActivationIntent {
    EnsureRuntime,
    OpenDefaultFrontend,
    OpenDesktop,
    OpenBrowser,
    OpenProject {
        project_root: String,
        frontend: ProjectFrontend,
    },
    OpenKnownProject {
        project_id: String,
        frontend: ProjectFrontend,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum ProjectFrontend {
    Default,
    Desktop,
    Browser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum ActivationOutcome {
    Ensured,
    Opened,
    FocusedExisting,
    HandledByExistingDesktop,
    PromotedToDesktopHost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum WorkbenchRoute {
    Root,
    Project { project_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub struct RecentProject {
    pub project_id: String,
    pub project_root: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum HandshakeRejection {
    ExpectedHandshake,
    IncompatibleProtocol,
    IncompatibleProtocolVersion,
    IncompatibleProductVersion,
    RuntimeStopping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleViolation {
    pub role: ClientRole,
    pub request: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ControlResponse {
    Ok,
    Activation {
        outcome: ActivationOutcome,
    },
    Inspection {
        instance_id: String,
        status: RuntimeStatus,
        executable_identity: Option<String>,
    },
    CliAuthorization {
        origin: String,
        authorization: String,
    },
    DevWorkbenchOriginRegistered {
        runtime_origin: String,
    },
    DesktopLaunchTicket {
        ticket: String,
        url: String,
        theme_preference: String,
    },
    Rejected {
        code: ControlErrorCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "runtime-control/")]
pub enum ControlErrorCode {
    RoleDenied,
    RuntimeStarting,
    RuntimeExiting,
    UpdateCommitInProgress,
    InvalidActivation,
    InvalidRoute,
    InvalidDevWorkbenchOrigin,
    DevWorkbenchOriginAlreadyRegistered,
    InvalidDesktopWindow,
    DesktopUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ControlEvent {
    DesktopRecentProjectsChanged {
        #[ts(type = "number")]
        global_revision: u64,
        recent_projects: Vec<RecentProject>,
    },
    DesktopWindowOpenRequested {
        window_key: String,
        route: WorkbenchRoute,
    },
    DesktopWindowFocusRequested {
        window_key: String,
    },
    ProductExiting,
    ProductReplacing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
#[ts(export, export_to = "runtime-control/")]
pub enum ServerMessage {
    HandshakeAccepted {
        instance_id: String,
        protocol_version: u32,
        product_version: String,
        status: RuntimeStatus,
    },
    HandshakeRejected {
        reason: HandshakeRejection,
    },
    Response {
        request_id: String,
        response: ControlResponse,
    },
    Event {
        event: ControlEvent,
    },
}

impl ServerMessage {
    #[must_use]
    pub fn handshake_accepted(instance_id: impl Into<String>, status: RuntimeStatus) -> Self {
        Self::HandshakeAccepted {
            instance_id: instance_id.into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            product_version: PRODUCT_VERSION.to_owned(),
            status,
        }
    }

    #[must_use]
    pub const fn handshake_rejected(reason: HandshakeRejection) -> Self {
        Self::HandshakeRejected { reason }
    }

    #[must_use]
    pub fn response(request_id: impl Into<String>, response: ControlResponse) -> Self {
        Self::Response {
            request_id: request_id.into(),
            response,
        }
    }

    #[must_use]
    pub const fn event(event: ControlEvent) -> Self {
        Self::Event { event }
    }
}

/// Validates the exact Control protocol and Product versions for a handshake.
///
/// # Errors
///
/// Returns [`HandshakeRejection`] when any closed handshake field is incompatible.
pub fn validate_handshake(message: &ClientMessage) -> Result<ClientRole, HandshakeRejection> {
    let ClientMessage::Handshake {
        protocol,
        protocol_version,
        product_version,
        role,
    } = message
    else {
        return Err(HandshakeRejection::ExpectedHandshake);
    };

    if protocol != CONTROL_PROTOCOL {
        return Err(HandshakeRejection::IncompatibleProtocol);
    }
    if *protocol_version != CONTROL_PROTOCOL_VERSION {
        return Err(HandshakeRejection::IncompatibleProtocolVersion);
    }
    if product_version != PRODUCT_VERSION {
        return Err(HandshakeRejection::IncompatibleProductVersion);
    }
    Ok(*role)
}

/// Enforces requests available to each public native role. Desktop-host-only
/// requests receive an additional connection-state check in the Control server.
///
/// # Errors
///
/// Returns [`RoleViolation`] when `request` is outside the role's closed surface.
pub fn authorize_request(role: ClientRole, request: &ControlRequest) -> Result<(), RoleViolation> {
    let allowed = match role {
        ClientRole::Launcher => matches!(
            request,
            ControlRequest::Activate { .. }
                | ControlRequest::Inspect
                | ControlRequest::RegisterDevWorkbenchOrigin { .. }
                | ControlRequest::CreateDesktopLaunchTicket { .. }
                | ControlRequest::DesktopWindowClosed { .. }
                | ControlRequest::QuitProduct
        ),
        ClientRole::Cli => matches!(
            request,
            ControlRequest::Activate { .. }
                | ControlRequest::Inspect
                | ControlRequest::CreateCliAuthorization
                | ControlRequest::QuitProduct
        ),
    };
    if allowed {
        Ok(())
    } else {
        Err(RoleViolation {
            role,
            request: request.name(),
        })
    }
}

impl ControlRequest {
    const fn name(&self) -> &'static str {
        match self {
            Self::Activate { .. } => "activate",
            Self::Inspect => "inspect",
            Self::CreateCliAuthorization => "create_cli_authorization",
            Self::RegisterDevWorkbenchOrigin { .. } => "register_dev_workbench_origin",
            Self::CreateDesktopLaunchTicket { .. } => "create_desktop_launch_ticket",
            Self::DesktopWindowClosed { .. } => "desktop_window_closed",
            Self::QuitProduct => "quit_product",
        }
    }
}

impl fmt::Display for RoleViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Control role {:?} cannot issue {}",
            self.role, self.request
        )
    }
}

impl Error for RoleViolation {}

#[cfg(test)]
mod bindings {
    use std::{fs, path::Path};

    use super::{CONTROL_OUTBOUND_QUEUE_CAPACITY, CONTROL_PROTOCOL, CONTROL_PROTOCOL_VERSION};
    use crate::control::MAX_CONTROL_FRAME_BYTES;

    #[test]
    fn export_bindings_controlconstants() {
        let directory = Path::new(env!("TS_RS_EXPORT_DIR")).join("runtime-control");
        fs::create_dir_all(&directory).expect("Control binding directory should be created");
        fs::write(
            directory.join("constants.ts"),
            format!(
                "// This file is generated from apps/runtime/src/control/protocol.rs. Do not edit this file manually.\n\
                 export const CONTROL_PROTOCOL = {CONTROL_PROTOCOL:?};\n\
                 export const CONTROL_PROTOCOL_VERSION = {CONTROL_PROTOCOL_VERSION};\n\
                 export const CONTROL_OUTBOUND_QUEUE_CAPACITY = {CONTROL_OUTBOUND_QUEUE_CAPACITY};\n\
                 export const MAX_CONTROL_FRAME_BYTES = {MAX_CONTROL_FRAME_BYTES};\n"
            ),
        )
        .expect("Control constants should be exported");
    }
}
