use std::{
    collections::HashMap,
    error::Error,
    fmt,
    io::{self, Read, Write},
    sync::{Arc, Condvar, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard},
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
    ControlRequest, ControlResponse, DesktopOpenError, FrameDecodeError, HandshakeRejection,
    RuntimeStatus, ServerHandshakeError, ServerMessage, WorkbenchRoute, authorize_request,
    desktop::{DesktopHostRegistrationError, DesktopWindowTopology},
    frame::is_connection_closed,
    handshake::read_handshake_request,
    read_frame,
    writer::{ControlSender, OutboundError, start_serialized_writer},
};

pub struct RuntimeControlState {
    inner: Mutex<RuntimeControlInner>,
    desktop: DesktopWindowTopology,
    lifecycle: Mutex<RuntimeLifecycle>,
    product_transition: RwLock<()>,
    active_product_work: Mutex<usize>,
    product_work_drained: Condvar,
    activation_service: Mutex<Option<Arc<dyn RuntimeActivationService>>>,
    removal_service: Mutex<Option<Arc<dyn RuntimeProductRemovalService>>>,
}

pub struct RuntimeWorkPermit {
    state: Arc<RuntimeControlState>,
}

pub struct ProductUpdateTransitionFailure {
    pub message: String,
    pub reversible: bool,
}

pub struct ProductRemovalCommit {
    launch: Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

impl ProductRemovalCommit {
    #[must_use]
    pub fn new(
        launch: impl FnOnce() -> Result<(), String> + Send + 'static,
        cancel: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self {
            launch: Some(Box::new(launch)),
            cancel: Some(Box::new(cancel)),
        }
    }

    fn launch(mut self) -> Result<(), String> {
        self.cancel.take();
        self.launch.take().expect("removal launch is one-shot")()
    }

    fn cancel(mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
    }
}

pub trait RuntimeProductRemovalService: Send + Sync {
    /// Prepares one exact Product removal without changing Runtime lifecycle.
    ///
    /// # Errors
    ///
    /// Returns a typed rejection when the installed Product cannot be validated
    /// and staged for detached removal.
    fn prepare_removal(&self, keep_config: bool) -> Result<ProductRemovalCommit, ControlErrorCode>;
}

impl ProductUpdateTransitionFailure {
    #[must_use]
    pub fn preparing(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reversible: true,
        }
    }

    #[must_use]
    pub fn committing(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reversible: false,
        }
    }
}

