#![allow(
    clippy::missing_errors_doc,
    clippy::needless_pass_by_value,
    clippy::too_many_lines
)]

use std::{
    env,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
    task::{Context, Poll},
    thread,
    time::Duration,
};

use axum::http::StatusCode;
use futures_core::Stream;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::{
    control::{DesktopOpenResult, RuntimeControlState, WorkbenchRoute},
    executable_path::resolve_executable,
    generation::GenerationService,
    global::{
        GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeEvent, GlobalRuntimeService,
        ModelCatalog,
    },
    integrations::{IntegrationOperation, Platform},
    model_operation::ModelOperationService,
    photoshop::PhotoshopIntegration,
    project::{
        CanvasFeedbackArtifacts, GeneratedAssetMetadataService, MediaToolPaths,
        NativeProjectNodeAdapter, OpenProjectSession, ProjectNativeShellService, ProjectSession,
        ProjectSessionRegistry, ProjectStreamItem, ProjectSubscription, ProjectSyncSnapshot,
        ProjectUse, ProjectUseKind,
    },
    terminal::TerminalService,
    workers::RuntimeWorkerServices,
};

use super::{
    FeedbackWorkingCopy, ProjectBindError, ProjectBindOutcome, ProjectBindingCommit,
    TextWorkingCopy, WorkbenchConnectionCloser, WorkbenchConnectionDrainOutcome,
    WorkbenchConnectionRegistry, WorkingCopyStore,
};

const GLOBAL_EVENT_CAPACITY: usize = 256;
pub(crate) const WORKBENCH_HTTP_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

