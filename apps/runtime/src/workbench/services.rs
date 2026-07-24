#![allow(
    clippy::missing_errors_doc,
    clippy::needless_pass_by_value,
    clippy::too_many_lines
)]

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, PoisonError, RwLock, Weak},
    task::{Context, Poll},
    thread,
    time::Duration,
};

use futures_core::Stream;
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::{
    control::RuntimeControlState,
    generation::GenerationService,
    global::{
        GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeEvent, GlobalRuntimeService,
        ModelCatalog,
    },
    integrations::{IntegrationOperation, Platform},
    photoshop::{
        PhotoshopBridgeService, PhotoshopDiscoveryStatus, PhotoshopPairingAuthority,
        RuntimePhotoshopMessage,
    },
    project::{
        CanvasFeedbackArtifacts, GeneratedAssetMetadataService, MediaToolPaths,
        NativeProjectNodeAdapter, OpenProjectSession, ProjectNativeShellService, ProjectSession,
        ProjectSessionRegistry, ProjectSyncSnapshot, ProjectUse, ProjectUseKind,
    },
    terminal::TerminalService,
    workers::RuntimeWorkerServices,
};

use super::{
    FeedbackWorkingCopy, ProjectBindOutcome, ProjectWorkingCopies, TextWorkingCopy,
    WorkbenchConnectionRegistry, WorkingCopyStore,
};

const GLOBAL_EVENT_CAPACITY: usize = 256;