pub trait RuntimeActivationService: Send + Sync {
    /// Executes one authorized activation exactly once.
    ///
    /// # Errors
    ///
    /// Returns a typed Control rejection when the frontend cannot be activated.
    fn activate(
        &self,
        intent: &ActivationIntent,
        preferred_desktop_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ControlErrorCode>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeLifecycle {
    Starting,
    Ready,
    UpdatePreparing(String),
    Exiting,
    Replacing(String),
    RemovalPreparing,
    Removing,
}

struct RuntimeControlInner {
    instance_id: String,
    executable_identity: Option<String>,
    workbench: Option<Arc<WorkbenchLaunchService>>,
    recent_projects_revision: Option<u64>,
    recent_project_roots: Vec<String>,
    theme_preference: Option<String>,
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
pub enum RuntimeActionError {
    RuntimeNotReady { status: RuntimeStatus },
    WorkbenchUnavailable,
    WorkbenchLaunch(WorkbenchLaunchError),
}

impl RuntimeControlState {
    #[must_use]
    pub fn new(instance_id: impl Into<String>) -> Self {
        Self::new_with_executable_identity(instance_id, None)
    }

    #[must_use]
    pub fn new_with_executable_identity(
        instance_id: impl Into<String>,
        executable_identity: Option<String>,
    ) -> Self {
        Self {
            inner: Mutex::new(RuntimeControlInner {
                instance_id: instance_id.into(),
                executable_identity,
                workbench: None,
                recent_projects_revision: None,
                recent_project_roots: Vec::new(),
                theme_preference: None,
                connections: HashMap::new(),
                cli_authorizations: HashMap::new(),
            }),
            desktop: DesktopWindowTopology::new(),
            lifecycle: Mutex::new(RuntimeLifecycle::Starting),
            product_transition: RwLock::new(()),
            active_product_work: Mutex::new(0),
            product_work_drained: Condvar::new(),
            activation_service: Mutex::new(None),
            removal_service: Mutex::new(None),
        }
    }

    #[must_use]
    pub fn status(&self) -> RuntimeStatus {
        self.lock_lifecycle().status()
    }

    #[must_use]
    pub fn instance_id(&self) -> String {
        self.lock_inner().instance_id.clone()
    }

    pub fn finish_startup(&self) -> bool {
        let mut lifecycle = self.lock_lifecycle();
        if *lifecycle != RuntimeLifecycle::Starting {
            return false;
        }
        *lifecycle = RuntimeLifecycle::Ready;
        true
    }

    #[must_use]
    pub fn is_stopping(&self) -> bool {
        matches!(
            *self.lock_lifecycle(),
            RuntimeLifecycle::Exiting | RuntimeLifecycle::Replacing(_) | RuntimeLifecycle::Removing
        )
    }

    #[must_use]
    /// Admits one unit of Product work only while Runtime has full Ready admission.
    ///
    /// # Panics
    ///
    /// Panics if an authoritative lock is poisoned or the active-work counter overflows.
    pub fn begin_product_work(self: &Arc<Self>) -> Option<RuntimeWorkPermit> {
        let lifecycle = self.lock_lifecycle();
        if *lifecycle != RuntimeLifecycle::Ready {
            return None;
        }
        let mut active = self
            .active_product_work
            .lock()
            .expect("Runtime product-work lock poisoned");
        *active = active
            .checked_add(1)
            .expect("active Runtime product-work count overflow");
        drop(active);
        drop(lifecycle);
        Some(RuntimeWorkPermit {
            state: Arc::clone(self),
        })
    }

    /// Replaces the Desktop recent-Project projection when the revision advances.
    pub fn set_recent_projects(&self, global_revision: u64, recent_project_roots: Vec<String>) {
        let mut inner = self.lock_inner();
        if inner
            .recent_projects_revision
            .is_some_and(|current_revision| global_revision <= current_revision)
        {
            return;
        }
        inner.recent_projects_revision = Some(global_revision);
        inner.recent_project_roots = recent_project_roots;
        let event = ControlEvent::DesktopRecentProjectsChanged {
            global_revision,
            recent_project_roots: inner.recent_project_roots.clone(),
        };
        // Queue projection events under the same lock that advances the revision. This makes
        // concurrent updates and Desktop promotion observe one monotonic enqueue order.
        for connection in inner
            .connections
            .values()
            .filter(|connection| connection.desktop_host)
        {
            let _ = connection.sender.send(ServerMessage::event(event.clone()));
        }
    }

    /// Returns the current ordered recent-Project projection when its Global revision changed.
    #[must_use]
    pub fn recent_projects_projection_after(
        &self,
        known_revision: Option<u64>,
    ) -> Option<(u64, Vec<String>)> {
        let inner = self.lock_inner();
        let revision = inner.recent_projects_revision?;
        (known_revision != Some(revision)).then(|| (revision, inner.recent_project_roots.clone()))
    }

    pub fn set_theme_preference(&self, theme_preference: &str) {
        self.lock_inner().theme_preference = Some(theme_preference.to_owned());
    }

    pub fn install_activation_service(&self, service: Arc<dyn RuntimeActivationService>) -> bool {
        let mut current = self.lock_activation_service();
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

    /// Opens one ordinary Desktop window through the current promoted host.
    ///
    /// # Errors
    ///
    /// Returns [`DesktopOpenError`] if Runtime is not Ready or no host can receive it.
    pub fn open_desktop_window(&self) -> Result<(), DesktopOpenError> {
        if self.status() != RuntimeStatus::Ready {
            return Err(DesktopOpenError::HostUnavailable);
        }
        self.desktop.open()
    }

    /// Sends one raw Project-open request to the promoted Desktop host.
    ///
    /// # Errors
    ///
    /// Returns [`DesktopOpenError`] if Runtime is not Ready or the host cannot
    /// receive the request.
    pub fn request_desktop_project_open(
        &self,
        project_root: &str,
        preferred_window_key: Option<&str>,
    ) -> Result<(), DesktopOpenError> {
        if self.status() != RuntimeStatus::Ready {
            return Err(DesktopOpenError::HostUnavailable);
        }
        self.desktop
            .request_project_open(project_root, preferred_window_key)
    }

    #[must_use]
    pub fn has_desktop_host(&self) -> bool {
        self.desktop.has_host()
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
        let status = self.status();
        if status != RuntimeStatus::Ready {
            return Err(RuntimeActionError::RuntimeNotReady { status });
        }
        let inner = self.lock_inner();
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
        on_accepted: Box<dyn FnOnce() + Send>,
        commit: Box<dyn FnOnce() -> Result<(), ProductUpdateTransitionFailure> + Send>,
        on_cancel: Box<dyn FnOnce(&str) + Send>,
    ) -> bool {
        let mut lifecycle = self.lock_lifecycle();
        if *lifecycle != RuntimeLifecycle::Ready || Uuid::parse_str(transaction_id).is_err() {
            return false;
        }
        *lifecycle = RuntimeLifecycle::UpdatePreparing(transaction_id.to_owned());
        drop(lifecycle);
        on_accepted();
        let state = Arc::clone(self);
        let transaction_id = transaction_id.to_owned();
        if thread::Builder::new()
            .name("debrute-product-update".to_owned())
            .spawn(move || {
                let transition_guard = state.lock_product_transition();
                state.wait_for_product_work_to_drain();
                let lifecycle = state.lock_lifecycle();
                if !matches!(
                    &*lifecycle,
                    RuntimeLifecycle::UpdatePreparing(current) if current == &transaction_id
                ) {
                    drop(lifecycle);
                    drop(transition_guard);
                    on_cancel("Product Quit won before the update commit boundary.");
                    return;
                }
                drop(lifecycle);
                if let Err(error) = commit() {
                    let mut lifecycle = state.lock_lifecycle();
                    *lifecycle = if error.reversible {
                        RuntimeLifecycle::Ready
                    } else {
                        RuntimeLifecycle::Replacing(transaction_id.clone())
                    };
                    drop(lifecycle);
                    drop(transition_guard);
                    on_cancel(&error.message);
                    if !error.reversible {
                        state.broadcast_event_with_flush_budget(
                            &ControlEvent::ProductReplacing,
                            Duration::from_millis(250),
                        );
                    }
                    return;
                }
                let mut lifecycle = state.lock_lifecycle();
                *lifecycle = RuntimeLifecycle::Replacing(transaction_id);
                drop(lifecycle);
                drop(transition_guard);
                state.broadcast_event_with_flush_budget(
                    &ControlEvent::ProductReplacing,
                    Duration::from_millis(250),
                );
            })
            .is_err()
        {
            let mut lifecycle = self.lock_lifecycle();
            *lifecycle = RuntimeLifecycle::Ready;
            return false;
        }
        true
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
            QuitAdmission::RemovalWon => Err(ControlErrorCode::RemovalInProgress),
        }
    }

    /// Commits one prepared whole-Product removal and drains existing work before exit.
    ///
    /// # Errors
    ///
    /// Returns `update_commit_in_progress` or `removal_in_progress` when another
    /// irreversible Product transition owns the lifecycle, or
    /// `product_removal_unavailable` when the drain executor or detached finalizer cannot start.
    pub fn request_product_removal(
        self: &Arc<Self>,
        commit: ProductRemovalCommit,
    ) -> Result<(), ControlErrorCode> {
        let transition = self.lock_product_transition();
        let mut lifecycle = self.lock_lifecycle();
        match &*lifecycle {
            RuntimeLifecycle::Ready => {}
            RuntimeLifecycle::UpdatePreparing(_) | RuntimeLifecycle::Replacing(_) => {
                drop(lifecycle);
                drop(transition);
                commit.cancel();
                return Err(ControlErrorCode::UpdateCommitInProgress);
            }
            RuntimeLifecycle::RemovalPreparing | RuntimeLifecycle::Removing => {
                drop(lifecycle);
                drop(transition);
                commit.cancel();
                return Err(ControlErrorCode::RemovalInProgress);
            }
            RuntimeLifecycle::Starting | RuntimeLifecycle::Exiting => {
                drop(lifecycle);
                drop(transition);
                commit.cancel();
                return Err(ControlErrorCode::RuntimeExiting);
            }
        }
        let (drain_sender, drain_receiver) = std::sync::mpsc::channel();
        let state = Arc::clone(self);
        if thread::Builder::new()
            .name("debrute-product-removal".to_owned())
            .spawn(move || {
                if drain_receiver.recv().is_err() {
                    return;
                }
                let _transition = state.lock_product_transition();
                state.wait_for_product_work_to_drain();
                let mut lifecycle = state.lock_lifecycle();
                if *lifecycle != RuntimeLifecycle::RemovalPreparing {
                    return;
                }
                *lifecycle = RuntimeLifecycle::Removing;
                drop(lifecycle);
                state.broadcast_event_with_flush_budget(
                    &ControlEvent::ProductRemoving,
                    Duration::from_millis(250),
                );
            })
            .is_err()
        {
            drop(lifecycle);
            drop(transition);
            commit.cancel();
            return Err(ControlErrorCode::ProductRemovalUnavailable);
        }
        if commit.launch().is_err() {
            drop(lifecycle);
            drop(transition);
            return Err(ControlErrorCode::ProductRemovalUnavailable);
        }
        *lifecycle = RuntimeLifecycle::RemovalPreparing;
        drop(lifecycle);
        drop(transition);
        drain_sender
            .send(())
            .expect("prepared Product-removal drain thread must await its commit signal");
        Ok(())
    }

    /// Installs the one Product-removal preparation service.
    #[must_use]
    pub fn install_product_removal_service(
        &self,
        service: Arc<dyn RuntimeProductRemovalService>,
    ) -> bool {
        let mut current = self
            .removal_service
            .lock()
            .expect("Runtime removal-service lock poisoned");
        if current.is_some() {
            return false;
        }
        *current = Some(service);
        true
    }

    /// Prepares and commits removal through the installed Runtime service.
    ///
    /// # Errors
    ///
    /// Returns a typed Product transition rejection.
    pub fn remove_product(self: &Arc<Self>, keep_config: bool) -> Result<(), ControlErrorCode> {
        let service = self
            .removal_service
            .lock()
            .expect("Runtime removal-service lock poisoned")
            .clone()
            .ok_or(ControlErrorCode::ProductRemovalUnavailable)?;
        let commit = service.prepare_removal(keep_config)?;
        self.request_product_removal(commit)
    }

    /// Executes one Ready activation through the installed platform adapter.
    ///
    /// # Errors
    ///
    /// Returns a typed Control rejection when activation cannot be completed.
    pub fn activate_intent(
        &self,
        intent: &ActivationIntent,
        preferred_desktop_window_key: Option<&str>,
    ) -> Result<ActivationOutcome, ControlErrorCode> {
        let _transition = self.read_product_transition();
        match &*self.lock_lifecycle() {
            RuntimeLifecycle::Starting => {
                return Err(ControlErrorCode::RuntimeStarting);
            }
            RuntimeLifecycle::Exiting => return Err(ControlErrorCode::RuntimeExiting),
            RuntimeLifecycle::UpdatePreparing(_) | RuntimeLifecycle::Replacing(_) => {
                return Err(ControlErrorCode::UpdateCommitInProgress);
            }
            RuntimeLifecycle::RemovalPreparing | RuntimeLifecycle::Removing => {
                return Err(ControlErrorCode::RemovalInProgress);
            }
            RuntimeLifecycle::Ready => {}
        }
        if matches!(intent, ActivationIntent::EnsureRuntime) {
            return Ok(ActivationOutcome::Ensured);
        }
        let service = self.lock_activation_service().clone();
        service.map_or(Err(ControlErrorCode::InvalidActivation), |service| {
            service.activate(intent, preferred_desktop_window_key)
        })
    }

    fn begin_product_quit(&self) -> QuitAdmission {
        let _transition = self.lock_product_transition();
        let mut lifecycle = self.lock_lifecycle();
        match &*lifecycle {
            RuntimeLifecycle::Exiting => return QuitAdmission::AlreadyAccepted,
            RuntimeLifecycle::UpdatePreparing(_) | RuntimeLifecycle::Replacing(_) => {
                return QuitAdmission::UpdateWon;
            }
            RuntimeLifecycle::RemovalPreparing | RuntimeLifecycle::Removing => {
                return QuitAdmission::RemovalWon;
            }
            RuntimeLifecycle::Starting | RuntimeLifecycle::Ready => {}
        }
        *lifecycle = RuntimeLifecycle::Exiting;
        QuitAdmission::Started
    }

    fn finish_product_quit(&self) {
        self.broadcast_event_with_flush_budget(
            &ControlEvent::ProductExiting,
            Duration::from_millis(250),
        );
    }

    fn register_connection(
        self: &Arc<Self>,
        sender: &ControlSender,
        role: ClientRole,
    ) -> Result<ConnectionLease, ControlServerError> {
        let lifecycle = self.lock_lifecycle();
        let status = lifecycle.status();
        if matches!(
            status,
            RuntimeStatus::Exiting | RuntimeStatus::Replacing | RuntimeStatus::Removing
        ) {
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
            status,
        )) {
            inner.connections.remove(&connection_id);
            return Err(ControlServerError::Outbound(error));
        }
        drop(inner);
        drop(lifecycle);
        Ok(ConnectionLease {
            state: Arc::clone(self),
            connection_id,
        })
    }

    fn response_for(
        self: &Arc<Self>,
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
            let status = self.status();
            let inner = self.lock_inner();
            return ControlResponse::Inspection {
                instance_id: inner.instance_id.clone(),
                status,
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
                    RuntimeStatus::RemovalPreparing | RuntimeStatus::Removing => {
                        ControlErrorCode::RemovalInProgress
                    }
                    RuntimeStatus::Ready => unreachable!("Ready was checked"),
                },
            };
        }
        self.ready_response_for(connection_id, request)
    }