pub trait RuntimeProductHttpService: Send + Sync {
    fn state(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn check(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn apply(
        &self,
        input: &Value,
        initiator: ProductUpdateInitiator,
    ) -> Result<Value, RuntimeHttpServiceError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProductUpdateInitiator {
    Desktop { project_id: Option<String> },
    Browser { project_id: Option<String> },
    Cli,
}

pub trait RuntimeCliHttpService: Send + Sync {
    fn run(&self, request: &Value) -> Result<Value, RuntimeHttpServiceError>;
    fn submit(&self, request: &Value, input: &[u8]) -> Result<Value, RuntimeHttpServiceError>;
    fn run_stream(
        &self,
        request: &Value,
        observer_is_alive: Arc<dyn Fn() -> bool + Send + Sync>,
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
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}

impl RuntimeHttpServiceError {
    #[must_use]
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
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

struct PreparedWorkbenchProjectBinding {
    session: Arc<ProjectSession>,
    project_use: ProjectUse,
    response: Value,
    bound_event: Value,
    sender: mpsc::Sender<Value>,
    subscription: ProjectSubscription,
}

pub struct WorkbenchRuntimeServices {
    runtime_state: Arc<RuntimeControlState>,
    models: Arc<ModelCatalog>,
    global: Arc<GlobalRuntimeService>,
    projects: ProjectSessionRegistry,
    previews: Arc<crate::project::ProjectPreviewService>,
    native_shell: Arc<ProjectNativeShellService>,
    terminals: TerminalService,
    generated_assets: Arc<GeneratedAssetMetadataService>,
    model_operations: Arc<ModelOperationService<GenerationService>>,
    photoshop: Arc<PhotoshopIntegration>,
    connections: Arc<WorkbenchConnectionRegistry>,
    connection_closer: WorkbenchConnectionCloser,
    global_events: broadcast::Sender<GlobalRuntimeEvent>,
    working_copies: WorkingCopyStore,
}

impl WorkbenchRuntimeServices {
    /// Composes every in-process Runtime authority beneath the final HTTP
    /// adapter. The Workbench launch authority is installed by the listener
    /// before it accepts its first request.
    ///
    /// # Errors
    ///
    /// Returns a typed startup error when a catalog, Photoshop integration, feedback
    /// scheduler, or initial global projection cannot start.
    ///
    /// # Panics
    ///
    /// Panics when an authoritative in-process lock is poisoned.
    pub fn compose(
        debrute_home: impl AsRef<Path>,
        runtime_state: Arc<RuntimeControlState>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        let debrute_home = debrute_home.as_ref().to_path_buf();
        let workers = RuntimeWorkerServices::new();
        let platform = current_platform();
        let env_path = env::var_os("PATH").unwrap_or_default();
        let path_ext = env::var_os("PATHEXT").unwrap_or_default();
        let media_tools = MediaToolPaths {
            ffmpeg: resolve_executable("ffmpeg", &env_path, platform, &path_ext),
            ffprobe: resolve_executable("ffprobe", &env_path, platform, &path_ext),
        };
        let previews = Arc::new(crate::project::ProjectPreviewService::new(
            &workers,
            media_tools,
        ));
        let feedback = Arc::new(
            CanvasFeedbackArtifacts::new(Arc::clone(&previews))
                .map_err(RuntimeHttpServiceError::from_project)?,
        );
        let photoshop_holder = Arc::new(Mutex::new(Weak::<PhotoshopIntegration>::new()));
        let project_photoshop_holder = Arc::clone(&photoshop_holder);
        let projects = ProjectSessionRegistry::with_change_callback(
            &debrute_home,
            Arc::new(NativeProjectNodeAdapter::new(Arc::clone(&previews))),
            feedback,
            Arc::new(move || {
                if let Some(photoshop) = project_photoshop_holder
                    .lock()
                    .expect("Photoshop integration holder lock poisoned")
                    .upgrade()
                {
                    photoshop.broadcast_projects();
                }
            }),
        );
        let terminals = TerminalService::new(projects.clone());
        let native_shell = Arc::new(ProjectNativeShellService::new(&workers));
        let catalog = Arc::new(ModelCatalog::bundled().map_err(|error| {
            RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "model_catalog_invalid",
                error.to_string(),
            )
        })?);
        let global_store = Arc::new(GlobalConfigStore::new(&debrute_home));
        let integrations = workers.integration_service(platform, env_path, path_ext);
        let global = Arc::new(GlobalRuntimeService::new(
            Arc::clone(&global_store),
            Arc::clone(&catalog),
            integrations,
        ));
        let generated_assets = Arc::new(GeneratedAssetMetadataService::new());
        let generation = Arc::new(GenerationService::new(
            Arc::clone(&catalog),
            global_store,
            Arc::clone(&generated_assets),
        ));
        let model_operations = Arc::new(ModelOperationService::new(Arc::clone(&generation)));
        let callback_global = Arc::clone(&global);
        let photoshop = Arc::new(PhotoshopIntegration::new(
            runtime_state.instance_id(),
            projects.clone(),
            Arc::new(move |state| {
                callback_global.publish_external(GlobalRuntimeChange::PhotoshopChanged(state));
            }),
        ));
        *photoshop_holder
            .lock()
            .expect("Photoshop integration holder lock poisoned") = Arc::downgrade(&photoshop);

        let (global_events, _) = broadcast::channel(GLOBAL_EVENT_CAPACITY);
        let event_sender = global_events.clone();
        let presentation_state = Arc::clone(&runtime_state);
        if !global.install_observer(Arc::new(move |event| {
            match &event.change {
                GlobalRuntimeChange::RecentProjectsChanged(projects) => {
                    presentation_state.set_recent_projects(
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
                GlobalRuntimeChange::GlobalSettingsChanged(settings) => {
                    presentation_state.set_theme_preference(&settings.workbench.theme_preference);
                }
                GlobalRuntimeChange::IntegrationsChanged(_)
                | GlobalRuntimeChange::PhotoshopChanged(_)
                | GlobalRuntimeChange::ProductChanged(_) => {}
            }
            let _ = event_sender.send(event);
        })) {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "global_observer_unavailable",
                "Global Runtime observer is already installed.",
            ));
        }

        let connections = Arc::new(WorkbenchConnectionRegistry::new());
        let connection_closer = WorkbenchConnectionCloser::start(Arc::clone(&connections));
        let services = Arc::new(Self {
            runtime_state,
            models: catalog,
            global,
            projects,
            previews,
            native_shell,
            terminals,
            generated_assets,
            model_operations,
            photoshop,
            connections,
            connection_closer,
            global_events,
            working_copies: WorkingCopyStore::new(&debrute_home),
        });
        let (recent_projects, theme_preference) = services
            .global
            .desktop_presentation_snapshot()
            .map_err(RuntimeHttpServiceError::from_global)?;
        services.runtime_state.set_recent_projects(
            services.global.revision(),
            recent_projects
                .iter()
                .map(|project| crate::control::RecentProject {
                    project_id: project.project_id.clone(),
                    project_root: project.project_root.clone(),
                })
                .collect(),
        );
        services
            .runtime_state
            .set_theme_preference(&theme_preference);
        Ok(services)
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
    pub fn generated_assets(&self) -> &Arc<GeneratedAssetMetadataService> {
        &self.generated_assets
    }

    #[must_use]
    pub fn model_operations(&self) -> &Arc<ModelOperationService<GenerationService>> {
        &self.model_operations
    }

    #[must_use]
    pub fn photoshop(&self) -> &Arc<PhotoshopIntegration> {
        &self.photoshop
    }

    #[must_use]
    pub fn connections(&self) -> &Arc<WorkbenchConnectionRegistry> {
        &self.connections
    }

    pub fn ensure_accepting_workbench_connections(&self) -> Result<(), RuntimeHttpServiceError> {
        if self.runtime_state.status() == crate::control::RuntimeStatus::Ready
            && self.connections.is_accepting()
        {
            return Ok(());
        }
        Err(RuntimeHttpServiceError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_ready",
            "Runtime is not accepting new Workbench connections.",
        ))
    }

    pub fn bind_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .authorize(browser_session, connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    StatusCode::FORBIDDEN,
                    "workbench_connection_invalid",
                    "Workbench connection is not live.",
                )
            })?;
        if context.project_id.is_some() {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "project_already_bound",
                "OpenProject requires an unbound Workbench connection.",
            ));
        }
        self.bind_opened_project(connection_credential, project_root)
    }

    pub fn bind_connection_project_id(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_id: &str,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let project_root = self.project_root_for_stable_id(project_id)?;
        self.bind_connection_project_root(browser_session, connection_credential, &project_root)
    }

    pub fn replace_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .authorize(browser_session, connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    StatusCode::FORBIDDEN,
                    "workbench_connection_invalid",
                    "Workbench connection is not live.",
                )
            })?;
        if context.desktop.is_some() {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "desktop_project_requires_activation",
                "Desktop Project opens require native Desktop activation.",
            ));
        }
        let source_project_id = context.project_id.clone().ok_or_else(|| {
            RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "project_not_bound",
                "ReplaceProject requires a bound Workbench connection.",
            )
        })?;
        let opened = self.open_project_use(project_root, ProjectUseKind::Workbench)?;
        let target_project_id = opened.session.project_id().to_owned();
        self.remember_recent_project(&opened.session)?;
        let prepared = self.prepare_project_binding(connection_credential, opened)?;
        let project_session = Arc::clone(&prepared.session);
        let outcome = self
            .connections
            .replace_project(
                connection_credential,
                &source_project_id,
                context.binding_generation,
                ProjectBindingCommit {
                    project_id: target_project_id.clone(),
                    project_use: prepared.project_use,
                    bound_event: prepared.bound_event,
                },
            )
            .map_err(project_replacement_error)?;
        if outcome == ProjectBindOutcome::AlreadyBound {
            project_session.start_background_file_index();
            return Ok(WorkbenchProjectBindingOutcome::Bound(
                BoundWorkbenchProject {
                    project_id: target_project_id,
                    response: prepared.response,
                },
            ));
        }
        let ProjectBindOutcome::Bound {
            generation,
            preempted,
        } = outcome
        else {
            unreachable!("already-bound replacement returned above")
        };
        if let Some(binding) = preempted.and_then(|connection| connection.desktop) {
            self.runtime_state
                .retarget_desktop_window(&binding, crate::control::WorkbenchRoute::Root);
        }
        if let Err(error) = self.start_connection_project_stream(
            connection_credential,
            &target_project_id,
            generation,
            prepared.sender,
            prepared.subscription,
        ) {
            self.close_workbench_connection(connection_credential);
            return Err(error);
        }
        project_session.start_background_file_index();
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                project_id: target_project_id,
                response: prepared.response,
            },
        ))
    }

    pub fn close_workbench_connection(&self, connection_credential: &str) {
        self.connections.close(connection_credential);
    }

    pub fn request_workbench_connection_close(&self, connection_credential: String) {
        self.connection_closer.request_close(connection_credential);
    }

    pub fn close_workbench_connection_admission(&self) {
        self.connections.close_admission();
    }

    pub fn close_all_workbench_connections(&self) {
        let outcome = self
            .connection_closer
            .close_all(WORKBENCH_HTTP_DRAIN_TIMEOUT);
        if let WorkbenchConnectionDrainOutcome::TimedOut(counts) = outcome {
            eprintln!(
                "Debrute Runtime Workbench HTTP drain timed out after {}ms (connections={}, bound_projects={})",
                WORKBENCH_HTTP_DRAIN_TIMEOUT.as_millis(),
                counts.connections,
                counts.bound_projects
            );
        }
    }

    pub fn finish_workbench_connection_closer(&self) {
        self.connection_closer.shutdown();
    }

    pub fn shutdown_owned_work(&self) {
        self.model_operations.shutdown();
        if let Err(error) = self.terminals.close_all() {
            eprintln!("Debrute Runtime Terminal shutdown failed: {error}");
        }
        if let Err(error) = self.projects.close() {
            eprintln!("Debrute Runtime Project shutdown failed: {error}");
        }
    }

    pub fn project_root_for_stable_id(
        &self,
        project_id: &str,
    ) -> Result<String, RuntimeHttpServiceError> {
        let (recent_projects, _) = self
            .global
            .desktop_presentation_snapshot()
            .map_err(RuntimeHttpServiceError::from_global)?;
        recent_projects
            .into_iter()
            .find(|project| project.project_id == project_id)
            .map(|project| project.project_root)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    StatusCode::NOT_FOUND,
                    "project_not_discovered",
                    "Project id is not present in Recent Projects.",
                )
            })
    }

    /// Focuses an existing Desktop owner or binds the selected true-empty
    /// Desktop connection, opening a new Project-routed window when neither
    /// destination exists.
    ///
    /// # Errors
    ///
    /// Returns a service error when Project binding, Desktop window creation,
    /// or focusing the committed destination fails.
    pub fn activate_desktop_project(
        &self,
        project_id: &str,
        project_root: &str,
        preferred_window_key: Option<&str>,
    ) -> Result<DesktopOpenResult, RuntimeHttpServiceError> {
        if self
            .runtime_state
            .focus_desktop_project_window(project_id)
            .map_err(desktop_activation_error)?
        {
            return Ok(DesktopOpenResult::FocusedExisting);
        }
        let Some(connection) = self
            .connections
            .reusable_desktop_connection(preferred_window_key)
        else {
            return self
                .runtime_state
                .open_desktop_window(&WorkbenchRoute::Project {
                    project_id: project_id.to_owned(),
                })
                .map_err(desktop_activation_error);
        };
        let binding = connection.binding;
        match self.bind_opened_project(&connection.credential, project_root)? {
            WorkbenchProjectBindingOutcome::FocusedExistingDesktop { .. } => {
                Ok(DesktopOpenResult::FocusedExisting)
            }
            WorkbenchProjectBindingOutcome::Bound(_) => {
                let focused = self
                    .runtime_state
                    .focus_desktop_window(&binding)
                    .map_err(desktop_activation_error)?;
                if !focused {
                    return Err(RuntimeHttpServiceError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "desktop_window_focus_failed",
                        "Runtime no longer owns the reused Desktop window.",
                    ));
                }
                Ok(DesktopOpenResult::Opened)
            }
        }
    }

    fn bind_opened_project(
        &self,
        connection_credential: &str,
        project_root: &str,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        let context = self
            .connections
            .context(connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    StatusCode::CONFLICT,
                    "workbench_connection_invalid",
                    "Workbench connection ended before Project binding.",
                )
            })?;
        let opened = self.open_project_use(project_root, ProjectUseKind::Workbench)?;
        let project_id = opened.session.project_id().to_owned();
        self.remember_recent_project(&opened.session)?;
        if let Some(outcome) = self.desktop_existing_owner_outcome(&context, &project_id)? {
            return Ok(outcome);
        }
        let prepared = self.prepare_project_binding(connection_credential, opened)?;
        let project_session = Arc::clone(&prepared.session);
        let outcome = self
            .connections
            .bind_project(
                connection_credential,
                context.binding_generation,
                ProjectBindingCommit {
                    project_id: project_id.clone(),
                    project_use: prepared.project_use,
                    bound_event: prepared.bound_event,
                },
            )
            .map_err(project_initial_binding_error)?;
        match outcome {
            ProjectBindOutcome::AlreadyBound => {}
            ProjectBindOutcome::Bound {
                generation,
                preempted,
            } => {
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
                if let Err(error) = self.start_connection_project_stream(
                    connection_credential,
                    &project_id,
                    generation,
                    prepared.sender,
                    prepared.subscription,
                ) {
                    self.close_workbench_connection(connection_credential);
                    return Err(error);
                }
            }
        }
        project_session.start_background_file_index();
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                project_id,
                response: prepared.response,
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
        let Some(binding) = owner.desktop else {
            return Ok(None);
        };
        let focused = self
            .runtime_state
            .focus_desktop_window(&binding)
            .map_err(|error| {
                RuntimeHttpServiceError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "desktop_window_focus_failed",
                    error.to_string(),
                )
            })?;
        if !focused {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop_window_focus_failed",
                "Runtime no longer owns the target Desktop window.",
            ));
        }
        Ok(Some(
            WorkbenchProjectBindingOutcome::FocusedExistingDesktop {
                project_id: project_id.to_owned(),
            },
        ))
    }

    fn open_project_use(
        &self,
        project_root: &str,
        kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, RuntimeHttpServiceError> {
        self.projects
            .open_project_deferred(project_root, kind)
            .map_err(RuntimeHttpServiceError::from_project)
    }

    fn remember_recent_project(
        &self,
        session: &ProjectSession,
    ) -> Result<(), RuntimeHttpServiceError> {
        let project_root = session.root().to_str().ok_or_else(|| {
            RuntimeHttpServiceError::new(
                StatusCode::BAD_REQUEST,
                "project_root_invalid",
                "Project root is not valid UTF-8.",
            )
        })?;
        self.global
            .remember_recent_project(session.project_id(), project_root)
            .map_err(RuntimeHttpServiceError::from_global)?;
        Ok(())
    }

    fn prepare_project_binding(
        &self,
        connection_credential: &str,
        opened: OpenProjectSession,
    ) -> Result<PreparedWorkbenchProjectBinding, RuntimeHttpServiceError> {
        let sender = self
            .connections
            .event_sender(connection_credential)
            .ok_or_else(|| {
                RuntimeHttpServiceError::new(
                    StatusCode::CONFLICT,
                    "workbench_connection_invalid",
                    "Workbench connection ended before Project binding.",
                )
            })?;
        let project_id = opened.session.project_id().to_owned();
        let mut subscription = opened
            .session
            .subscribe()
            .map_err(RuntimeHttpServiceError::from_project)?;
        let ProjectStreamItem::Snapshot(sync) = subscription
            .recv()
            .map_err(RuntimeHttpServiceError::from_project)?
        else {
            unreachable!("Project subscription must begin with its snapshot barrier")
        };
        let response = public_project_sync(&sync)?;
        let working_copies = self.working_copies.load(&project_id)?;
        let bound_event = json!({
            "type": "project.bound",
            "project": response,
            "workingCopies": working_copies
        });
        Ok(PreparedWorkbenchProjectBinding {
            session: opened.session,
            project_use: opened.project_use,
            response,
            bound_event,
            sender,
            subscription,
        })
    }

    fn start_connection_project_stream(
        &self,
        connection_credential: &str,
        project_id: &str,
        binding_generation: u64,
        sender: mpsc::Sender<Value>,
        mut subscription: ProjectSubscription,
    ) -> Result<(), RuntimeHttpServiceError> {
        let credential = connection_credential.to_owned();
        let project_id = project_id.to_owned();
        let connections = Arc::clone(&self.connections);
        thread::Builder::new()
            .name("debrute-workbench-project-stream".to_owned())
            .spawn(move || {
                loop {
                    if connections.context(&credential).is_none_or(|context| {
                        context.project_id.as_deref() != Some(&project_id)
                            || context.binding_generation != binding_generation
                    }) {
                        return;
                    }
                    match subscription.recv_timeout(Duration::from_millis(100)) {
                        Ok(Some(item)) => {
                            let Ok(value) = super::routes::project_stream_value(item) else {
                                connections.close_project_stream(
                                    &credential,
                                    &project_id,
                                    binding_generation,
                                );
                                return;
                            };
                            if sender.try_send(value).is_err() {
                                connections.close_project_stream(
                                    &credential,
                                    &project_id,
                                    binding_generation,
                                );
                                return;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {
                            connections.close_project_stream(
                                &credential,
                                &project_id,
                                binding_generation,
                            );
                            return;
                        }
                    }
                }
            })
            .map_err(|error| {
                RuntimeHttpServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workbench_stream_unavailable",
                    error.to_string(),
                )
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
        item_id: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        self.working_copies.clear_feedback(project_id, item_id)
    }

    #[must_use]
    pub fn subscribe_global(&self) -> broadcast::Receiver<GlobalRuntimeEvent> {
        self.global_events.subscribe()
    }

    pub fn discover_project(&self, project_root: &str) -> Result<String, RuntimeHttpServiceError> {
        let opened = self
            .projects
            .open_project_deferred(project_root, ProjectUseKind::Request)
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
                    StatusCode::BAD_REQUEST,
                    "invalid_integration_operation",
                    "Integration operation is not registered.",
                ));
            }
        };
        serde_json::to_value(
            self.global
                .integrations_run_operation(integration_id, operation),
        )
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))
    }
}