pub trait RuntimeProductHttpService: Send + Sync {
    fn state(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn check(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn apply(
        &self,
        input: &Value,
        initiator: ProductUpdateInitiator,
    ) -> Result<Value, RuntimeHttpServiceError>;
    fn quit(&self, input: &Value) -> Result<Value, RuntimeHttpServiceError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProductUpdateInitiator {
    Frontend { browser_session: String },
    Cli,
    Bootstrap,
}

pub trait RuntimeCliHttpService: Send + Sync {
    fn run(&self, request: &Value) -> Result<Value, RuntimeHttpServiceError>;
    fn run_stream(
        &self,
        request: &Value,
    ) -> Result<RuntimeCliRecordStream, RuntimeHttpServiceError>;
}

pub struct RuntimeCliRecordStream {
    receiver: tokio::sync::mpsc::Receiver<Value>,
}

impl RuntimeCliRecordStream {
    #[must_use]
    pub fn bounded(capacity: usize) -> (tokio::sync::mpsc::Sender<Value>, Self) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (sender, Self { receiver })
    }
}

impl Stream for RuntimeCliRecordStream {
    type Item = Value;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeHttpServiceError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl RuntimeHttpServiceError {
    #[must_use]
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

pub struct BoundWorkbenchProject {
    pub project_id: String,
    pub response: Value,
}

pub enum WorkbenchProjectBindingOutcome {
    Bound(BoundWorkbenchProject),
    FocusedExistingDesktop { project_id: String },
}

pub struct WorkbenchRuntimeServices {
    runtime_state: Arc<RuntimeControlState>,
    models: Arc<ModelCatalog>,
    global: Arc<GlobalRuntimeService>,
    projects: ProjectSessionRegistry,
    previews: Arc<crate::project::ProjectPreviewService>,
    native_shell: Arc<ProjectNativeShellService>,
    terminals: TerminalService,
    generation: Arc<GenerationService>,
    photoshop: Arc<PhotoshopBridgeService>,
    photoshop_sockets:
        Arc<Mutex<HashMap<String, tokio::sync::mpsc::Sender<RuntimePhotoshopMessage>>>>,
    connections: Arc<WorkbenchConnectionRegistry>,
    global_events: broadcast::Sender<GlobalRuntimeEvent>,
    connection_project_uses: Mutex<HashMap<String, ProjectUse>>,
    working_copies: WorkingCopyStore,
    product: RwLock<Option<Arc<dyn RuntimeProductHttpService>>>,
    cli: RwLock<Option<Arc<dyn RuntimeCliHttpService>>>,
}

impl WorkbenchRuntimeServices {
    /// Composes every in-process Runtime authority beneath the final HTTP
    /// adapter. The Workbench launch authority is installed by the listener
    /// before it accepts its first request.
    ///
    /// # Errors
    ///
    /// Returns a typed startup error when a catalog, pairing registry, feedback
    /// scheduler, or initial global projection cannot start.
    pub fn compose(
        debrute_home: impl AsRef<Path>,
        runtime_state: Arc<RuntimeControlState>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        let debrute_home = debrute_home.as_ref().to_path_buf();
        let workers = RuntimeWorkerServices::new();
        let media_tools = MediaToolPaths {
            ffmpeg: resolve_executable("ffmpeg"),
            ffprobe: resolve_executable("ffprobe"),
        };
        let previews = Arc::new(crate::project::ProjectPreviewService::new(
            &workers,
            media_tools,
        ));
        let feedback = Arc::new(
            CanvasFeedbackArtifacts::new(Arc::clone(&previews))
                .map_err(RuntimeHttpServiceError::from_project)?,
        );
        let projects = ProjectSessionRegistry::new(
            &debrute_home,
            Arc::new(NativeProjectNodeAdapter::new(Arc::clone(&previews))),
            feedback,
        );
        let terminals = TerminalService::new(projects.clone());
        let native_shell = Arc::new(ProjectNativeShellService::new(&workers));
        let catalog = Arc::new(ModelCatalog::bundled().map_err(|error| {
            RuntimeHttpServiceError::new(500, "model_catalog_invalid", error.to_string())
        })?);
        let global_store = Arc::new(GlobalConfigStore::new(&debrute_home));
        let integrations = workers.integration_service(
            current_platform(),
            env::var("PATH").unwrap_or_default(),
            env::var("PATHEXT").unwrap_or_default(),
        );
        let global = Arc::new(GlobalRuntimeService::new(
            Arc::clone(&global_store),
            Arc::clone(&catalog),
            integrations,
        ));
        let generated_assets = Arc::new(GeneratedAssetMetadataService::new());
        let generation = Arc::new(GenerationService::new(
            Arc::clone(&catalog),
            global_store,
            generated_assets,
        ));
        let pairings = Arc::new(
            PhotoshopPairingAuthority::open(&debrute_home)
                .map_err(RuntimeHttpServiceError::from_photoshop)?,
        );
        let photoshop_holder = Arc::new(Mutex::new(Weak::<PhotoshopBridgeService>::new()));
        let callback_holder = Arc::clone(&photoshop_holder);
        let photoshop_sockets = Arc::new(Mutex::new(HashMap::<
            String,
            tokio::sync::mpsc::Sender<RuntimePhotoshopMessage>,
        >::new()));
        let callback_sockets = Arc::clone(&photoshop_sockets);
        let callback_global = Arc::clone(&global);
        let photoshop = Arc::new(PhotoshopBridgeService::with_change_callback(
            pairings,
            projects.clone(),
            env!("CARGO_PKG_VERSION"),
            runtime_state.instance_id(),
            true,
            PhotoshopDiscoveryStatus::Unavailable,
            Arc::new(move || {
                let service = callback_holder
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .upgrade();
                if let Some(service) = service
                    && let Ok(state) = service.state()
                {
                    let _ = callback_global
                        .publish_external(GlobalRuntimeChange::PhotoshopBridgeChanged(state));
                    let sockets = callback_sockets
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .iter()
                        .map(|(session_id, sender)| (session_id.clone(), sender.clone()))
                        .collect::<Vec<_>>();
                    let mut stale = Vec::new();
                    for (session_id, sender) in sockets {
                        let message = service
                            .state_for_session(&session_id)
                            .map(|state| RuntimePhotoshopMessage::BridgeState { state });
                        if match message {
                            Ok(message) => sender.try_send(message).is_err(),
                            Err(_) => true,
                        } {
                            stale.push(session_id);
                        }
                    }
                    if !stale.is_empty() {
                        let mut sockets = callback_sockets
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner);
                        for session_id in &stale {
                            sockets.remove(session_id);
                        }
                        drop(sockets);
                        for session_id in stale {
                            let _ = service.disconnect_session(&session_id);
                        }
                    }
                }
            }),
        ));
        *photoshop_holder
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Arc::downgrade(&photoshop);

        let (global_events, _) = broadcast::channel(GLOBAL_EVENT_CAPACITY);
        let event_sender = global_events.clone();
        let presentation_state = Arc::clone(&runtime_state);
        if !global.install_observer(Arc::new(move |event| {
            if let GlobalRuntimeChange::RecentProjectsChanged(projects) = &event.change {
                let _ = presentation_state.set_recent_projects(
                    event.revision,
                    projects
                        .iter()
                        .map(|project| crate::control::RecentProject {
                            project_id: project.project_id.clone(),
                            project_root: project.project_root.clone(),
                        })
                        .collect(),
                );
            }
            let _ = event_sender.send(event);
        })) {
            return Err(RuntimeHttpServiceError::new(
                500,
                "global_observer_unavailable",
                "Global Runtime observer is already installed.",
            ));
        }

        let services = Arc::new(Self {
            runtime_state,
            models: catalog,
            global,
            projects,
            previews,
            native_shell,
            terminals,
            generation,
            photoshop,
            photoshop_sockets,
            connections: Arc::new(WorkbenchConnectionRegistry::new()),
            global_events,
            connection_project_uses: Mutex::new(HashMap::new()),
            working_copies: WorkingCopyStore::new(&debrute_home),
            product: RwLock::new(None),
            cli: RwLock::new(None),
        });
        let recent_projects = services
            .global
            .recent_projects_snapshot()
            .map_err(RuntimeHttpServiceError::from_global)?;
        services
            .runtime_state
            .set_recent_projects(
                services.global.revision(),
                recent_projects
                    .iter()
                    .map(|project| crate::control::RecentProject {
                        project_id: project.project_id.clone(),
                        project_root: project.project_root.clone(),
                    })
                    .collect(),
            )
            .map_err(|error| {
                RuntimeHttpServiceError::new(500, "runtime_state_unavailable", error.to_string())
            })?;
        Ok(services)
    }

    pub fn install_product(&self, product: Arc<dyn RuntimeProductHttpService>) {
        *self.product.write().unwrap_or_else(PoisonError::into_inner) = Some(product);
    }

    pub fn install_cli(&self, cli: Arc<dyn RuntimeCliHttpService>) {
        *self.cli.write().unwrap_or_else(PoisonError::into_inner) = Some(cli);
    }

    #[must_use]
    pub fn global(&self) -> &Arc<GlobalRuntimeService> {
        &self.global
    }

    #[must_use]
    pub fn models(&self) -> &Arc<ModelCatalog> {
        &self.models
    }

    #[must_use]
    pub fn projects(&self) -> &ProjectSessionRegistry {
        &self.projects
    }

    #[must_use]
    pub fn previews(&self) -> &Arc<crate::project::ProjectPreviewService> {
        &self.previews
    }

    #[must_use]
    pub fn native_shell(&self) -> &Arc<ProjectNativeShellService> {
        &self.native_shell
    }

    #[must_use]
    pub fn terminals(&self) -> &TerminalService {
        &self.terminals
    }

    #[must_use]
    pub fn generation(&self) -> &Arc<GenerationService> {
        &self.generation
    }

    #[must_use]
    pub fn photoshop(&self) -> &Arc<PhotoshopBridgeService> {
        &self.photoshop
    }

    pub fn register_photoshop_socket(
        &self,
        session_id: String,
        replaced_session_id: Option<&str>,
        sender: tokio::sync::mpsc::Sender<RuntimePhotoshopMessage>,
    ) {
        let mut sockets = self
            .photoshop_sockets
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(replaced) = replaced_session_id
            && let Some(replaced_sender) = sockets.remove(replaced)
        {
            let _ = replaced_sender.try_send(RuntimePhotoshopMessage::BridgeError {
                code: crate::photoshop::PhotoshopBridgeErrorCode::PluginSessionReplaced,
                message: "Photoshop plugin session was replaced.".to_owned(),
            });
        }
        sockets.insert(session_id, sender);
    }

    pub fn unregister_photoshop_socket(&self, session_id: &str) {
        self.photoshop_sockets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session_id);
    }

    pub fn send_photoshop_message(
        &self,
        session_id: &str,
        message: RuntimePhotoshopMessage,
    ) -> Result<(), RuntimeHttpServiceError> {
        let sender = self
            .photoshop_sockets
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    409,
                    "adobe_client_offline",
                    "Photoshop plugin is not connected.",
                )
            })?;
        sender.try_send(message).map_err(|_| {
            RuntimeHttpServiceError::new(
                503,
                "photoshop_socket_backpressure",
                "Photoshop plugin outbound queue is unavailable.",
            )
        })
    }

    #[must_use]
    pub(crate) fn connections(&self) -> &Arc<WorkbenchConnectionRegistry> {
        &self.connections
    }

    pub fn ensure_accepting_workbench_connections(&self) -> Result<(), RuntimeHttpServiceError> {
        if self.runtime_state.status() == crate::control::RuntimeStatus::Ready {
            return Ok(());
        }
        Err(RuntimeHttpServiceError::new(
            503,
            "runtime_not_ready",
            "Runtime is not accepting new Workbench connections.",
        ))
    }

    pub fn bind_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
        force_open_here: bool,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .authorize(browser_session, connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    403,
                    "workbench_connection_invalid",
                    "Workbench connection is not live.",
                )
            })?;
        if context.project_id.is_some() {
            return Err(RuntimeHttpServiceError::new(
                409,
                "project_already_bound",
                "OpenProject requires an unbound Workbench connection.",
            ));
        }
        self.bind_opened_project(connection_credential, project_root, force_open_here)
    }

    pub fn bind_connection_project_id(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_id: &str,
        force_open_here: bool,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let project_root = self.project_root_for_stable_id(project_id)?;
        self.bind_connection_project_root(
            browser_session,
            connection_credential,
            &project_root,
            force_open_here,
        )
    }

    pub fn replace_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
        force_open_here: bool,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .authorize(browser_session, connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    403,
                    "workbench_connection_invalid",
                    "Workbench connection is not live.",
                )
            })?;
        let source_project_id = context.project_id.clone().ok_or_else(|| {
            RuntimeHttpServiceError::new(
                409,
                "project_not_bound",
                "ReplaceProject requires a bound Workbench connection.",
            )
        })?;
        let opened = self.open_project_use(project_root, ProjectUseKind::Workbench)?;
        let target_project_id = opened.session.project_id().to_owned();
        self.remember_recent_project(&opened.session)?;
        if !force_open_here
            && let Some(outcome) =
                self.desktop_existing_owner_outcome(&context, &target_project_id)?
        {
            return Ok(outcome);
        }
        let sync = opened
            .session
            .sync_snapshot()
            .map_err(RuntimeHttpServiceError::from_project)?;
        let working_copies = self.working_copies.load(&target_project_id)?;
        let outcome = self
            .connections
            .replace_project(
                connection_credential,
                &source_project_id,
                &target_project_id,
            )
            .map_err(|()| {
                RuntimeHttpServiceError::new(
                    409,
                    "project_binding_stale",
                    "Workbench Project binding changed before replacement.",
                )
            })?;
        if outcome == ProjectBindOutcome::AlreadyBound {
            if let Some(binding) = context.desktop.as_ref() {
                self.runtime_state.retarget_desktop_window(
                    binding,
                    crate::control::WorkbenchRoute::Project {
                        project_id: target_project_id.clone(),
                    },
                );
            }
            return Ok(WorkbenchProjectBindingOutcome::Bound(
                BoundWorkbenchProject {
                    project_id: target_project_id,
                    response: public_project_sync(&sync)?,
                },
            ));
        }
        let ProjectBindOutcome::Bound { preempted } = outcome else {
            unreachable!("already-bound replacement returned above")
        };
        let mut project_uses = self
            .connection_project_uses
            .lock()
            .map_err(|_| RuntimeHttpServiceError::state_poisoned())?;
        project_uses.insert(connection_credential.to_owned(), opened.project_use);
        if let Some(preempted) = preempted.as_ref() {
            project_uses.remove(&preempted.credential);
        }
        drop(project_uses);
        if let Some(binding) = context.desktop.as_ref() {
            self.runtime_state.retarget_desktop_window(
                binding,
                crate::control::WorkbenchRoute::Project {
                    project_id: target_project_id.clone(),
                },
            );
        }
        if let Some(binding) = preempted.and_then(|connection| connection.desktop) {
            self.runtime_state
                .retarget_desktop_window(&binding, crate::control::WorkbenchRoute::Root);
        }
        let response = public_project_sync(&sync)?;
        if let Err(error) = self.start_connection_project_stream(
            connection_credential,
            opened.session,
            response.clone(),
            working_copies,
        ) {
            self.close_workbench_connection(connection_credential);
            return Err(error);
        }
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                project_id: target_project_id,
                response,
            },
        ))
    }

    pub fn close_workbench_connection(&self, connection_credential: &str) {
        self.connections.close(connection_credential);
        self.connection_project_uses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(connection_credential);
    }

    pub fn close_all_workbench_connections(&self) {
        self.connections.close_all();
        self.connection_project_uses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    pub fn project_root_for_stable_id(
        &self,
        project_id: &str,
    ) -> Result<String, RuntimeHttpServiceError> {
        self.global
            .settings_get()
            .map_err(RuntimeHttpServiceError::from_global)?
            .chrome
            .recent_projects
            .into_iter()
            .find(|project| project.project_id == project_id)
            .map(|project| project.project_root)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    404,
                    "project_not_discovered",
                    "Project id is not present in Recent Projects.",
                )
            })
    }

    fn bind_opened_project(
        &self,
        connection_credential: &str,
        project_root: &str,
        force_open_here: bool,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .context(connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    409,
                    "workbench_connection_invalid",
                    "Workbench connection ended before Project binding.",
                )
            })?;
        let opened = self.open_project_use(project_root, ProjectUseKind::Workbench)?;
        let project_id = opened.session.project_id().to_owned();
        self.remember_recent_project(&opened.session)?;
        if !force_open_here
            && let Some(outcome) = self.desktop_existing_owner_outcome(&context, &project_id)?
        {
            return Ok(outcome);
        }
        let sync = opened
            .session
            .sync_snapshot()
            .map_err(RuntimeHttpServiceError::from_project)?;
        let working_copies = self.working_copies.load(&project_id)?;
        let outcome = self
            .connections
            .bind_project(connection_credential, &project_id)
            .map_err(|()| {
                RuntimeHttpServiceError::new(
                    409,
                    "project_already_bound",
                    "Workbench connection already has a Project.",
                )
            })?;
        let mut project_uses = self
            .connection_project_uses
            .lock()
            .map_err(|_| RuntimeHttpServiceError::state_poisoned())?;
        match outcome {
            ProjectBindOutcome::AlreadyBound => {}
            ProjectBindOutcome::Bound { preempted } => {
                project_uses.insert(connection_credential.to_owned(), opened.project_use);
                if let Some(preempted) = preempted.as_ref() {
                    project_uses.remove(&preempted.credential);
                }
                if let Some(binding) = context.desktop.as_ref() {
                    self.runtime_state.retarget_desktop_window(
                        binding,
                        crate::control::WorkbenchRoute::Project {
                            project_id: project_id.clone(),
                        },
                    );
                }
                if let Some(binding) = preempted.and_then(|connection| connection.desktop) {
                    self.runtime_state
                        .retarget_desktop_window(&binding, crate::control::WorkbenchRoute::Root);
                }
            }
        }
        drop(project_uses);
        let response = public_project_sync(&sync)?;
        if let Err(error) = self.start_connection_project_stream(
            connection_credential,
            opened.session,
            response.clone(),
            working_copies,
        ) {
            self.close_workbench_connection(connection_credential);
            return Err(error);
        }
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                project_id,
                response,
            },
        ))
    }

    fn desktop_existing_owner_outcome(
        &self,
        requester: &super::WorkbenchConnectionContext,
        project_id: &str,
    ) -> Result<Option<WorkbenchProjectBindingOutcome>, RuntimeHttpServiceError> {
        if requester.desktop.is_none() {
            return Ok(None);
        }
        let Some(owner) = self.connections.project_owner(project_id) else {
            return Ok(None);
        };
        if owner.credential == requester.credential {
            return Ok(None);
        }
        if let Some(binding) = owner.desktop {
            let focused = self
                .runtime_state
                .focus_desktop_window(&binding)
                .map_err(|error| {
                    RuntimeHttpServiceError::new(
                        503,
                        "desktop_window_focus_failed",
                        error.to_string(),
                    )
                })?;
            if !focused {
                return Err(RuntimeHttpServiceError::new(
                    503,
                    "desktop_window_focus_failed",
                    "Runtime no longer owns the target Desktop window.",
                ));
            }
            return Ok(Some(
                WorkbenchProjectBindingOutcome::FocusedExistingDesktop {
                    project_id: project_id.to_owned(),
                },
            ));
        }
        if let Some(binding) = requester.desktop.as_ref()
            && !self
                .runtime_state
                .retarget_desktop_window(binding, crate::control::WorkbenchRoute::Root)
        {
            return Err(RuntimeHttpServiceError::new(
                503,
                "desktop_window_retarget_failed",
                "Runtime no longer owns the requesting Desktop window.",
            ));
        }
        Err(RuntimeHttpServiceError::new(
            409,
            "project_owned_by_web",
            "This Project is active in a Web Workbench. Choose Open Here to move it to Desktop.",
        )
        .with_details(json!({ "projectId": project_id })))
    }

    fn open_project_use(
        &self,
        project_root: &str,
        kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, RuntimeHttpServiceError> {
        self.projects
            .open_project(project_root, kind)
            .map_err(RuntimeHttpServiceError::from_project)
    }

    fn remember_recent_project(
        &self,
        session: &ProjectSession,
    ) -> Result<(), RuntimeHttpServiceError> {
        let project_root = session.root().to_str().ok_or_else(|| {
            RuntimeHttpServiceError::new(
                400,
                "project_root_invalid",
                "Project root is not valid UTF-8.",
            )
        })?;
        self.global
            .remember_recent_project(session.project_id(), project_root)
            .map_err(RuntimeHttpServiceError::from_global)?;
        Ok(())
    }

    fn start_connection_project_stream(
        &self,
        connection_credential: &str,
        session: Arc<ProjectSession>,
        response: Value,
        working_copies: ProjectWorkingCopies,
    ) -> Result<(), RuntimeHttpServiceError> {
        let sender = self
            .connections
            .event_sender(connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    409,
                    "workbench_connection_invalid",
                    "Workbench connection ended before Project binding.",
                )
            })?;
        sender
            .try_send(json!({
                "type": "project.bound",
                "project": response,
                "workingCopies": working_copies
            }))
            .map_err(|_| {
                RuntimeHttpServiceError::new(
                    503,
                    "workbench_connection_backpressure",
                    "Workbench connection queue is unavailable.",
                )
            })?;
        let mut subscription = session
            .subscribe()
            .map_err(RuntimeHttpServiceError::from_project)?;
        let _ = subscription.recv();
        let credential = connection_credential.to_owned();
        let project_id = session.project_id().to_owned();
        let connections = Arc::clone(&self.connections);
        thread::Builder::new()
            .name("debrute-workbench-project-stream".to_owned())
            .spawn(move || {
                loop {
                    if connections
                        .context(&credential)
                        .is_none_or(|context| context.project_id.as_deref() != Some(&project_id))
                    {
                        return;
                    }
                    match subscription.recv_timeout(Duration::from_millis(100)) {
                        Ok(Some(item)) => {
                            let Ok(value) = super::routes::project_stream_value(item) else {
                                connections.close(&credential);
                                return;
                            };
                            if sender.try_send(value).is_err() {
                                connections.close(&credential);
                                return;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {
                            connections.close(&credential);
                            return;
                        }
                    }
                }
            })
            .map_err(|error| {
                RuntimeHttpServiceError::new(500, "workbench_stream_unavailable", error.to_string())
            })?;
        Ok(())
    }

    pub fn put_text_working_copy(
        &self,
        project_id: &str,
        working_copy: TextWorkingCopy,
    ) -> Result<TextWorkingCopy, RuntimeHttpServiceError> {
        self.working_copies.put_text(project_id, working_copy)
    }

    pub fn clear_text_working_copy(
        &self,
        project_id: &str,
        project_relative_path: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        self.working_copies
            .clear_text(project_id, project_relative_path)
    }

    pub fn put_feedback_working_copy(
        &self,
        project_id: &str,
        working_copy: FeedbackWorkingCopy,
    ) -> Result<FeedbackWorkingCopy, RuntimeHttpServiceError> {
        self.working_copies.put_feedback(project_id, working_copy)
    }

    pub fn clear_feedback_working_copy(
        &self,
        project_id: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        self.working_copies.clear_feedback(project_id)
    }

    #[must_use]
    pub fn subscribe_global(&self) -> broadcast::Receiver<GlobalRuntimeEvent> {
        self.global_events.subscribe()
    }

    pub fn product(&self) -> Result<Arc<dyn RuntimeProductHttpService>, RuntimeHttpServiceError> {
        self.product
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    503,
                    "product_service_unavailable",
                    "Product update service is unavailable.",
                )
            })
    }

    pub fn resume_target_for_browser(
        &self,
        browser_session: &str,
    ) -> Result<crate::product::ResumeTarget, RuntimeHttpServiceError> {
        Ok(self
            .connections
            .context_for_browser_session(browser_session)
            .and_then(|connection| connection.project_id)
            .map_or(crate::product::ResumeTarget::Root, |project_id| {
                crate::product::ResumeTarget::Project { project_id }
            }))
    }

    #[must_use]
    pub fn is_desktop_browser_session(&self, browser_session: &str) -> bool {
        self.connections
            .context_for_browser_session(browser_session)
            .is_some_and(|connection| connection.desktop.is_some())
    }

    pub fn cli(&self) -> Result<Arc<dyn RuntimeCliHttpService>, RuntimeHttpServiceError> {
        self.cli
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    503,
                    "cli_service_unavailable",
                    "Runtime CLI command service is unavailable.",
                )
            })
    }

    pub fn discover_project(&self, project_root: &str) -> Result<String, RuntimeHttpServiceError> {
        let opened = self
            .projects
            .open_project(project_root, ProjectUseKind::Request)
            .map_err(RuntimeHttpServiceError::from_project)?;
        let project_id = opened.session.project_id().to_owned();
        self.remember_recent_project(&opened.session)?;
        Ok(project_id)
    }

    pub fn integration_operation(
        &self,
        integration_id: &str,
        operation: &str,
    ) -> Result<Value, RuntimeHttpServiceError> {
        let operation = match operation {
            "install" => IntegrationOperation::Install,
            "update" => IntegrationOperation::Update,
            "uninstall" => IntegrationOperation::Uninstall,
            _ => {
                return Err(RuntimeHttpServiceError::new(
                    400,
                    "invalid_integration_operation",
                    "Integration operation is not registered.",
                ));
            }
        };
        serde_json::to_value(
            self.global
                .integrations_run_operation(integration_id, operation)
                .map_err(RuntimeHttpServiceError::from_global)?,
        )
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))
    }
}