    fn ready_response_for(
        self: &Arc<Self>,
        connection_id: &ConnectionId,
        request: &ControlRequest,
    ) -> ControlResponse {
        match request {
            ControlRequest::Activate {
                intent,
                preferred_desktop_window_key,
            } => self.activate_for_connection(
                connection_id,
                intent,
                preferred_desktop_window_key.as_deref(),
            ),
            ControlRequest::ResolveWorkbenchRootUrl => {
                match self.workbench_url(&WorkbenchRoute::Root) {
                    Ok(url) => ControlResponse::WorkbenchRootUrl { url },
                    Err(
                        RuntimeActionError::RuntimeNotReady { .. }
                        | RuntimeActionError::WorkbenchUnavailable,
                    ) => ControlResponse::Rejected {
                        code: ControlErrorCode::RuntimeStarting,
                    },
                    Err(RuntimeActionError::WorkbenchLaunch(_)) => ControlResponse::Rejected {
                        code: ControlErrorCode::InvalidRoute,
                    },
                }
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
                self.desktop_launch_ticket_response(connection_id, window_key)
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
            ControlRequest::RemoveProduct { keep_config } => {
                match self.remove_product(*keep_config) {
                    Ok(()) => ControlResponse::ProductRemovalAccepted {
                        config_preserved: *keep_config,
                    },
                    Err(code) => ControlResponse::Rejected { code },
                }
            }
            ControlRequest::Inspect | ControlRequest::QuitProduct => {
                unreachable!("request was dispatched earlier")
            }
        }
    }

    fn desktop_launch_ticket_response(
        &self,
        connection_id: &ConnectionId,
        window_key: &str,
    ) -> ControlResponse {
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
        let Some(theme_preference) = inner.theme_preference.clone() else {
            return ControlResponse::Rejected {
                code: ControlErrorCode::DesktopUnavailable,
            };
        };
        drop(inner);
        match self
            .desktop
            .create_launch_ticket(&connection_id.0, window_key, &workbench)
        {
            Ok((ticket, url)) => ControlResponse::DesktopLaunchTicket {
                ticket,
                url,
                theme_preference,
            },
            Err(_) => ControlResponse::Rejected {
                code: ControlErrorCode::InvalidDesktopWindow,
            },
        }
    }

    fn activate_for_connection(
        &self,
        connection_id: &ConnectionId,
        intent: &ActivationIntent,
        preferred_desktop_window_key: Option<&str>,
    ) -> ControlResponse {
        if preferred_desktop_window_key.is_some() && !activation_targets_desktop(intent) {
            return ControlResponse::Rejected {
                code: ControlErrorCode::InvalidActivation,
            };
        }
        if let Some(window_key) = preferred_desktop_window_key
            && !self.desktop.owns_window(&connection_id.0, window_key)
        {
            return ControlResponse::Rejected {
                code: ControlErrorCode::InvalidDesktopWindow,
            };
        }
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
                return match self.activate_intent(intent, None) {
                    Ok(_) => ControlResponse::Activation {
                        outcome: ActivationOutcome::HandledByExistingDesktop,
                    },
                    Err(failure) => activation_failure_response(failure),
                };
            }
            let mut inner = self.lock_inner();
            let Some(revision) = inner.recent_projects_revision else {
                return ControlResponse::Rejected {
                    code: ControlErrorCode::DesktopUnavailable,
                };
            };
            let Some(sender) = inner
                .connections
                .get(connection_id)
                .map(|connection| connection.sender.clone())
            else {
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
            inner
                .connections
                .get_mut(connection_id)
                .expect("The promoting connection remains registered for its request")
                .desktop_host = true;
            let _ = sender.send(ServerMessage::event(
                ControlEvent::DesktopRecentProjectsChanged {
                    global_revision: revision,
                    recent_project_roots: inner.recent_project_roots.clone(),
                },
            ));
            drop(inner);
            return match self.activate_intent(intent, None) {
                Ok(_) => ControlResponse::Activation {
                    outcome: ActivationOutcome::PromotedToDesktopHost,
                },
                Err(failure) => {
                    self.desktop
                        .unregister_host(&connection_id.0, self.lock_inner().workbench.as_deref());
                    if let Some(connection) = self.lock_inner().connections.get_mut(connection_id) {
                        connection.desktop_host = false;
                    }
                    activation_failure_response(failure)
                }
            };
        }
        match self.activate_intent(intent, preferred_desktop_window_key) {
            Ok(outcome) => ControlResponse::Activation { outcome },
            Err(failure) => activation_failure_response(failure),
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
        self.inner
            .lock()
            .expect("Runtime Control state lock poisoned")
    }

    fn lock_lifecycle(&self) -> MutexGuard<'_, RuntimeLifecycle> {
        self.lifecycle
            .lock()
            .expect("Runtime lifecycle lock poisoned")
    }

