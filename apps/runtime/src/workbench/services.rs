use std::{
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
    activity::{
        ActivityEvent, ActivityMessage, ActivityProgress, ActivityProjectContext, ActivityService,
        ActivityTaskStatus, ModelRequestKind,
    },
    cli::{CliResult, CliStreamEvent},
    control::RuntimeControlState,
    global::{
        DebruteGlobalSettingsView, GlobalConfigStore, GlobalRuntimeChange, GlobalRuntimeEvent,
        GlobalRuntimeService,
    },
    login::StartAtLoginSetting,
    model_operation::{
        ModelKind, ModelOperationExecution, ModelOperationService, ModelOperationSnapshot,
        OperationState,
    },
    model_request::{ModelArtifactProvenanceStore, ModelRequestExecutor},
    models::ModelCatalog,
    photoshop::{PhotoshopEnableMutationError, PhotoshopGatewayLifecycle, PhotoshopIntegration},
    project::{
        CanvasFeedbackArtifacts, NativeProjectNodeAdapter, OpenProjectSession,
        ProjectNativeShellService, ProjectPathStateReconciler, ProjectSession,
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

enum ProjectWatcherComposition {
    Production,
    #[cfg(feature = "test-support")]
    Deterministic,
}

pub trait RuntimeProductHttpService: Send + Sync {
    fn state(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn check(&self) -> Result<Value, RuntimeHttpServiceError>;
    fn apply(
        self: Arc<Self>,
        input: &Value,
        initiator: ProductUpdateInitiator,
    ) -> Result<Value, RuntimeHttpServiceError>;
    fn remove(self: Arc<Self>, keep_config: bool) -> Result<Value, RuntimeHttpServiceError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProductUpdateInitiator {
    Desktop,
    Browser,
}

pub trait RuntimeCliHttpService: Send + Sync {
    fn run(&self, request: &Value) -> Result<CliResult, RuntimeHttpServiceError>;
    fn submit(&self, request: &Value, input: &[u8]) -> Result<CliResult, RuntimeHttpServiceError>;
    fn run_stream(
        &self,
        request: &Value,
        observer_is_alive: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<RuntimeCliRecordStream, RuntimeHttpServiceError>;
}

pub struct RuntimeCliRecordStream {
    receiver: tokio::sync::mpsc::Receiver<CliStreamEvent>,
}

impl RuntimeCliRecordStream {
    #[must_use]
    pub fn bounded(capacity: usize) -> (tokio::sync::mpsc::Sender<CliStreamEvent>, Self) {
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        (sender, Self { receiver })
    }
}

impl Stream for RuntimeCliRecordStream {
    type Item = CliStreamEvent;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeHttpServiceError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl RuntimeHttpServiceError {
    #[must_use]
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

pub struct BoundWorkbenchProject {
    pub binding_id: String,
    pub canonical_root: String,
    pub response: Value,
}

pub enum WorkbenchProjectBindingOutcome {
    Bound(BoundWorkbenchProject),
    FocusedExistingDesktop { canonical_root: String },
}

struct PreparedWorkbenchProjectBinding {
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
    provenance: Arc<ModelArtifactProvenanceStore>,
    model_operations: Arc<ModelOperationService<ModelRequestExecutor>>,
    photoshop: Arc<PhotoshopIntegration>,
    photoshop_lifecycle: PhotoshopGatewayLifecycle,
    connections: Arc<WorkbenchConnectionRegistry>,
    connection_closer: WorkbenchConnectionCloser,
    global_events: broadcast::Sender<GlobalRuntimeEvent>,
    activity: Arc<ActivityService>,
    activity_events: broadcast::Sender<ActivityEvent>,
    working_copies: Arc<WorkingCopyStore>,
    canvas_source_digests: Arc<crate::project::ProjectSourceDigestResolver>,
}

impl WorkbenchRuntimeServices {
    /// Composes every in-process Runtime authority beneath the final HTTP
    /// adapter. The Workbench launch authority is installed by the listener
    /// before it accepts its first request.
    ///
    /// # Errors
    ///
    /// Returns a typed startup error when the Model catalog, Photoshop
    /// integration, feedback scheduler, or initial global projection cannot
    /// start.
    ///
    /// # Panics
    ///
    /// Panics when an authoritative in-process lock is poisoned.
    pub fn compose(
        debrute_home: impl AsRef<Path>,
        runtime_state: Arc<RuntimeControlState>,
        start_at_login: Arc<dyn StartAtLoginSetting>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        Self::compose_with_project_watcher(
            debrute_home,
            runtime_state,
            start_at_login,
            ProjectWatcherComposition::Production,
        )
    }

    /// Composes Runtime services for integration tests that do not exercise the
    /// operating-system Project watcher contract.
    ///
    /// # Errors
    ///
    /// Returns the same typed composition errors as [`Self::compose`].
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn compose_for_integration_tests(
        debrute_home: impl AsRef<Path>,
        runtime_state: Arc<RuntimeControlState>,
        start_at_login: Arc<dyn StartAtLoginSetting>,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        Self::compose_with_project_watcher(
            debrute_home,
            runtime_state,
            start_at_login,
            ProjectWatcherComposition::Deterministic,
        )
    }

    fn compose_with_project_watcher(
        debrute_home: impl AsRef<Path>,
        runtime_state: Arc<RuntimeControlState>,
        start_at_login: Arc<dyn StartAtLoginSetting>,
        project_watcher: ProjectWatcherComposition,
    ) -> Result<Arc<Self>, RuntimeHttpServiceError> {
        let debrute_home = debrute_home.as_ref().to_path_buf();
        let workers = RuntimeWorkerServices::new();
        let previews = Arc::new(crate::project::ProjectPreviewService::new_with_home(
            &debrute_home,
        ));
        let feedback = Arc::new(
            CanvasFeedbackArtifacts::new(Arc::clone(&previews))
                .map_err(RuntimeHttpServiceError::from_project)?,
        );
        let working_copies = Arc::new(WorkingCopyStore::new(&debrute_home));
        let path_state_reconciler: Arc<dyn ProjectPathStateReconciler> = working_copies.clone();
        let photoshop_holder = Arc::new(Mutex::new(Weak::<PhotoshopIntegration>::new()));
        let project_photoshop_holder = Arc::clone(&photoshop_holder);
        let node_adapter = Arc::new(NativeProjectNodeAdapter::new(Arc::clone(&previews)));
        let on_project_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(photoshop) = project_photoshop_holder
                .lock()
                .expect("Photoshop integration holder lock poisoned")
                .upgrade()
            {
                photoshop.broadcast_projects();
            }
        });
        let projects = match project_watcher {
            ProjectWatcherComposition::Production => ProjectSessionRegistry::with_change_callback_and_path_state(
                &debrute_home,
                node_adapter,
                feedback,
                on_project_change,
                path_state_reconciler,
            ),
            #[cfg(feature = "test-support")]
            ProjectWatcherComposition::Deterministic => {
                ProjectSessionRegistry::with_change_callback_and_deterministic_watcher_and_path_state(
                    &debrute_home,
                    node_adapter,
                    feedback,
                    on_project_change,
                    path_state_reconciler,
                )
            }
        };
        let terminals = TerminalService::new(projects.clone());
        let native_shell = Arc::new(ProjectNativeShellService::new(&workers));
        let catalog = Arc::new(ModelCatalog::bundled());
        let global_store = Arc::new(GlobalConfigStore::new(&debrute_home));
        let global = GlobalRuntimeService::new(
            Arc::clone(&global_store),
            Arc::clone(&catalog),
            start_at_login,
        );
        let provenance = Arc::new(ModelArtifactProvenanceStore::new(&debrute_home));
        let model_request = Arc::new(ModelRequestExecutor::new(
            Arc::clone(&catalog),
            global_store,
            Arc::clone(&provenance),
        ));
        let model_operations = Arc::new(ModelOperationService::new(Arc::clone(&model_request)));
        let activity = Arc::new(ActivityService::new());
        let (activity_events, _) = broadcast::channel(GLOBAL_EVENT_CAPACITY);
        let activity_event_sender = activity_events.clone();
        if !activity.install_observer(Arc::new(move |event| {
            let _ = activity_event_sender.send(event);
        })) {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "activity_observer_unavailable",
                "Runtime Activity observer is already installed.",
            ));
        }
        let model_activity = Arc::clone(&activity);
        if !model_operations.install_observer(Arc::new(move |snapshot| {
            publish_model_operation_activity(&model_activity, &snapshot);
        })) {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "model_operation_observer_unavailable",
                "Model Operation observer is already installed.",
            ));
        }
        let callback_global = Arc::clone(&global);
        let photoshop_enabled = global
            .settings_get()
            .map_err(RuntimeHttpServiceError::from_global)?
            .plugins
            .photoshop
            .enabled;
        let photoshop = Arc::new(PhotoshopIntegration::new(
            runtime_state.instance_id(),
            Arc::clone(&runtime_state),
            projects.clone(),
            Arc::new(move |state| {
                callback_global.publish_external(GlobalRuntimeChange::PhotoshopChanged(state));
            }),
        ));
        photoshop.initialize_enabled(photoshop_enabled);
        let photoshop_lifecycle =
            PhotoshopGatewayLifecycle::start(Arc::clone(&photoshop), photoshop_enabled).map_err(
                |error| {
                    RuntimeHttpServiceError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "photoshop_lifecycle_unavailable",
                        error.to_string(),
                    )
                },
            )?;
        *photoshop_holder
            .lock()
            .expect("Photoshop integration holder lock poisoned") = Arc::downgrade(&photoshop);

        let (global_events, _) = broadcast::channel(GLOBAL_EVENT_CAPACITY);
        let event_sender = global_events.clone();
        let presentation_state = Arc::clone(&runtime_state);
        if !global.install_observer(Arc::new(move |event| {
            match &event.change {
                GlobalRuntimeChange::RecentProjectsChanged(projects) => {
                    presentation_state.set_recent_projects(event.revision, projects.clone());
                }
                GlobalRuntimeChange::GlobalSettingsChanged(settings) => {
                    presentation_state.set_theme_preference(&settings.workbench.theme_preference);
                }
                GlobalRuntimeChange::PhotoshopChanged(_)
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
            provenance,
            model_operations,
            photoshop,
            photoshop_lifecycle,
            connections,
            connection_closer,
            global_events,
            activity,
            activity_events,
            working_copies,
            canvas_source_digests: Arc::new(crate::project::ProjectSourceDigestResolver::default()),
        });
        let (recent_projects, theme_preference) = services
            .global
            .desktop_presentation_snapshot()
            .map_err(RuntimeHttpServiceError::from_global)?;
        services
            .runtime_state
            .set_recent_projects(services.global.revision(), recent_projects.clone());
        services
            .runtime_state
            .set_theme_preference(&theme_preference);
        Ok(services)
    }

    #[must_use]
    pub fn global(&self) -> &Arc<GlobalRuntimeService> {
        &self.global
    }

    pub(crate) fn canvas_source_digests(
        &self,
    ) -> &Arc<crate::project::ProjectSourceDigestResolver> {
        &self.canvas_source_digests
    }

    pub fn settings_mutate(
        &self,
        input: &crate::global::GlobalSettingsMutation,
    ) -> Result<DebruteGlobalSettingsView, RuntimeHttpServiceError> {
        let requested_photoshop_enabled = match input {
            crate::global::GlobalSettingsMutation::SetPhotoshopPluginEnabled { enabled } => {
                Some(*enabled)
            }
            _ => None,
        };
        let Some(enabled) = requested_photoshop_enabled else {
            return self
                .global
                .settings_mutate(input)
                .map_err(RuntimeHttpServiceError::from_global);
        };
        let (view, _) = self
            .photoshop
            .mutate_enabled(
                enabled,
                || self.global.settings_mutate(input),
                || self.photoshop_lifecycle.set_enabled(enabled),
            )
            .map_err(|error| match error {
                PhotoshopEnableMutationError::TransferActive => RuntimeHttpServiceError::new(
                    StatusCode::CONFLICT,
                    "photoshop_transfer_in_progress",
                    "Transfer in progress.",
                ),
                PhotoshopEnableMutationError::Persist(error) => {
                    RuntimeHttpServiceError::from_global(error)
                }
            })?;
        Ok(view)
    }

    #[must_use]
    pub fn activity(&self) -> &Arc<ActivityService> {
        &self.activity
    }

    #[must_use]
    pub fn models(&self) -> &Arc<ModelCatalog> {
        &self.models
    }

    #[must_use]
    pub fn projects(&self) -> &ProjectSessionRegistry {
        &self.projects
    }

    pub fn project_activity_context(
        &self,
        canonical_root: &str,
    ) -> Result<ActivityProjectContext, RuntimeHttpServiceError> {
        let summary = self
            .projects
            .get(Path::new(canonical_root))
            .and_then(|session| session.summary())
            .map_err(RuntimeHttpServiceError::from_project)?;
        Ok(ActivityProjectContext {
            canonical_root: summary.canonical_root,
            project_name: summary.project_name,
        })
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
    pub fn provenance(&self) -> &Arc<ModelArtifactProvenanceStore> {
        &self.provenance
    }

    #[must_use]
    pub fn model_operations(&self) -> &Arc<ModelOperationService<ModelRequestExecutor>> {
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

    #[must_use]
    pub fn runtime_state(&self) -> &Arc<RuntimeControlState> {
        &self.runtime_state
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
        self.bind_unbound_connection_project_root(
            browser_session,
            connection_credential,
            project_root,
            true,
        )
    }

    pub fn bind_initial_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
    ) -> Result<WorkbenchProjectBindingOutcome, RuntimeHttpServiceError> {
        self.bind_unbound_connection_project_root(
            browser_session,
            connection_credential,
            project_root,
            false,
        )
    }

    fn bind_unbound_connection_project_root(
        &self,
        browser_session: &str,
        connection_credential: &str,
        project_root: &str,
        focus_existing_desktop: bool,
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
        if context.binding_id.is_some() {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "project_already_bound",
                "OpenProject requires an unbound Workbench connection.",
            ));
        }
        self.bind_opened_project(connection_credential, project_root, focus_existing_desktop)
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
        let source_binding_id = context.binding_id.clone().ok_or_else(|| {
            RuntimeHttpServiceError::new(
                StatusCode::CONFLICT,
                "project_not_bound",
                "ReplaceProject requires a bound Workbench connection.",
            )
        })?;
        let opened = self.open_project_use(project_root, ProjectUseKind::Workbench)?;
        let canonical_root = canonical_root_string(&opened.session);
        self.remember_recent_project(&opened.session)?;
        let target_binding_id = if context.canonical_root.as_deref() == Some(&canonical_root) {
            source_binding_id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let prepared =
            self.prepare_project_binding(connection_credential, opened, target_binding_id.clone())?;
        let outcome = self
            .connections
            .replace_project(
                connection_credential,
                &source_binding_id,
                context.binding_generation,
                ProjectBindingCommit {
                    binding_id: target_binding_id.clone(),
                    canonical_root: canonical_root.clone(),
                    project_use: prepared.project_use,
                    bound_event: prepared.bound_event,
                },
            )
            .map_err(project_replacement_error)?;
        if outcome == ProjectBindOutcome::AlreadyBound {
            return Ok(WorkbenchProjectBindingOutcome::Bound(
                BoundWorkbenchProject {
                    binding_id: source_binding_id,
                    canonical_root,
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
        if let Some(binding) = context.desktop.as_ref() {
            self.runtime_state.retarget_desktop_window(
                binding,
                crate::control::WorkbenchRoute::OpenProject {
                    canonical_root: canonical_root.clone(),
                },
            );
        }
        if let Some(binding) = preempted.and_then(|connection| connection.desktop) {
            self.runtime_state
                .retarget_desktop_window(&binding, crate::control::WorkbenchRoute::Root);
        }
        if let Err(error) = self.start_connection_project_stream(
            connection_credential,
            &target_binding_id,
            generation,
            prepared.sender,
            prepared.subscription,
        ) {
            self.close_workbench_connection(connection_credential);
            return Err(error);
        }
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                binding_id: target_binding_id,
                canonical_root,
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

    fn bind_opened_project(
        &self,
        connection_credential: &str,
        project_root: &str,
        focus_existing_desktop: bool,
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
        let canonical_root = canonical_root_string(&opened.session);
        let binding_id = uuid::Uuid::new_v4().to_string();
        self.remember_recent_project(&opened.session)?;
        if focus_existing_desktop
            && let Some(outcome) = self.desktop_existing_owner_outcome(&context, &canonical_root)?
        {
            return Ok(outcome);
        }
        let prepared =
            self.prepare_project_binding(connection_credential, opened, binding_id.clone())?;
        let outcome = self
            .connections
            .bind_project(
                connection_credential,
                context.binding_generation,
                ProjectBindingCommit {
                    binding_id: binding_id.clone(),
                    canonical_root: canonical_root.clone(),
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
                        crate::control::WorkbenchRoute::OpenProject {
                            canonical_root: canonical_root.clone(),
                        },
                    );
                }
                if let Some(binding) = preempted.and_then(|connection| connection.desktop) {
                    self.runtime_state
                        .retarget_desktop_window(&binding, crate::control::WorkbenchRoute::Root);
                }
                if let Err(error) = self.start_connection_project_stream(
                    connection_credential,
                    &binding_id,
                    generation,
                    prepared.sender,
                    prepared.subscription,
                ) {
                    self.close_workbench_connection(connection_credential);
                    return Err(error);
                }
            }
        }
        Ok(WorkbenchProjectBindingOutcome::Bound(
            BoundWorkbenchProject {
                binding_id,
                canonical_root,
                response: prepared.response,
            },
        ))
    }

    fn desktop_existing_owner_outcome(
        &self,
        requester: &super::WorkbenchConnectionContext,
        canonical_root: &str,
    ) -> Result<Option<WorkbenchProjectBindingOutcome>, RuntimeHttpServiceError> {
        if requester.desktop.is_none() {
            return Ok(None);
        }
        let Some(owner) = self.connections.project_owner(canonical_root) else {
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
                canonical_root: canonical_root.to_owned(),
            },
        ))
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
                StatusCode::BAD_REQUEST,
                "project_root_invalid",
                "Project root is not valid UTF-8.",
            )
        })?;
        self.global
            .remember_recent_project(project_root)
            .map_err(RuntimeHttpServiceError::from_global)?;
        Ok(())
    }

    fn prepare_project_binding(
        &self,
        connection_credential: &str,
        opened: OpenProjectSession,
        binding_id: String,
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
        let canonical_root = canonical_root_string(&opened.session);
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
        let response = public_project_sync(&sync, &binding_id);
        let working_copies = self.working_copies.load(&canonical_root)?;
        let bound_event = json!({
            "type": "project.bound",
            "project": response,
            "workingCopies": working_copies
        });
        Ok(PreparedWorkbenchProjectBinding {
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
        binding_id: &str,
        binding_generation: u64,
        sender: mpsc::Sender<Value>,
        mut subscription: ProjectSubscription,
    ) -> Result<(), RuntimeHttpServiceError> {
        let credential = connection_credential.to_owned();
        let binding_id = binding_id.to_owned();
        let connections = Arc::clone(&self.connections);
        thread::Builder::new()
            .name("debrute-workbench-project-stream".to_owned())
            .spawn(move || {
                loop {
                    if connections.context(&credential).is_none_or(|context| {
                        context.binding_id.as_deref() != Some(&binding_id)
                            || context.binding_generation != binding_generation
                    }) {
                        return;
                    }
                    match subscription.recv_timeout(Duration::from_millis(100)) {
                        Ok(Some(item)) => {
                            let value = super::routes::project_stream_value(item, &binding_id);
                            if sender.try_send(value).is_err() {
                                connections.close_project_stream(
                                    &credential,
                                    &binding_id,
                                    binding_generation,
                                );
                                return;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {
                            connections.close_project_stream(
                                &credential,
                                &binding_id,
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
        canonical_root: &str,
        working_copy: TextWorkingCopy,
    ) -> Result<TextWorkingCopy, RuntimeHttpServiceError> {
        self.working_copies.put_text(canonical_root, working_copy)
    }

    pub fn clear_text_working_copy(
        &self,
        canonical_root: &str,
        project_relative_path: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        self.working_copies
            .clear_text(canonical_root, project_relative_path)
    }

    pub fn put_feedback_working_copy(
        &self,
        canonical_root: &str,
        working_copy: FeedbackWorkingCopy,
    ) -> Result<FeedbackWorkingCopy, RuntimeHttpServiceError> {
        self.working_copies
            .put_feedback(canonical_root, working_copy)
    }

    pub fn clear_feedback_working_copy(
        &self,
        canonical_root: &str,
        item_id: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        self.working_copies.clear_feedback(canonical_root, item_id)
    }

    #[must_use]
    pub fn subscribe_global(&self) -> broadcast::Receiver<GlobalRuntimeEvent> {
        self.global_events.subscribe()
    }

    #[must_use]
    pub fn subscribe_activity(&self) -> broadcast::Receiver<ActivityEvent> {
        self.activity_events.subscribe()
    }
}

fn publish_model_operation_activity(activity: &ActivityService, snapshot: &ModelOperationSnapshot) {
    let status = match snapshot.state {
        OperationState::Queued | OperationState::Running => ActivityTaskStatus::Running,
        OperationState::Cancelling => ActivityTaskStatus::Cancelling,
        OperationState::Succeeded => ActivityTaskStatus::Succeeded,
        OperationState::Failed => ActivityTaskStatus::Failed,
        OperationState::Cancelled => ActivityTaskStatus::Cancelled,
    };
    let (item_count, mut progress) = match &snapshot.execution {
        ModelOperationExecution::Single { .. } => (1, ActivityProgress::Indeterminate),
        ModelOperationExecution::Batch {
            item_count,
            succeeded,
            failed,
            ..
        } => (
            *item_count,
            ActivityProgress::Determinate {
                completed: succeeded + failed,
                total: *item_count,
            },
        ),
    };
    let model_kind = match snapshot.model_kind {
        ModelKind::Image => ModelRequestKind::Image,
        ModelKind::Video => ModelRequestKind::Video,
        ModelKind::Tts => ModelRequestKind::Tts,
        ModelKind::Music => ModelRequestKind::Music,
        ModelKind::SoundEffect => ModelRequestKind::SoundEffect,
    };
    if status == ActivityTaskStatus::Cancelling {
        progress = ActivityProgress::Indeterminate;
    }
    let _ = activity.upsert_task(
        format!("model-operation:{}", snapshot.id),
        None,
        ActivityMessage::ModelRequest {
            model_kind,
            item_count,
        },
        status,
        progress,
    );
}

impl Drop for WorkbenchRuntimeServices {
    fn drop(&mut self) {
        self.close_all_workbench_connections();
        self.finish_workbench_connection_closer();
        self.shutdown_owned_work();
    }
}

fn canonical_root_string(session: &ProjectSession) -> String {
    session.canonical_root().to_owned()
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
        let code = error.code();
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
            code,
            message: error.to_string(),
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

#[must_use]
pub fn public_project_sync(sync: &ProjectSyncSnapshot, binding_id: &str) -> Value {
    let snapshot = public_project_snapshot(&sync.snapshot, binding_id);
    json!({
        "bindingId": binding_id,
        "canonicalRoot": sync.snapshot.canonical_root,
        "projectRevision": sync.project_revision,
        "snapshot": snapshot
    })
}

#[must_use]
pub fn public_project_snapshot(
    snapshot: &crate::project::ProjectSnapshot,
    binding_id: &str,
) -> Value {
    let canvas_workspace = match &snapshot.canvas_workspace {
        crate::project::CanvasWorkspaceSnapshot::Available {
            workspace,
            canvas_resources,
            feedback_video_resources,
        } => json!({
            "status": "available",
            "workspace": workspace,
            "canvasResources": public_canvas_resource_view(canvas_resources, binding_id),
            "feedbackVideoResources": public_canvas_resource_view(feedback_video_resources, binding_id)
        }),
        crate::project::CanvasWorkspaceSnapshot::Unavailable { code, message } => json!({
            "status": "unavailable",
            "code": code,
            "message": message
        }),
    };
    json!({
        "canonicalRoot": snapshot.canonical_root,
        "projectTree": snapshot.project_tree,
        "canvasWorkspace": canvas_workspace,
        "diagnostics": snapshot.diagnostics,
        "health": {
            "projectName": snapshot.health.project_name,
            "diagnosticCounts": snapshot.health.diagnostic_counts,
            "checkedAt": snapshot.health.checked_at
        }
    })
}

pub(crate) fn public_canvas_resource_view(
    resources: &crate::project::CanvasResourceView,
    binding_id: &str,
) -> crate::project::CanvasResourceView {
    let mut public_resources = resources.clone();
    for resource in &mut public_resources.resources {
        make_canvas_resource_public(resource, binding_id);
    }
    public_resources
}

pub(crate) fn make_canvas_resource_public(
    resource: &mut crate::project::CanvasResource,
    binding_id: &str,
) {
    if let crate::project::CanvasResource::File {
        project_relative_path,
        availability,
        ..
    } = resource
        && let crate::project::CanvasNodeAvailability::Available {
            file_url, revision, ..
        } = availability.as_mut()
    {
        *file_url = project_file_url(binding_id, project_relative_path, revision);
    }
}

pub(crate) fn make_canvas_resolved_source_public(
    source: &mut crate::project::CanvasResolvedSource,
    binding_id: &str,
) {
    if let crate::project::CanvasNodeAvailability::Available {
        file_url, revision, ..
    } = &mut source.availability
    {
        *file_url = project_file_url(binding_id, &source.project_relative_path, revision);
    }
    if let Some(tracks) = &mut source.video_text_tracks {
        for track in tracks {
            track.file_url = Some(project_file_url(
                binding_id,
                &track.project_relative_path,
                &track.revision,
            ));
        }
    }
}

fn project_file_url(binding_id: &str, project_relative_path: &str, revision: &str) -> String {
    format!(
        "/api/workbench/bindings/{}/files/raw/{}?v={}",
        percent_encode_segment(binding_id),
        encode_project_path(project_relative_path),
        percent_encode_segment(revision)
    )
}

pub(crate) fn project_response(
    binding_id: &str,
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
    object.insert("bindingId".to_owned(), Value::String(binding_id.to_owned()));
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

#[cfg(test)]
mod tests {
    use crate::{
        activity::{ActivityPayload, ActivityProgress, ActivityService, ActivityTaskStatus},
        model_operation::{
            ModelKind, ModelOperationExecution, ModelOperationSnapshot, OperationState,
        },
    };

    use super::publish_model_operation_activity;

    #[test]
    fn model_operation_activity_uses_real_batch_progress_and_indeterminate_cancelling() {
        let activity = ActivityService::new();
        let snapshot = |state, succeeded, failed| ModelOperationSnapshot {
            id: "operation-1".to_owned(),
            model_kind: ModelKind::Video,
            state,
            accepted_at: "2026-08-02T00:00:00Z".to_owned(),
            execution: ModelOperationExecution::Batch {
                item_count: 4,
                concurrency: 2,
                timeout_seconds: 60,
                active: 1,
                succeeded,
                failed,
            },
            log: None,
            diagnostics: Vec::new(),
        };

        publish_model_operation_activity(&activity, &snapshot(OperationState::Running, 1, 0));
        let running = activity.sync_snapshot().records.remove(0);
        assert!(matches!(
            running.payload,
            ActivityPayload::Task {
                status: ActivityTaskStatus::Running,
                progress: ActivityProgress::Determinate {
                    completed: 1,
                    total: 4
                },
                ..
            }
        ));

        publish_model_operation_activity(&activity, &snapshot(OperationState::Cancelling, 2, 0));
        let cancelling = activity.sync_snapshot().records.remove(0);
        assert!(matches!(
            cancelling.payload,
            ActivityPayload::Task {
                status: ActivityTaskStatus::Cancelling,
                progress: ActivityProgress::Indeterminate,
                ..
            }
        ));

        publish_model_operation_activity(&activity, &snapshot(OperationState::Succeeded, 3, 1));
        let succeeded = activity.sync_snapshot().records.remove(0);
        assert!(matches!(
            succeeded.payload,
            ActivityPayload::Task {
                status: ActivityTaskStatus::Succeeded,
                progress: ActivityProgress::Determinate {
                    completed: 4,
                    total: 4
                },
                ..
            }
        ));
    }
}