impl Drop for WorkbenchRuntimeServices {
    fn drop(&mut self) {
        let _ = self.terminals.close_all();
        let _ = self.projects.close();
    }
}

impl RuntimeHttpServiceError {
    pub(crate) fn from_project(error: crate::project::ProjectError) -> Self {
        Self {
            status: if matches!(
                error,
                crate::project::ProjectError::ProjectNotFound(_)
                    | crate::project::ProjectError::ProjectNotOpen(_)
            ) {
                404
            } else {
                400
            },
            code: error.code(),
            message: error.to_string(),
            details: None,
        }
    }

    pub(crate) fn from_global(error: crate::global::GlobalRuntimeError) -> Self {
        Self::new(400, "global_runtime_error", error.to_string())
    }

    pub(crate) fn from_photoshop(error: crate::photoshop::PhotoshopBridgeError) -> Self {
        use crate::photoshop::PhotoshopBridgeErrorCode as Code;

        let status = match error.code() {
            Code::AdobeBridgeDisabled | Code::AdobeDiscoveryUnavailable => 503,
            Code::AdobeClientOffline
            | Code::ProjectOffline
            | Code::PairingNotFound
            | Code::PairingExpired
            | Code::TargetDirectoryMissing
            | Code::TransferUrlExpired => 404,
            Code::ProjectNotLinked => 403,
            Code::PluginSessionInvalid => 401,
            Code::PluginSessionReplaced | Code::PairingAttemptsExceeded => 409,
            Code::UploadTooLarge => 413,
            Code::PairingCapacityReached | Code::TransferCapacityReached => 429,
            Code::TransferTimeout => 504,
            Code::PairingRegistryInvalid | Code::StatePoisoned | Code::PersistenceFailed => 500,
            Code::PairingCodeInvalid
            | Code::PairingKeyInvalid
            | Code::PairingSignatureInvalid
            | Code::TargetDirectoryNotVisible
            | Code::UnsupportedFileType
            | Code::NoActiveDocument
            | Code::PhotoshopPlaceFailed
            | Code::InvalidTransferPayload => 400,
        };
        let fields = error.fields().clone();
        let mapped = Self::new(status, error.code().as_str(), error.to_string());
        if fields.is_empty() {
            mapped
        } else {
            mapped.with_details(Value::Object(fields))
        }
    }