    fn read_product_transition(&self) -> RwLockReadGuard<'_, ()> {
        self.product_transition
            .read()
            .expect("Product transition lock poisoned")
    }

    fn lock_product_transition(&self) -> RwLockWriteGuard<'_, ()> {
        self.product_transition
            .write()
            .expect("Product transition lock poisoned")
    }

    fn wait_for_product_work_to_drain(&self) {
        let mut active = self
            .active_product_work
            .lock()
            .expect("Runtime product-work lock poisoned");
        while *active != 0 {
            active = self
                .product_work_drained
                .wait(active)
                .expect("Runtime product-work drain lock poisoned");
        }
    }

    fn lock_activation_service(&self) -> MutexGuard<'_, Option<Arc<dyn RuntimeActivationService>>> {
        self.activation_service
            .lock()
            .expect("Runtime activation service lock poisoned")
    }
}

const fn activation_failure_response(code: ControlErrorCode) -> ControlResponse {
    ControlResponse::Rejected { code }
}

impl Drop for RuntimeWorkPermit {
    fn drop(&mut self) {
        let mut active = self
            .state
            .active_product_work
            .lock()
            .expect("Runtime product-work lock poisoned");
        *active = active
            .checked_sub(1)
            .expect("active Runtime product-work count underflow");
        if *active == 0 {
            self.state.product_work_drained.notify_all();
        }
    }
}