impl Drop for WorkbenchRuntimeServices {
    fn drop(&mut self) {
        self.close_all_workbench_connections();
        self.finish_workbench_connection_closer();
        self.shutdown_owned_work();
    }
}

fn desktop_activation_error(error: impl std::fmt::Display) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "desktop_window_activation_failed",
        error.to_string(),
    )
}

fn project_initial_binding_error(error: ProjectBindError) -> RuntimeHttpServiceError {
    project_binding_error(
        error,
        "project_already_bound",
        "Workbench connection already has a Project.",
    )
}

fn project_replacement_error(error: ProjectBindError) -> RuntimeHttpServiceError {
    project_binding_error(
        error,
        "project_binding_stale",
        "Workbench Project binding changed before replacement.",
    )
}

fn project_binding_error(
    error: ProjectBindError,
    stale_code: &'static str,
    stale_message: &'static str,
) -> RuntimeHttpServiceError {
    match error {
        ProjectBindError::Stale => {
            RuntimeHttpServiceError::new(StatusCode::CONFLICT, stale_code, stale_message)
        }
        ProjectBindError::EventQueueUnavailable => RuntimeHttpServiceError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_backpressure",
            "Workbench connection queue is unavailable.",
        ),
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
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            },
            code: error.code(),
            message: error.to_string(),
            details: None,
        }
    }

    pub(crate) fn from_global(error: crate::global::GlobalSettingsError) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "global_runtime_error",
            error.to_string(),
        )
    }

    pub(crate) fn from_photoshop(error: crate::photoshop::PhotoshopError) -> Self {
        let status = match error.code() {
            crate::photoshop::PhotoshopErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            crate::photoshop::PhotoshopErrorCode::SessionInvalid => StatusCode::UNAUTHORIZED,
            crate::photoshop::PhotoshopErrorCode::Busy
            | crate::photoshop::PhotoshopErrorCode::ProjectRevisionChanged => StatusCode::CONFLICT,
            crate::photoshop::PhotoshopErrorCode::DocumentClosed
            | crate::photoshop::PhotoshopErrorCode::ProjectOffline
            | crate::photoshop::PhotoshopErrorCode::TargetDirectoryMissing => StatusCode::NOT_FOUND,
            crate::photoshop::PhotoshopErrorCode::FileTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            crate::photoshop::PhotoshopErrorCode::TargetDirectoryNotVisible
            | crate::photoshop::PhotoshopErrorCode::UnsupportedFileType
            | crate::photoshop::PhotoshopErrorCode::InvalidTransferPayload
            | crate::photoshop::PhotoshopErrorCode::PlaceFailed
            | crate::photoshop::PhotoshopErrorCode::ExportFailed
            | crate::photoshop::PhotoshopErrorCode::ProtocolInvalid => StatusCode::BAD_REQUEST,
        };
        Self::new(status, error.code().as_str(), error.to_string())
    }

    pub(crate) fn serialization(error: &serde_json::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "serialization_failed",
            error.to_string(),
        )
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