    pub(crate) fn state_poisoned() -> Self {
        Self::new(
            500,
            "runtime_state_poisoned",
            "Runtime service state is unavailable.",
        )
    }

    pub(crate) fn serialization(error: &serde_json::Error) -> Self {
        Self::new(500, "serialization_failed", error.to_string())
    }
}

pub fn public_project_sync(sync: &ProjectSyncSnapshot) -> Result<Value, RuntimeHttpServiceError> {
    let snapshot = public_project_snapshot(&sync.snapshot, &sync.project_id)?;
    Ok(json!({
        "projectId": sync.project_id,
        "projectRevision": sync.project_revision,
        "snapshot": snapshot
    }))
}

pub fn public_project_health(
    health: &crate::project::ProjectHealthSummary,
) -> Result<Value, RuntimeHttpServiceError> {
    let mut value = serde_json::to_value(health)
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))?;
    if let Some(object) = value.as_object_mut() {
        object.remove("runtimeDataLocation");
    }
    Ok(value)
}

pub fn public_project_snapshot(
    snapshot: &crate::project::ProjectSnapshot,
    project_id: &str,
) -> Result<Value, RuntimeHttpServiceError> {
    let mut value = serde_json::to_value(snapshot)
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))?;
    let Some(object) = value.as_object_mut() else {
        return Err(RuntimeHttpServiceError::new(
            500,
            "serialization_failed",
            "Project snapshot did not serialize to an object.",
        ));
    };
    object.remove("projectRoot");
    if let Some(health) = object.get_mut("health").and_then(Value::as_object_mut) {
        health.remove("runtimeDataLocation");
    }
    if let Some(projections) = object.get_mut("projections").and_then(Value::as_array_mut) {
        for projection in projections {
            expose_project_media_urls(projection, project_id);
        }
    }
    Ok(value)
}