impl RuntimeLifecycle {
    fn status(&self) -> RuntimeStatus {
        match self {
            Self::Starting => RuntimeStatus::Starting,
            Self::Ready | Self::UpdatePreparing(_) => RuntimeStatus::Ready,
            Self::Exiting => RuntimeStatus::Exiting,
            Self::Replacing(_) => RuntimeStatus::Replacing,
            Self::RemovalPreparing => RuntimeStatus::RemovalPreparing,
            Self::Removing => RuntimeStatus::Removing,
        }
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
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuitAdmission {
    Started,
    AlreadyAccepted,
    UpdateWon,
    RemovalWon,
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
    /// Sets the bounded I/O wait used while waiting for Runtime readiness.
    ///
    /// # Errors
    ///
    /// Returns an operating-system error when transport configuration fails.
    fn set_io_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()>;

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
    fn set_io_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.set_read_timeout(timeout)?;
        self.set_write_timeout(timeout)
    }

    fn clear_handshake_timeouts(&mut self) -> io::Result<()> {
        self.set_io_timeout(None)
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
    fn set_io_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.set_read_timeout(timeout);
        Ok(())
    }

    fn clear_handshake_timeouts(&mut self) -> io::Result<()> {
        self.set_io_timeout(None)
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
                    QuitAdmission::RemovalWon => ControlResponse::Rejected {
                        code: ControlErrorCode::RemovalInProgress,
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
                request: ControlRequest::RemoveProduct { keep_config },
            }) => {
                // Keep one admitted unit alive until the terminal acceptance is
                // physically flushed. Removal drain cannot reach `Removing`
                // and close this transport before the initiating CLI receives it.
                let delivery = state.begin_product_work();
                let response = state.response_for(
                    &connection.connection_id,
                    &ControlRequest::RemoveProduct { keep_config },
                );
                if matches!(response, ControlResponse::ProductRemovalAccepted { .. }) {
                    let receipt = sender
                        .send_with_flush_receipt(ServerMessage::response(request_id, response))
                        .map_err(ControlServerError::Outbound)?;
                    if receipt.recv_timeout(Duration::from_secs(5)).is_err() {
                        sender.close();
                        drop(delivery);
                        return Err(ControlServerError::Outbound(OutboundError::Closed));
                    }
                } else {
                    sender
                        .send(ServerMessage::response(request_id, response))
                        .map_err(ControlServerError::Outbound)?;
                }
                drop(delivery);
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