pub fn public_project_snapshot(
    snapshot: &crate::project::ProjectSnapshot,
    project_id: &str,
) -> Result<Value, RuntimeHttpServiceError> {
    let projections = snapshot
        .projections
        .iter()
        .map(|projection| public_canvas_projection(projection, project_id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut value = serde_json::to_value(snapshot)
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))?;
    let Some(object) = value.as_object_mut() else {
        return Err(RuntimeHttpServiceError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "serialization_failed",
            "Project snapshot did not serialize to an object.",
        ));
    };
    object.remove("projectRoot");
    let health = object
        .get_mut("health")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "serialization_failed",
                "Project snapshot health did not serialize to an object.",
            )
        })?;
    health.remove("runtimeDataLocation");
    object.insert("projections".to_owned(), Value::Array(projections));
    Ok(value)
}

pub(crate) fn public_canvas_projection(
    projection: &crate::project::CanvasProjection,
    project_id: &str,
) -> Result<Value, RuntimeHttpServiceError> {
    let mut public_projection = projection.clone();
    for node in &mut public_projection.nodes {
        if let crate::project::CanvasNodeAvailability::Available {
            file_url, revision, ..
        } = &mut node.availability
        {
            *file_url = project_file_url(project_id, &node.node.project_relative_path, revision);
        }
        if let Some(presentation) = &mut node.video_presentation {
            for track in &mut presentation.text_tracks {
                track.file_url = Some(project_file_url(
                    project_id,
                    &track.project_relative_path,
                    &track.revision,
                ));
            }
        }
    }
    serde_json::to_value(public_projection)
        .map_err(|error| RuntimeHttpServiceError::serialization(&error))
}

fn project_file_url(project_id: &str, project_relative_path: &str, revision: &str) -> String {
    format!(
        "/api/projects/{}/files/raw/{}?v={}",
        percent_encode_segment(project_id),
        encode_project_path(project_relative_path),
        percent_encode_segment(revision)
    )
}

pub(crate) fn project_response(
    session: &ProjectSession,
    revision: u64,
    body: Value,
) -> Result<Value, RuntimeHttpServiceError> {
    let Value::Object(mut object) = body else {
        return Err(RuntimeHttpServiceError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "serialization_failed",
            "Project command response did not serialize to an object.",
        ));
    };
    object.insert(
        "projectId".to_owned(),
        Value::String(session.project_id().to_owned()),
    );
    object.insert("projectRevision".to_owned(), Value::from(revision));
    Ok(Value::Object(object))
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
    #[cfg(target_os = "macos")]
    {
        Platform::MacOs
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
}