pub(crate) fn public_canvas_projection(
    projection: &crate::project::CanvasProjection,
    project_id: &str,
) -> Result<Value, RuntimeHttpServiceError> {
    let mut value = serde_json::to_value(projection)
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))?;
    expose_project_media_urls(&mut value, project_id);
    Ok(value)
}

fn expose_project_media_urls(projection: &mut Value, project_id: &str) {
    let Some(nodes) = projection.get_mut("nodes").and_then(Value::as_array_mut) else {
        return;
    };
    for node in nodes {
        let path = node
            .get("projectRelativePath")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let availability = node.get_mut("availability");
        let (Some(path), Some(availability)) = (path, availability) else {
            continue;
        };
        if availability.get("state").and_then(Value::as_str) != Some("available") {
            continue;
        }
        let revision = availability
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or_default();
        availability["fileUrl"] = Value::String(project_file_url(project_id, &path, revision));
        if let Some(tracks) = node
            .get_mut("videoPresentation")
            .and_then(|value| value.get_mut("textTracks"))
            .and_then(Value::as_array_mut)
        {
            for track in tracks {
                let Some(path) = track.get("projectRelativePath").and_then(Value::as_str) else {
                    continue;
                };
                let revision = track
                    .get("revision")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                track["fileUrl"] = Value::String(project_file_url(project_id, path, revision));
            }
        }
    }
}

fn project_file_url(project_id: &str, project_relative_path: &str, revision: &str) -> String {
    format!(
        "/api/projects/{}/files/raw/{}?v={}",
        percent_encode_segment(project_id),
        encode_project_path(project_relative_path),
        percent_encode_segment(revision)
    )
}

pub(crate) fn project_response(session: &ProjectSession, revision: u64, body: Value) -> Value {
    let mut object = body.as_object().cloned().unwrap_or_default();
    object.insert(
        "projectId".to_owned(),
        Value::String(session.project_id().to_owned()),
    );
    object.insert("projectRevision".to_owned(), Value::from(revision));
    Value::Object(object)
}

#[must_use]
pub fn percent_encode_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![char::from(byte)]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

#[must_use]
pub fn encode_project_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(not(target_os = "windows"))]
    {
        Platform::MacOs
    }
}

fn resolve_executable(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
        let candidate = directory.join(name);
        candidate.is_file().then_some(candidate)
    })
}
