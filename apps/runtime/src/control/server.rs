use std::{
    collections::HashMap,
    error::Error,
    fmt,
    io::{self, Read, Write},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
use std::{net::Shutdown, os::unix::net::UnixStream};

#[cfg(target_os = "windows")]
use debrute_native_control::WindowsControlConnection;

use uuid::Uuid;

use crate::workbench::{
    CliAuthorizationVerifier, SourceWorkbenchRegistrationError, WorkbenchLaunchError,
    WorkbenchLaunchService,
};

use super::{
    ActivationIntent, ActivationOutcome, ClientMessage, ClientRole, ControlErrorCode, ControlEvent,
    ControlRequest, ControlResponse, DesktopOpenError, DesktopOpenResult, FrameDecodeError,
    HandshakeRejection, RecentProject, RuntimeStatus, ServerHandshakeError, ServerMessage,
    WorkbenchRoute, authorize_request,
    desktop::{DesktopHostRegistrationError, DesktopWindowTopology},
    frame::is_connection_closed,
    handshake::read_handshake_request,
    read_frame,
    writer::{ControlSender, OutboundError, start_serialized_writer},
};

pub struct RuntimeControlState {
    inner: Mutex<RuntimeControlInner>,
    desktop: DesktopWindowTopology,
    lifecycle: Mutex<Option<LifecycleTransition>>,
    shutdown_sender: mpsc::SyncSender<RuntimeShutdown>,
    shutdown_receiver: Mutex<Option<mpsc::Receiver<RuntimeShutdown>>>,
    activation_service: Mutex<Option<Arc<dyn RuntimeActivationService>>>,
    accepting_connections: AtomicBool,
}

pub trait RuntimeActivationService: Send + Sync {
    /// Executes one authorized activation exactly once.
    ///
    /// # Errors
    ///
    /// Returns a closed Control error when the requested target cannot be opened.
    fn activate(&self, intent: &ActivationIntent) -> Result<ActivationOutcome, ControlErrorCode>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LifecycleTransition {
    UpdatePreparing(String),
    Exiting,
    Replacing(String),
    SystemTermination,
}

struct RuntimeControlInner {
    instance_id: String,
    executable_identity: Option<String>,
    status: RuntimeStatus,
    workbench: Option<Arc<WorkbenchLaunchService>>,
    recent_projects_revision: u64,
    recent_projects: Vec<RecentProject>,
    connections: HashMap<ConnectionId, ConnectionRecord>,
    cli_authorizations: HashMap<CliAuthorization, ConnectionId>,
}

struct ConnectionRecord {
    role: ClientRole,
    desktop_host: bool,
    sender: ControlSender,
    cli_authorizations: Vec<CliAuthorization>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct ConnectionId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CliAuthorization(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeShutdown {
    ProductQuit,
    ProductUpdate { transaction_id: String },
    SystemTermination,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeActionError {
    RuntimeNotReady { status: RuntimeStatus },
    WorkbenchUnavailable,
    WorkbenchLaunch(WorkbenchLaunchError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopPresentationError {
    RevisionExhausted,
    Outbound(OutboundError),
}

impl RuntimeControlState {
    #[must_use]
    pub fn new(instance_id: impl Into<String>, status: RuntimeStatus) -> Self {
        Self::new_with_executable_identity(instance_id, status, None)
    }

    #[must_use]
    pub fn new_with_executable_identity(
        instance_id: impl Into<String>,
        status: RuntimeStatus,
        executable_identity: Option<String>,
    ) -> Self {
        let (shutdown_sender, shutdown_receiver) = mpsc::sync_channel(1);
        Self {
            inner: Mutex::new(RuntimeControlInner {
                instance_id: instance_id.into(),
                executable_identity,
                status,
                workbench: None,
                recent_projects_revision: 0,
                recent_projects: Vec::new(),
                connections: HashMap::new(),
                cli_authorizations: HashMap::new(),
            }),
            desktop: DesktopWindowTopology::new(),
            lifecycle: Mutex::new(None),
            shutdown_sender,
            shutdown_receiver: Mutex::new(Some(shutdown_receiver)),
            activation_service: Mutex::new(None),
            accepting_connections: AtomicBool::new(true),
        }
    }

    #[must_use]
    pub fn status(&self) -> RuntimeStatus {
        self.lock_inner().status
    }

    #[must_use]
    pub fn instance_id(&self) -> String {
        self.lock_inner().instance_id.clone()
    }

    #[must_use]
    pub fn take_shutdown_receiver(&self) -> Option<mpsc::Receiver<RuntimeShutdown>> {
        self.shutdown_receiver
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    pub fn set_status(&self, status: RuntimeStatus) {
        self.lock_inner().status = status;
    }

    /// Replaces the Desktop recent-Project projection when the revision advances.
    ///
    /// # Errors
    ///
    /// Returns an error if the new projection cannot be delivered to a connected
    /// Desktop host.
    pub fn set_recent_projects(
        &self,
        global_revision: u64,
        recent_projects: Vec<RecentProject>,
    ) -> Result<bool, DesktopPresentationError> {
        let mut inner = self.lock_inner();
        if global_revision < inner.recent_projects_revision {
            return Ok(false);
        }
        if global_revision == inner.recent_projects_revision
            && inner.recent_projects == recent_projects
        {
            return Ok(false);
        }
        inner.recent_projects_revision = global_revision;
        inner.recent_projects = recent_projects;
        let event = ControlEvent::DesktopRecentProjectsChanged {
            global_revision,
            recent_projects: inner.recent_projects.clone(),
        };
        let senders = inner
            .connections
            .values()
            .filter(|connection| connection.desktop_host)
            .map(|connection| connection.sender.clone())
            .collect::<Vec<_>>();
        drop(inner);
        let mut first_error = None;
        for sender in senders {
            if let Err(error) = sender.send(ServerMessage::event(event.clone()))
                && first_error.is_none()
            {
                first_error = Some(error);
            }
        }
        first_error.map_or(Ok(true), |error| {
            Err(DesktopPresentationError::Outbound(error))
        })
    }

    pub fn install_activation_service(&self, service: Arc<dyn RuntimeActivationService>) -> bool {
        let mut current = self
            .activation_service
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if current.is_some() {
            return false;
        }
        *current = Some(service);
        true
    }

    pub fn close_connections(&self) {
        let senders = self
            .lock_inner()
            .connections
            .values()
            .map(|connection| connection.sender.clone())
            .collect::<Vec<_>>();
        for sender in senders {
            sender.close();
        }
    }

    #[must_use]
    pub fn is_cli_authorized(&self, authorization: &str) -> bool {
        self.lock_inner()
            .cli_authorizations
            .contains_key(&CliAuthorization(authorization.to_owned()))
    }

    /// Installs the one Workbench authority once.
    ///
    /// # Errors
    ///
    /// Returns [`WorkbenchInstallError`] for a second installation attempt.
    pub fn install_workbench(
        self: &Arc<Self>,
        workbench: Arc<WorkbenchLaunchService>,
    ) -> Result<(), WorkbenchInstallError> {
        let mut inner = self.lock_inner();
        if inner.workbench.is_some() {
            return Err(WorkbenchInstallError::AlreadyInstalled);
        }
        inner.workbench = Some(workbench);
        Ok(())
    }

    /// Opens or focuses one Desktop window through the current promoted host.
    ///
    /// # Errors
    ///
    /// Returns [`DesktopOpenError`] if Runtime is not Ready or no host can receive it.
    pub fn open_desktop_window(
        &self,
        route: &WorkbenchRoute,
    ) -> Result<DesktopOpenResult, DesktopOpenError> {
        if self.status() != RuntimeStatus::Ready {
            return Err(DesktopOpenError::HostUnavailable);
        }
        self.desktop.open(route)
    }

    pub(crate) fn retarget_desktop_window(
        &self,
        binding: &crate::workbench::DesktopLaunchBinding,
        route: WorkbenchRoute,
    ) -> bool {
        self.desktop.retarget(binding, route)
    }

    pub(crate) fn focus_desktop_window(
        &self,
        binding: &crate::workbench::DesktopLaunchBinding,
    ) -> Result<bool, OutboundError> {
        self.desktop.focus(binding)
    }

    /// Returns one stable Workbench URL. It contains no credential or launch nonce.
    ///
    /// # Errors
    ///
    /// Returns [`RuntimeActionError`] while Runtime is not Ready or Workbench is absent.
    pub fn workbench_url(&self, route: &WorkbenchRoute) -> Result<String, RuntimeActionError> {
        let inner = self.lock_inner();
        if inner.status != RuntimeStatus::Ready {
            return Err(RuntimeActionError::RuntimeNotReady {
                status: inner.status,
            });
        }
        let workbench = inner
            .workbench
            .clone()
            .ok_or(RuntimeActionError::WorkbenchUnavailable)?;
        drop(inner);
        workbench
            .url_for_route(route)
            .map_err(RuntimeActionError::WorkbenchLaunch)
    }

    /// Starts the Product update commit boundary without collecting frontend decisions.
    /// A Product Quit that reaches the state first replaces this preparation.
    pub fn request_product_update(
        self: &Arc<Self>,
        transaction_id: &str,
        commit: Box<dyn FnOnce() -> Result<(), String> + Send>,
        on_cancel: Box<dyn FnOnce(&str) + Send>,
    ) -> bool {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if lifecycle.is_some()
            || self.status() != RuntimeStatus::Ready
            || Uuid::parse_str(transaction_id).is_err()
        {
            return false;
        }
        *lifecycle = Some(LifecycleTransition::UpdatePreparing(
            transaction_id.to_owned(),
        ));
        let state = Arc::clone(self);
        let transaction_id = transaction_id.to_owned();
        if thread::Builder::new()
            .name("debrute-product-update".to_owned())
            .spawn(move || {
                let mut lifecycle = state
                    .lifecycle
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if !matches!(
                    lifecycle.as_ref(),
                    Some(LifecycleTransition::UpdatePreparing(current)) if current == &transaction_id
                ) {
                    drop(lifecycle);
                    on_cancel("Product Quit won before the update commit boundary.");
                    return;
                }
                *lifecycle = Some(LifecycleTransition::Replacing(transaction_id.clone()));
                state.accepting_connections.store(false, Ordering::Release);
                state.lock_inner().status = RuntimeStatus::Replacing;
                drop(lifecycle);
                state.broadcast_event_with_flush_budget(
                    &ControlEvent::ProductReplacing,
                    Duration::from_millis(250),
                );
                if let Err(error) = commit() {
                    on_cancel(&error);
                }
                let _ = state
                    .shutdown_sender
                    .send(RuntimeShutdown::ProductUpdate { transaction_id });
            })
            .is_err()
        {
            *lifecycle = None;
            return false;
        }
        true
    }

    pub fn request_system_termination(&self) {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if matches!(
            lifecycle.as_ref(),
            Some(LifecycleTransition::SystemTermination)
        ) {
            return;
        }
        *lifecycle = Some(LifecycleTransition::SystemTermination);
        self.accepting_connections.store(false, Ordering::Release);
        self.lock_inner().status = RuntimeStatus::Exiting;
        let _ = self
            .shutdown_sender
            .try_send(RuntimeShutdown::SystemTermination);
    }

    /// Requests the same one-shot Product Quit used by native Control.
    ///
    /// # Errors
    ///
    /// Returns `update_commit_in_progress` only after Product replacement won.
    pub fn request_product_quit(&self) -> Result<(), ControlErrorCode> {
        match self.begin_product_quit() {
            QuitAdmission::Started => {
                self.finish_product_quit();
                Ok(())
            }
            QuitAdmission::AlreadyAccepted => Ok(()),
            QuitAdmission::UpdateWon => Err(ControlErrorCode::UpdateCommitInProgress),
        }
    }

    /// Executes one Ready activation through the installed platform adapter.
    ///
    /// # Errors
    ///
    /// Returns a stable Control error when activation cannot be completed.
    pub fn activate_intent(
        &self,
        intent: &ActivationIntent,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        if matches!(intent, ActivationIntent::EnsureRuntime) {
            return Ok(ActivationOutcome::Ensured);
        }
        let service = self
            .activation_service
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        service.map_or(Err(ControlErrorCode::InvalidActivation), |service| {
            service.activate(intent)
        })
    }

    fn begin_product_quit(&self) -> QuitAdmission {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let status = self.status();
        match status {
            RuntimeStatus::Exiting => return QuitAdmission::AlreadyAccepted,
            RuntimeStatus::Replacing => return QuitAdmission::UpdateWon,
            RuntimeStatus::Starting | RuntimeStatus::Ready => {}
        }
        *lifecycle = Some(LifecycleTransition::Exiting);
        self.accepting_connections.store(false, Ordering::Release);
        self.lock_inner().status = RuntimeStatus::Exiting;
        QuitAdmission::Started
    }

    fn finish_product_quit(&self) {
        self.broadcast_event_with_flush_budget(
            &ControlEvent::ProductExiting,
            Duration::from_millis(250),
        );
        let _ = self.shutdown_sender.try_send(RuntimeShutdown::ProductQuit);
    }

    fn register_connection(
        self: &Arc<Self>,
        sender: &ControlSender,
        role: ClientRole,
    ) -> Result<ConnectionLease, ControlServerError> {
        if !self.accepting_connections.load(Ordering::Acquire) {
            sender
                .send(ServerMessage::handshake_rejected(
                    HandshakeRejection::RuntimeStopping,
                ))
                .map_err(ControlServerError::Outbound)?;
            return Err(ControlServerError::RuntimeStopping);
        }
        let connection_id = ConnectionId::new();
        let mut inner = self.lock_inner();
        inner.connections.insert(
            connection_id.clone(),
            ConnectionRecord {
                role,
                desktop_host: false,
                sender: sender.clone(),
                cli_authorizations: Vec::new(),
            },
        );
        if let Err(error) = sender.send(ServerMessage::handshake_accepted(
            &inner.instance_id,
            inner.status,
        )) {
            inner.connections.remove(&connection_id);
            return Err(ControlServerError::Outbound(error));
        }
        Ok(ConnectionLease {
            state: Arc::clone(self),
            connection_id,
        })
    }

    fn response_for(
        &self,
        connection_id: &ConnectionId,
        request: &ControlRequest,
    ) -> ControlResponse {
        let role = self
            .lock_inner()
            .connections
            .get(connection_id)
            .map(|connection| connection.role);
        let Some(role) = role else {
            return ControlResponse::Rejected {
                code: ControlErrorCode::RoleDenied,
            };
        };
        if authorize_request(role, request).is_err() {
            return ControlResponse::Rejected {
                code: ControlErrorCode::RoleDenied,
            };
        }
        if matches!(request, ControlRequest::Inspect) {
            let inner = self.lock_inner();
            return ControlResponse::Inspection {
                instance_id: inner.instance_id.clone(),
                status: inner.status,
                executable_identity: inner.executable_identity.clone(),
            };
        }
        let status = self.status();
        if status != RuntimeStatus::Ready {
            return ControlResponse::Rejected {
                code: match status {
                    RuntimeStatus::Starting => ControlErrorCode::RuntimeStarting,
                    RuntimeStatus::Exiting => ControlErrorCode::RuntimeExiting,
                    RuntimeStatus::Replacing => ControlErrorCode::UpdateCommitInProgress,
                    RuntimeStatus::Ready => unreachable!("Ready was checked"),
                },
            };
        }
        self.ready_response_for(connection_id, request)
    }

    fn ready_response_for(
        &self,
        connection_id: &ConnectionId,
        request: &ControlRequest,
    ) -> ControlResponse {
        match request {
            ControlRequest::Activate { intent } => {
                self.activate_for_connection(connection_id, intent)
            }
            ControlRequest::CreateCliAuthorization => {
                let mut inner = self.lock_inner();
                let Some(workbench) = inner.workbench.as_ref() else {
                    return ControlResponse::Rejected {
                        code: ControlErrorCode::RuntimeStarting,
                    };
                };
                let origin = workbench.origin().to_owned();
                let authorization = CliAuthorization::new();
                inner
                    .cli_authorizations
                    .insert(authorization.clone(), connection_id.clone());
                if let Some(connection) = inner.connections.get_mut(connection_id) {
                    connection.cli_authorizations.push(authorization.clone());
                }
                ControlResponse::CliAuthorization {
                    origin,
                    authorization: authorization.into_wire_value(),
                }
            }
            ControlRequest::RegisterDevWorkbenchOrigin { origin } => {
                let inner = self.lock_inner();
                let Some(workbench) = inner.workbench.clone() else {
                    return ControlResponse::Rejected {
                        code: ControlErrorCode::RuntimeStarting,
                    };
                };
                let runtime_origin = workbench.origin().to_owned();
                drop(inner);
                match workbench.register_source_workbench(&connection_id.0, origin) {
                    Ok(()) => ControlResponse::DevWorkbenchOriginRegistered { runtime_origin },
                    Err(SourceWorkbenchRegistrationError::InvalidOrigin) => {
                        ControlResponse::Rejected {
                            code: ControlErrorCode::InvalidDevWorkbenchOrigin,
                        }
                    }
                    Err(SourceWorkbenchRegistrationError::AlreadyRegistered) => {
                        ControlResponse::Rejected {
                            code: ControlErrorCode::DevWorkbenchOriginAlreadyRegistered,
                        }
                    }
                }
            }
            ControlRequest::CreateDesktopLaunchTicket { window_key } => {
                let inner = self.lock_inner();
                let Some(connection) = inner.connections.get(connection_id) else {
                    return ControlResponse::Rejected {
                        code: ControlErrorCode::RoleDenied,
                    };
                };
                if !connection.desktop_host {
                    return ControlResponse::Rejected {
                        code: ControlErrorCode::RoleDenied,
                    };
                }
                let Some(workbench) = inner.workbench.clone() else {
                    return ControlResponse::Rejected {
                        code: ControlErrorCode::RuntimeStarting,
                    };
                };
                drop(inner);
                match self
                    .desktop
                    .create_launch_ticket(&connection_id.0, window_key, &workbench)
                {
                    Ok((ticket, url)) => ControlResponse::DesktopLaunchTicket { ticket, url },
                    Err(_) => ControlResponse::Rejected {
                        code: ControlErrorCode::InvalidDesktopWindow,
                    },
                }
            }
            ControlRequest::DesktopWindowClosed { window_key } => {
                let workbench = self.lock_inner().workbench.clone();
                if self
                    .desktop
                    .close_window(&connection_id.0, window_key, workbench.as_deref())
                {
                    ControlResponse::Ok
                } else {
                    ControlResponse::Rejected {
                        code: ControlErrorCode::InvalidDesktopWindow,
                    }
                }
            }
            ControlRequest::Inspect | ControlRequest::QuitProduct => {
                unreachable!("request was dispatched earlier")
            }
        }
    }

    fn activate_for_connection(
        &self,
        connection_id: &ConnectionId,
        intent: &ActivationIntent,
    ) -> ControlResponse {
        let launcher_desktop = self
            .lock_inner()
            .connections
            .get(connection_id)
            .is_some_and(|connection| {
                connection.role == ClientRole::Launcher
                    && activation_targets_desktop(intent)
                    && !connection.desktop_host
            });
        if launcher_desktop {
            if self.desktop.has_host() {
                return match self.activate_intent(intent) {
                    Ok(_) => ControlResponse::Activation {
                        outcome: ActivationOutcome::HandledByExistingDesktop,
                    },
                    Err(code) => ControlResponse::Rejected { code },
                };
            }
            let sender = self
                .lock_inner()
                .connections
                .get(connection_id)
                .map(|connection| connection.sender.clone());
            let Some(sender) = sender else {
                return ControlResponse::Rejected {
                    code: ControlErrorCode::RoleDenied,
                };
            };
            if let Err(DesktopHostRegistrationError::AlreadyConnected) = self
                .desktop
                .promote_host(connection_id.0.clone(), sender.clone())
            {
                return ControlResponse::Rejected {
                    code: ControlErrorCode::DesktopUnavailable,
                };
            }
            let (revision, projects) = {
                let mut inner = self.lock_inner();
                if let Some(connection) = inner.connections.get_mut(connection_id) {
                    connection.desktop_host = true;
                }
                (
                    inner.recent_projects_revision,
                    inner.recent_projects.clone(),
                )
            };
            let _ = sender.send(ServerMessage::event(
                ControlEvent::DesktopRecentProjectsChanged {
                    global_revision: revision,
                    recent_projects: projects,
                },
            ));
            return match self.activate_intent(intent) {
                Ok(_) => ControlResponse::Activation {
                    outcome: ActivationOutcome::PromotedToDesktopHost,
                },
                Err(code) => {
                    self.desktop
                        .unregister_host(&connection_id.0, self.lock_inner().workbench.as_deref());
                    if let Some(connection) = self.lock_inner().connections.get_mut(connection_id) {
                        connection.desktop_host = false;
                    }
                    ControlResponse::Rejected { code }
                }
            };
        }
        match self.activate_intent(intent) {
            Ok(outcome) => ControlResponse::Activation { outcome },
            Err(code) => ControlResponse::Rejected { code },
        }
    }

    fn unregister_connection(&self, connection_id: &ConnectionId) {
        let mut inner = self.lock_inner();
        if let Some(connection) = inner.connections.remove(connection_id) {
            for authorization in connection.cli_authorizations {
                inner.cli_authorizations.remove(&authorization);
            }
        }
        let workbench = inner.workbench.clone();
        drop(inner);
        if let Some(workbench) = workbench.as_deref() {
            workbench.unregister_source_workbench(&connection_id.0);
        }
        self.desktop
            .unregister_host(&connection_id.0, workbench.as_deref());
    }

    fn broadcast_event_with_flush_budget(&self, event: &ControlEvent, budget: Duration) {
        let senders = self
            .lock_inner()
            .connections
            .values()
            .map(|connection| connection.sender.clone())
            .collect::<Vec<_>>();
        let receipts = senders
            .iter()
            .filter_map(|sender| {
                sender
                    .send_with_flush_receipt(ServerMessage::event(event.clone()))
                    .ok()
                    .map(|receipt| (sender, receipt))
            })
            .collect::<Vec<_>>();
        let deadline = Instant::now() + budget;
        for (sender, receipt) in receipts {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                sender.close();
                continue;
            };
            if receipt.recv_timeout(remaining).is_err() {
                sender.close();
            }
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, RuntimeControlInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn activation_targets_desktop(intent: &ActivationIntent) -> bool {
    matches!(
        intent,
        ActivationIntent::OpenDesktop
            | ActivationIntent::OpenProject {
                frontend: super::ProjectFrontend::Desktop,
                ..
            }
            | ActivationIntent::OpenKnownProject {
                frontend: super::ProjectFrontend::Desktop,
                ..
            }
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuitAdmission {
    Started,
    AlreadyAccepted,
    UpdateWon,
}

struct ConnectionLease {
    state: Arc<RuntimeControlState>,
    connection_id: ConnectionId,
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        self.state.unregister_connection(&self.connection_id);
    }
}

impl ConnectionId {
    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl CliAuthorization {
    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    fn into_wire_value(self) -> String {
        self.0
    }
}

impl CliAuthorizationVerifier for RuntimeControlState {
    fn is_cli_authorized(&self, authorization: &str) -> bool {
        RuntimeControlState::is_cli_authorized(self, authorization)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchInstallError {
    AlreadyInstalled,
}

impl fmt::Display for WorkbenchInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyInstalled => formatter.write_str("Workbench service is already installed"),
        }
    }
}

impl Error for WorkbenchInstallError {}

impl fmt::Display for DesktopPresentationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RevisionExhausted => formatter.write_str("Global revision is exhausted"),
            Self::Outbound(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for DesktopPresentationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Outbound(error) => Some(error),
            Self::RevisionExhausted => None,
        }
    }
}

impl fmt::Display for RuntimeActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RuntimeNotReady { status } => {
                write!(
                    formatter,
                    "Runtime cannot perform the action while {status:?}"
                )
            }
            Self::WorkbenchUnavailable => formatter.write_str("Workbench service is unavailable"),
            Self::WorkbenchLaunch(error) => write!(formatter, "Workbench route failed: {error}"),
        }
    }
}

impl Error for RuntimeActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::WorkbenchLaunch(error) => Some(error),
            Self::RuntimeNotReady { .. } | Self::WorkbenchUnavailable => None,
        }
    }
}

pub trait ControlTransport: Read + Write + Send + Sync + 'static {
    /// Removes the initial bounded handshake I/O settings.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when transport configuration fails.
    fn clear_handshake_timeouts(&mut self) -> io::Result<()>;

    /// Clones the same native connection for the serialized writer or closer.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when a second handle cannot be made.
    fn try_clone_transport(&self) -> io::Result<Self>
    where
        Self: Sized;
    fn shutdown_transport(&self);
}

#[cfg(target_os = "macos")]
impl ControlTransport for UnixStream {
    fn clear_handshake_timeouts(&mut self) -> io::Result<()> {
        self.set_read_timeout(None)?;
        self.set_write_timeout(None)
    }

    fn try_clone_transport(&self) -> io::Result<Self> {
        self.try_clone()
    }

    fn shutdown_transport(&self) {
        let _ = self.shutdown(Shutdown::Both);
    }
}

#[cfg(target_os = "windows")]
impl ControlTransport for WindowsControlConnection {
    fn clear_handshake_timeouts(&mut self) -> io::Result<()> {
        self.set_read_timeout(None);
        Ok(())
    }

    fn try_clone_transport(&self) -> io::Result<Self> {
        self.try_clone()
    }

    fn shutdown_transport(&self) {
        self.shutdown();
    }
}

/// Serves one kernel-authorized Control connection until either peer closes it.
///
/// # Errors
///
/// Returns [`ControlServerError`] for handshake, framing, or delivery failure.
pub fn serve_control_connection<Stream: ControlTransport>(
    mut stream: Stream,
    state: &Arc<RuntimeControlState>,
    outbound_queue_capacity: usize,
) -> Result<(), ControlServerError> {
    let role = read_handshake_request(&mut stream).map_err(ControlServerError::Handshake)?;
    stream
        .clear_handshake_timeouts()
        .map_err(ControlServerError::Io)?;
    let writer_stream = stream
        .try_clone_transport()
        .map_err(ControlServerError::Io)?;
    let closer = stream
        .try_clone_transport()
        .map_err(ControlServerError::Io)?;
    let sender = start_serialized_writer(writer_stream, outbound_queue_capacity, move || {
        closer.shutdown_transport();
    });
    let connection = state.register_connection(&sender, role)?;

    loop {
        match read_frame(&mut stream) {
            Ok(ClientMessage::Request {
                request_id,
                request: ControlRequest::QuitProduct,
            }) => {
                let admission = state.begin_product_quit();
                let response = match admission {
                    QuitAdmission::Started | QuitAdmission::AlreadyAccepted => ControlResponse::Ok,
                    QuitAdmission::UpdateWon => ControlResponse::Rejected {
                        code: ControlErrorCode::UpdateCommitInProgress,
                    },
                };
                sender
                    .send(ServerMessage::response(request_id, response))
                    .map_err(ControlServerError::Outbound)?;
                if admission == QuitAdmission::Started {
                    state.finish_product_quit();
                }
            }
            Ok(ClientMessage::Request {
                request_id,
                request,
            }) => {
                let response = state.response_for(&connection.connection_id, &request);
                sender
                    .send(ServerMessage::response(request_id, response))
                    .map_err(ControlServerError::Outbound)?;
            }
            Ok(ClientMessage::Handshake { .. }) => {
                return Err(ControlServerError::UnexpectedHandshake);
            }
            Err(error) if is_connection_closed(&error) => return Ok(()),
            Err(error) => return Err(ControlServerError::Decode(error)),
        }
    }
}

#[derive(Debug)]
pub enum ControlServerError {
    Io(io::Error),
    Handshake(ServerHandshakeError),
    Decode(FrameDecodeError),
    Outbound(OutboundError),
    UnexpectedHandshake,
    RuntimeStopping,
}

impl fmt::Display for ControlServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Control connection failed: {error}"),
            Self::Handshake(error) => write!(formatter, "{error}"),
            Self::Decode(error) => write!(formatter, "Control request is invalid: {error}"),
            Self::Outbound(error) => write!(formatter, "{error}"),
            Self::UnexpectedHandshake => {
                formatter.write_str("Control peer repeated the mandatory handshake")
            }
            Self::RuntimeStopping => formatter.write_str("Runtime is stopping"),
        }
    }
}

impl Error for ControlServerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Handshake(error) => Some(error),
            Self::Decode(error) => Some(error),
            Self::Outbound(error) => Some(error),
            Self::UnexpectedHandshake | Self::RuntimeStopping => None,
        }
    }
}
