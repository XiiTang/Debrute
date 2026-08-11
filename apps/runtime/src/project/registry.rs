//! Project-session identity, typed lifetime uses, revisions, and ordered streams.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, Weak, mpsc},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    AdmittedProjectPathEntry, CanonicalProjectRoot, CanvasFeedbackArtifacts,
    CanvasFeedbackDiagnosticUpdate, CanvasFeedbackDocument, CanvasSourceResolutionView,
    CanvasSourceTarget, CanvasStatePatch, CanvasStatePatchOutcome, ProjectChange,
    ProjectDirectoryPath, ProjectError, ProjectEvent, ProjectNativeShellService,
    ProjectNodeAdapter, ProjectPathBatchItemResult, ProjectPathEntry, ProjectPathKind,
    ProjectPathOperationStatus, ProjectRelativePath, ProjectService, ProjectSnapshot,
    ProjectSourceDigestResolver, ProjectSourceLease, ProjectSyncSnapshot, ProjectTextFile,
    ProjectUploadEntry, UpdateCanvasFeedbackInput, copy_project_paths, create_project_path,
    delete_project_paths, import_local_project_paths, import_upload_project_entries,
    move_project_paths, rename_project_path,
    watcher::{
        ProjectFileWatcher, ProjectWatchBackendFactory, ProjectWatchPath, ProjectWatchSignal,
    },
    write_project_text_file,
};

const PROJECT_STREAM_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectUseKind {
    Workbench,
    Request,
    RunningTerminal,
    Transfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionSummary {
    pub canonical_root: String,
    pub project_revision: u64,
    pub project_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRevisionResult<T> {
    pub value: T,
    pub canonical_root: String,
    pub project_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectStreamItem {
    Snapshot(ProjectSyncSnapshot),
    Event(ProjectEvent),
}

struct ProjectMutation<T> {
    value: T,
    change: Option<ProjectChange>,
}

impl<T> ProjectMutation<T> {
    #[must_use]
    fn changed(value: T, change: ProjectChange) -> Self {
        Self {
            value,
            change: Some(change),
        }
    }

    #[must_use]
    fn unchanged(value: T) -> Self {
        Self {
            value,
            change: None,
        }
    }
}

impl ProjectMutation<ProjectCommandResult> {
    fn replace_snapshot(&mut self, snapshot: &ProjectSnapshot) {
        match &mut self.value {
            ProjectCommandResult::Snapshot(current)
            | ProjectCommandResult::TextFileSaved {
                snapshot: current, ..
            }
            | ProjectCommandResult::PathChanged {
                snapshot: current, ..
            }
            | ProjectCommandResult::PathsChanged {
                snapshot: current, ..
            } => current.clone_from(snapshot),
            ProjectCommandResult::CanvasStateUpdated
            | ProjectCommandResult::CanvasFeedbackUpdated { .. } => {}
        }
        match &mut self.change {
            Some(
                ProjectChange::ProjectChanged(current)
                | ProjectChange::ProjectFileChanged {
                    snapshot: current, ..
                },
            ) => current.clone_from(snapshot),
            Some(
                ProjectChange::CanvasStateChanged { .. }
                | ProjectChange::CanvasFeedbackChanged { .. },
            )
            | None => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
/// Closed mutation vocabulary accepted by a revisioned Project session.
///
/// Keeping effectful operations in this enum prevents callers from changing
/// the filesystem without the session deriving the matching revision and event.
pub enum ProjectCommand {
    Refresh,
    Validate,
    LoadDirectory {
        project_relative_directory: ProjectDirectoryPath,
    },
    ResetCanvas,
    PatchCanvasState {
        patch: CanvasStatePatch,
    },
    UpdateCanvasFeedback {
        input: UpdateCanvasFeedbackInput,
    },
    WriteTextFile {
        project_relative_path: ProjectRelativePath,
        content: String,
        expected_revision: String,
    },
    CreatePath {
        parent_project_relative_path: ProjectDirectoryPath,
        name: String,
        kind: ProjectPathKind,
    },
    RenamePath {
        project_relative_path: ProjectRelativePath,
        name: String,
    },
    CopyPaths {
        entries: Vec<AdmittedProjectPathEntry>,
        target_directory: ProjectDirectoryPath,
    },
    MovePaths {
        entries: Vec<AdmittedProjectPathEntry>,
        target_directory: ProjectDirectoryPath,
        overwrite: bool,
    },
    DeletePaths {
        entries: Vec<AdmittedProjectPathEntry>,
    },
    ImportLocalPaths {
        source_paths: Vec<PathBuf>,
        target_directory: ProjectDirectoryPath,
        overwrite: bool,
    },
    ImportUploadEntries {
        entries: Vec<ProjectUploadEntry>,
        target_directory: ProjectDirectoryPath,
        overwrite: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
/// Typed result produced by one successfully accepted [`ProjectCommand`].
pub enum ProjectCommandResult {
    Snapshot(ProjectSnapshot),
    CanvasStateUpdated,
    CanvasFeedbackUpdated {
        feedback: CanvasFeedbackDocument,
    },
    TextFileSaved {
        file: ProjectTextFile,
        snapshot: ProjectSnapshot,
    },
    PathChanged {
        result: ProjectPathEntry,
        snapshot: ProjectSnapshot,
    },
    PathsChanged {
        results: Vec<ProjectPathBatchItemResult>,
        snapshot: ProjectSnapshot,
    },
}

pub struct OpenProjectSession {
    pub session: Arc<ProjectSession>,
    pub project_use: ProjectUse,
}

pub struct ProjectSessionRegistry {
    inner: Arc<ProjectSessionRegistryInner>,
}

pub trait ProjectPathStateReconciler: Send + Sync {
    /// Rewrites or prunes path-keyed Working Copies after a filesystem mutation.
    ///
    /// # Errors
    ///
    /// Returns an error when the ancillary state cannot be persisted. The
    /// already-committed filesystem mutation remains successful.
    fn reconcile(
        &self,
        canonical_root: &str,
        command: &ProjectCommand,
        result: &ProjectCommandResult,
    ) -> Result<(), ProjectError>;

    /// Prunes path-keyed Working Copies after watcher-confirmed removal or
    /// identity replacement.
    ///
    /// # Errors
    ///
    /// Returns an error when the ancillary state cannot be persisted. The
    /// external filesystem change remains authoritative.
    fn prune(&self, canonical_root: &str, removed: &[String]) -> Result<(), ProjectError>;
}

#[cfg(any(test, feature = "test-support"))]
struct NoopProjectPathStateReconciler;

#[cfg(any(test, feature = "test-support"))]
impl ProjectPathStateReconciler for NoopProjectPathStateReconciler {
    fn reconcile(
        &self,
        _canonical_root: &str,
        _command: &ProjectCommand,
        _result: &ProjectCommandResult,
    ) -> Result<(), ProjectError> {
        Ok(())
    }

    fn prune(&self, _canonical_root: &str, _removed: &[String]) -> Result<(), ProjectError> {
        Ok(())
    }
}

struct ProjectSessionRegistryInner {
    debrute_home: PathBuf,
    node_adapter: Arc<dyn ProjectNodeAdapter>,
    feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
    path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
    watch_backend_factory: Arc<dyn ProjectWatchBackendFactory>,
    state: Mutex<ProjectSessionRegistryState>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct ProjectSessionRegistryState {
    closed: bool,
    close_transition: Option<Arc<RootTransition>>,
    sessions_by_root: HashMap<CanonicalProjectRoot, Arc<ProjectSession>>,
    uses_by_root: HashMap<CanonicalProjectRoot, HashMap<Uuid, ProjectUseKind>>,
    transitions_by_root: HashMap<CanonicalProjectRoot, Arc<RootTransition>>,
}

struct RootTransition {
    state: Mutex<RootTransitionState>,
    ready: Condvar,
}

#[derive(Default)]
struct RootTransitionState {
    complete: bool,
    failure: Option<RootTransitionFailure>,
    cleanup_failure: Option<RootTransitionFailure>,
}

#[derive(Clone)]
struct RootTransitionFailure {
    code: &'static str,
    message: String,
}

impl RootTransitionFailure {
    fn from_error(error: &ProjectError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl RootTransition {
    fn new() -> Self {
        Self {
            state: Mutex::new(RootTransitionState::default()),
            ready: Condvar::new(),
        }
    }

    fn finish(
        &self,
        failure: Option<RootTransitionFailure>,
        cleanup_failure: Option<RootTransitionFailure>,
    ) {
        let mut state = self
            .state
            .lock()
            .expect("Project close transition lock poisoned");
        state.failure = failure;
        state.cleanup_failure = cleanup_failure;
        state.complete = true;
        self.ready.notify_all();
    }

    fn wait(&self) -> Result<(), ProjectError> {
        let state = self.wait_complete();
        if let Some(failure) = &state.failure {
            return Err(ProjectError::service(failure.code, &failure.message));
        }
        Ok(())
    }

    fn wait_cleanup(&self) -> Result<(), ProjectError> {
        let state = self.wait_complete();
        if let Some(failure) = &state.cleanup_failure {
            return Err(ProjectError::service(failure.code, &failure.message));
        }
        Ok(())
    }

    fn wait_complete(&self) -> MutexGuard<'_, RootTransitionState> {
        let mut state = lock(&self.state);
        while !state.complete {
            state = self
                .ready
                .wait(state)
                .expect("Project close transition wait lock poisoned");
        }
        state
    }
}

#[cfg(not(test))]
pub(super) fn default_watch_backend_factory() -> Arc<dyn ProjectWatchBackendFactory> {
    Arc::new(super::watcher::NativeProjectWatchBackendFactory)
}

#[cfg(test)]
pub(super) fn default_watch_backend_factory() -> Arc<dyn ProjectWatchBackendFactory> {
    Arc::new(super::watcher::NoopProjectWatchBackendFactory)
}

impl ProjectSessionRegistry {
    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn new(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
    ) -> Self {
        Self::with_change_callback(
            debrute_home,
            node_adapter,
            feedback_artifacts,
            Arc::new(|| {}),
        )
    }

    #[cfg(any(test, feature = "test-support"))]
    #[must_use]
    pub fn with_change_callback(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self::with_dependencies(
            debrute_home,
            node_adapter,
            feedback_artifacts,
            on_change,
            Arc::new(NoopProjectPathStateReconciler),
            default_watch_backend_factory(),
        )
    }

    #[must_use]
    pub fn with_change_callback_and_path_state(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        on_change: Arc<dyn Fn() + Send + Sync>,
        path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
    ) -> Self {
        Self::with_dependencies(
            debrute_home,
            node_adapter,
            feedback_artifacts,
            on_change,
            path_state_reconciler,
            default_watch_backend_factory(),
        )
    }

    #[cfg(feature = "test-support")]
    pub(crate) fn with_change_callback_and_deterministic_watcher_and_path_state(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        on_change: Arc<dyn Fn() + Send + Sync>,
        path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
    ) -> Self {
        Self::with_dependencies(
            debrute_home,
            node_adapter,
            feedback_artifacts,
            on_change,
            path_state_reconciler,
            Arc::new(super::watcher::NoopProjectWatchBackendFactory),
        )
    }

    fn with_dependencies(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        on_change: Arc<dyn Fn() + Send + Sync>,
        path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
        watch_backend_factory: Arc<dyn ProjectWatchBackendFactory>,
    ) -> Self {
        Self {
            inner: Arc::new(ProjectSessionRegistryInner {
                debrute_home: debrute_home.into(),
                node_adapter,
                feedback_artifacts,
                path_state_reconciler,
                watch_backend_factory,
                state: Mutex::new(ProjectSessionRegistryState::default()),
                on_change,
            }),
        }
    }

    /// Opens a canonical Project root, publishes its on-demand Project Tree root,
    /// and atomically issues its first typed Project use.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed, the root cannot be loaded,
    /// or its Project watcher cannot be established.
    pub fn open_project(
        &self,
        project_root: impl AsRef<Path>,
        use_kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, ProjectError> {
        let canonical_root = CanonicalProjectRoot::open_existing(project_root.as_ref())?;
        loop {
            let transition = {
                let mut state = lock(&self.inner.state);
                if state.closed {
                    return Err(ProjectError::RegistryClosed);
                }
                if let Some(session) = state.sessions_by_root.get(&canonical_root).cloned() {
                    let project_use = add_use(&self.inner, &mut state, &canonical_root, use_kind)?;
                    drop(state);
                    (self.inner.on_change)();
                    return Ok(OpenProjectSession {
                        session,
                        project_use,
                    });
                }
                if let Some(transition) = state.transitions_by_root.get(&canonical_root) {
                    Some(Arc::clone(transition))
                } else {
                    state
                        .transitions_by_root
                        .insert(canonical_root.clone(), Arc::new(RootTransition::new()));
                    None
                }
            };
            if let Some(transition) = transition {
                transition.wait()?;
                continue;
            }
            break;
        }

        self.open_new_project(&canonical_root, use_kind)
    }

    fn open_new_project(
        &self,
        canonical_root: &CanonicalProjectRoot,
        use_kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, ProjectError> {
        let opened = ProjectService::prepare_unloaded(
            canonical_root.clone(),
            &self.inner.debrute_home,
            Arc::clone(&self.inner.node_adapter),
        )
        .and_then(|service| {
            let session = Arc::new(ProjectSession::new(
                service,
                Arc::clone(&self.inner.feedback_artifacts),
                Arc::clone(&self.inner.path_state_reconciler),
                Arc::clone(&self.inner.on_change),
            ));
            session.prepare_for_publication(self.inner.watch_backend_factory.as_ref())?;
            Ok(session)
        });
        let mut state = lock(&self.inner.state);
        let transition = state
            .transitions_by_root
            .remove(canonical_root)
            .expect("Project open transition must exist when loading finishes");
        match opened {
            Ok(session) if !state.closed => {
                state
                    .sessions_by_root
                    .insert(canonical_root.clone(), Arc::clone(&session));
                let project_use =
                    add_use(&self.inner, &mut state, canonical_root.as_path(), use_kind)?;
                session.publish();
                self.inner.feedback_artifacts.attach(&session);
                drop(state);
                transition.finish(None, None);
                (self.inner.on_change)();
                Ok(OpenProjectSession {
                    session,
                    project_use,
                })
            }
            Ok(session) => {
                drop(state);
                let close_result = session.close();
                let cleanup_failure = close_result
                    .as_ref()
                    .err()
                    .map(RootTransitionFailure::from_error);
                transition.finish(
                    Some(RootTransitionFailure::from_error(
                        &ProjectError::RegistryClosed,
                    )),
                    cleanup_failure,
                );
                close_result?;
                Err(ProjectError::RegistryClosed)
            }
            Err(error) => {
                let failure = RootTransitionFailure::from_error(&error);
                drop(state);
                transition.finish(Some(failure), None);
                Err(error)
            }
        }
    }

    /// Retains an already-open Project for one explicit Runtime responsibility.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed or the Project is not open.
    pub fn acquire_use(
        &self,
        canonical_root: &Path,
        kind: ProjectUseKind,
    ) -> Result<ProjectUse, ProjectError> {
        let mut state = lock(&self.inner.state);
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        if !state.sessions_by_root.contains_key(canonical_root) {
            return Err(ProjectError::ProjectNotOpen(
                canonical_root.to_string_lossy().into_owned(),
            ));
        }
        let project_use = add_use(&self.inner, &mut state, canonical_root, kind)?;
        drop(state);
        (self.inner.on_change)();
        Ok(project_use)
    }

    /// Resolves an open Project session by canonical root.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed or the Project is not open.
    pub fn get(&self, canonical_root: &Path) -> Result<Arc<ProjectSession>, ProjectError> {
        let state = lock(&self.inner.state);
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        state
            .sessions_by_root
            .get(canonical_root)
            .cloned()
            .ok_or_else(|| {
                ProjectError::ProjectNotOpen(canonical_root.to_string_lossy().into_owned())
            })
    }

    /// Captures summaries for every currently live Project session.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed or a session cannot be read.
    pub fn list(&self) -> Result<Vec<ProjectSessionSummary>, ProjectError> {
        let state = lock(&self.inner.state);
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        let mut summaries = state
            .sessions_by_root
            .values()
            .map(|session| session.summary())
            .collect::<Result<Vec<_>, _>>()?;
        summaries.sort_by(|left, right| left.canonical_root.cmp(&right.canonical_root));
        Ok(summaries)
    }

    /// Irreversibly closes the registry and drains all accepted session work.
    ///
    /// # Errors
    ///
    /// Returns an error if a session, watcher, or concurrent opening fails to close.
    pub fn close(&self) -> Result<(), ProjectError> {
        let (close_transition, sessions, transitions) = {
            let mut state = lock(&self.inner.state);
            if let Some(transition) = &state.close_transition {
                (Arc::clone(transition), None, Vec::new())
            } else {
                state.closed = true;
                let close_transition = Arc::new(RootTransition::new());
                state.close_transition = Some(Arc::clone(&close_transition));
                let sessions: Vec<Arc<ProjectSession>> = state
                    .sessions_by_root
                    .drain()
                    .map(|(_, session)| session)
                    .collect();
                state.uses_by_root.clear();
                let transitions = state
                    .transitions_by_root
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                (close_transition, Some(sessions), transitions)
            }
        };
        let Some(sessions) = sessions else {
            return close_transition.wait();
        };
        let mut failure = None;
        for session in sessions {
            if let Err(error) = session.close() {
                failure.get_or_insert_with(|| RootTransitionFailure::from_error(&error));
            }
        }
        for transition in transitions {
            match transition.wait_cleanup() {
                Ok(()) => {}
                Err(error) => {
                    failure.get_or_insert_with(|| RootTransitionFailure::from_error(&error));
                }
            }
        }
        close_transition.finish(failure.clone(), failure);
        (self.inner.on_change)();
        close_transition.wait()
    }
}

impl Clone for ProjectSessionRegistry {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

pub struct ProjectUse {
    registry: Weak<ProjectSessionRegistryInner>,
    canonical_root: CanonicalProjectRoot,
    use_id: Uuid,
    kind: ProjectUseKind,
}

impl ProjectUse {
    #[must_use]
    pub fn canonical_root(&self) -> &CanonicalProjectRoot {
        &self.canonical_root
    }

    #[must_use]
    pub fn kind(&self) -> ProjectUseKind {
        self.kind
    }

    #[cfg(test)]
    pub(crate) fn detached_for_test(canonical_root: &Path) -> Self {
        Self {
            registry: Weak::new(),
            canonical_root: CanonicalProjectRoot::detached_for_test(canonical_root),
            use_id: Uuid::new_v4(),
            kind: ProjectUseKind::Workbench,
        }
    }
}

impl Drop for ProjectUse {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            release_use(&registry, &self.canonical_root, self.use_id);
        }
    }
}

pub struct ProjectSession {
    root: CanonicalProjectRoot,
    feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
    path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    delivery: Mutex<()>,
    state: Mutex<ProjectSessionState>,
    watcher: Mutex<Option<ProjectFileWatcher>>,
    published: Mutex<bool>,
    publication_ready: Condvar,
}

struct ProjectSessionState {
    service: ProjectService,
    project_revision: u64,
    observers: HashMap<Uuid, mpsc::SyncSender<ProjectEvent>>,
    closed: bool,
}

impl ProjectSession {
    fn new(
        service: ProjectService,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        path_state_reconciler: Arc<dyn ProjectPathStateReconciler>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            root: service.project_root().clone(),
            feedback_artifacts,
            path_state_reconciler,
            on_change,
            delivery: Mutex::new(()),
            watcher: Mutex::new(None),
            published: Mutex::new(false),
            publication_ready: Condvar::new(),
            state: Mutex::new(ProjectSessionState {
                service,
                project_revision: 1,
                observers: HashMap::new(),
                closed: false,
            }),
        }
    }

    #[must_use]
    pub fn canonical_root(&self) -> &str {
        self.root.as_wire()
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    #[must_use]
    pub(crate) fn project_root(&self) -> &CanonicalProjectRoot {
        &self.root
    }

    /// Captures the current Project snapshot and its revision barrier.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn sync_snapshot(&self) -> Result<ProjectSyncSnapshot, ProjectError> {
        let state = self.open_state()?;
        Ok(sync_snapshot(&state))
    }

    /// Resolves exact saved-file sources without creating a Project revision.
    ///
    /// # Errors
    /// Returns a typed error when a target is stale, hidden, or unreadable.
    pub(crate) fn resolve_canvas_sources(
        &self,
        targets: &[CanvasSourceTarget],
        source_digests: &ProjectSourceDigestResolver,
    ) -> Result<CanvasSourceResolutionView, ProjectError> {
        let mut state = self.open_state()?;
        state
            .service
            .resolve_canvas_sources(targets, source_digests)
    }

    pub(crate) fn canvas_source_lease(
        &self,
        project_relative_path: &ProjectRelativePath,
        expected_revision: &str,
    ) -> Result<ProjectSourceLease, ProjectError> {
        let state = self.open_state()?;
        state
            .service
            .canvas_source_lease(project_relative_path, expected_revision)
    }

    /// Captures the current public session summary.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn summary(&self) -> Result<ProjectSessionSummary, ProjectError> {
        let state = self.open_state()?;
        Ok(ProjectSessionSummary {
            canonical_root: self.canonical_root().to_owned(),
            project_revision: state.project_revision,
            project_name: state.service.snapshot().health.project_name.clone(),
        })
    }

    /// Captures the current Canvas feedback document at the Project revision barrier.
    ///
    /// # Errors
    /// Returns an error when the session is closed or the feedback document is invalid.
    pub fn canvas_feedback(
        &self,
    ) -> Result<ProjectRevisionResult<CanvasFeedbackDocument>, ProjectError> {
        let state = self.open_state()?;
        Ok(ProjectRevisionResult {
            value: state.service.canvas_feedback().clone(),
            canonical_root: self.canonical_root().to_owned(),
            project_revision: state.project_revision,
        })
    }

    /// Re-runs only derived feedback artifacts for a newly captured browser video frame.
    ///
    /// # Errors
    /// Returns an error when the session is closed or the scheduler cannot accept the work.
    pub(crate) fn canvas_video_preview_source_saved(
        &self,
        project_relative_path: &str,
        frame_time_ms: u64,
    ) -> Result<(), ProjectError> {
        drop(self.open_state()?);
        self.feedback_artifacts
            .resume_video_frame(&self.root, project_relative_path, frame_time_ms)
            .map_err(|dispatch| dispatch.error)
    }

    /// Applies one asynchronous derived-artifact diagnostic delta as a Project revision.
    ///
    /// # Errors
    /// Returns an error when the Project session is closed or revision-exhausted.
    pub fn apply_canvas_feedback_diagnostics(
        &self,
        update: &CanvasFeedbackDiagnosticUpdate,
    ) -> Result<(), ProjectError> {
        let delivery = lock(&self.delivery);
        let mut state = self.open_state()?;
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let Some(snapshot) = state.service.apply_canvas_feedback_diagnostics(update)? else {
            return Ok(());
        };
        state.project_revision = next_revision;
        let event = ProjectEvent {
            project_revision: state.project_revision,
            change: ProjectChange::ProjectChanged(snapshot),
        };
        publish_event(&mut state, &event);
        drop(state);
        drop(delivery);
        (self.on_change)();
        Ok(())
    }

    /// Commits one serialized mutation against the current Project state.
    ///
    /// # Errors
    /// Returns a stale-revision snapshot, closed-session error, or mutation failure.
    fn commit_mutation_with<T>(
        &self,
        mutation: impl FnOnce(&mut ProjectService) -> Result<ProjectMutation<T>, ProjectError>,
        post_commit: impl FnOnce(&ProjectRevisionResult<T>),
    ) -> Result<ProjectRevisionResult<T>, ProjectError> {
        let delivery = lock(&self.delivery);
        let mut state = self.open_state()?;
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let result = mutation(&mut state.service)?;
        let event = if let Some(change) = result.change {
            state.project_revision = next_revision;
            Some(ProjectEvent {
                project_revision: state.project_revision,
                change,
            })
        } else {
            None
        };
        let changed = event.is_some();
        let revision = state.project_revision;
        if let Some(event) = &event {
            publish_event(&mut state, event);
        }
        let result = ProjectRevisionResult {
            value: result.value,
            canonical_root: self.canonical_root().to_owned(),
            project_revision: revision,
        };
        post_commit(&result);
        drop(state);
        drop(delivery);
        if changed {
            (self.on_change)();
        }
        Ok(result)
    }

    /// Executes one Project command in the session's serialized mutation lane.
    ///
    /// The session, rather than its caller, derives the revision delta and stream
    /// event from the command result. Watcher echoes are refreshed and discarded
    /// when equivalent, avoiding time-of-check/time-of-use receipt suppression.
    ///
    /// # Errors
    /// Returns a stale-revision snapshot, closed-session error, or command failure.
    pub fn execute(
        &self,
        command: ProjectCommand,
    ) -> Result<ProjectRevisionResult<ProjectCommandResult>, ProjectError> {
        let path_command = command.clone();
        let feedback_source = match &command {
            ProjectCommand::UpdateCanvasFeedback { input } => {
                input.rendered_artifact_source_path().map(str::to_owned)
            }
            _ => None,
        };
        let dispatch_error = std::cell::RefCell::new(None);
        let result = self.commit_mutation_with(
            |service| {
                let mut mutation = execute_project_command(service, command)?;
                self.reconcile_path_state_in_mutation(service, &path_command, &mut mutation);
                Ok(mutation)
            },
            |result| {
                if let (
                    Some(project_relative_path),
                    ProjectCommandResult::CanvasFeedbackUpdated { feedback },
                ) = (feedback_source.as_deref(), &result.value)
                {
                    *dispatch_error.borrow_mut() = self
                        .feedback_artifacts
                        .enqueue_source_ordered(
                            &self.root,
                            result.project_revision,
                            project_relative_path,
                            feedback.clone(),
                        )
                        .err();
                }
            },
        )?;
        if let Some(error) = dispatch_error.into_inner() {
            self.feedback_artifacts.report_dispatch_error(&error);
        }
        Ok(result)
    }

    /// Executes one Project command only at the caller's exact revision barrier.
    ///
    /// # Errors
    /// Returns `project_revision_changed` before the command has any effect when
    /// another Project mutation has already advanced the session.
    pub fn execute_at_revision(
        &self,
        expected_revision: u64,
        command: ProjectCommand,
    ) -> Result<ProjectRevisionResult<ProjectCommandResult>, ProjectError> {
        let path_command = command.clone();
        let delivery = lock(&self.delivery);
        let mut state = self.open_state()?;
        if state.project_revision != expected_revision {
            return Err(ProjectError::service(
                "project_revision_changed",
                format!(
                    "Project revision changed from {expected_revision} to {}.",
                    state.project_revision
                ),
            ));
        }
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let mut result = execute_project_command(&mut state.service, command)?;
        self.reconcile_path_state_in_mutation(&mut state.service, &path_command, &mut result);
        let changed = result.change.is_some();
        if let Some(change) = result.change {
            state.project_revision = next_revision;
            let event = ProjectEvent {
                project_revision: state.project_revision,
                change,
            };
            publish_event(&mut state, &event);
        }
        let result = ProjectRevisionResult {
            value: result.value,
            canonical_root: self.canonical_root().to_owned(),
            project_revision: state.project_revision,
        };
        drop(state);
        drop(delivery);
        if changed {
            (self.on_change)();
        }
        Ok(result)
    }

    /// Moves a fully validated Project batch to native trash inside the same
    /// revision admission lane as every filesystem mutation.
    ///
    /// # Errors
    /// Returns a stale revision before any native effect or the exact native
    /// shell error. A refresh failure after trash commits is reported on the
    /// successful result as a diagnostic. Runtime does not automatically retry
    /// a native effect.
    pub fn trash_paths(
        &self,
        native_shell: &ProjectNativeShellService,
        entries: &[ProjectPathEntry],
    ) -> Result<ProjectRevisionResult<ProjectCommandResult>, ProjectError> {
        let command = ProjectCommand::DeletePaths {
            entries: super::admit_project_path_entries(entries.to_vec())?,
        };
        self.commit_mutation_with(
            |service| {
                let trashed = native_shell.trash(service.root(), entries)?;
                let results = trashed
                    .into_iter()
                    .map(|entry| ProjectPathBatchItemResult {
                        source_project_relative_path: entry.project_relative_path.clone(),
                        project_relative_path: entry.project_relative_path,
                        kind: entry.kind,
                        status: ProjectPathOperationStatus::Ok,
                    })
                    .collect::<Vec<_>>();
                let changed_paths = entries
                    .iter()
                    .map(|entry| entry.project_relative_path.clone())
                    .collect::<Vec<_>>();
                let snapshot = service.reconcile_committed_path_mutation(&changed_paths, &[]);
                let mut mutation = ProjectMutation::changed(
                    ProjectCommandResult::PathsChanged {
                        results,
                        snapshot: snapshot.clone(),
                    },
                    ProjectChange::ProjectChanged(snapshot),
                );
                self.reconcile_path_state_in_mutation(service, &command, &mut mutation);
                Ok(mutation)
            },
            |_| {},
        )
    }

    fn reconcile_path_state_in_mutation(
        &self,
        service: &mut ProjectService,
        command: &ProjectCommand,
        mutation: &mut ProjectMutation<ProjectCommandResult>,
    ) {
        if !is_path_state_command(command) {
            return;
        }
        let error = self
            .path_state_reconciler
            .reconcile(self.canonical_root(), command, &mutation.value)
            .err();
        let errors = error.iter().map(ToString::to_string).collect::<Vec<_>>();
        let snapshot = service.complete_path_state_persistence(&errors);
        mutation.replace_snapshot(&snapshot);
    }

    /// Registers an ordered observer and captures its snapshot-first revision barrier.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn subscribe(self: &Arc<Self>) -> Result<ProjectSubscription, ProjectError> {
        let _delivery = lock(&self.delivery);
        let mut state = self.open_state()?;
        let id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(PROJECT_STREAM_CAPACITY);
        state.observers.insert(id, sender);
        Ok(ProjectSubscription {
            session: Arc::downgrade(self),
            id,
            initial: Some(sync_snapshot(&state)),
            receiver,
            released: false,
        })
    }

    fn open_state(&self) -> Result<MutexGuard<'_, ProjectSessionState>, ProjectError> {
        let state = lock(&self.state);
        if state.closed {
            return Err(ProjectError::ProjectNotOpen(
                self.canonical_root().to_owned(),
            ));
        }
        Ok(state)
    }

    fn prepare_for_publication(
        self: &Arc<Self>,
        watch_backend_factory: &dyn ProjectWatchBackendFactory,
    ) -> Result<(), ProjectError> {
        let weak = Arc::downgrade(self);
        let loaded_dependency_session = Arc::downgrade(self);
        let watcher = ProjectFileWatcher::start(
            &self.root,
            watch_backend_factory,
            Arc::new(move |project_relative_path| {
                loaded_dependency_session.upgrade().is_some_and(|session| {
                    lock(&session.state)
                        .service
                        .is_loaded_watch_path(project_relative_path)
                })
            }),
            Arc::new(move |signal| {
                if let Some(session) = weak.upgrade() {
                    session.wait_until_published();
                    let _ = match signal {
                        ProjectWatchSignal::Paths(paths) => {
                            session.apply_watched_file_changes(paths)
                        }
                        ProjectWatchSignal::RescanRequired(message) => {
                            session.apply_watcher_backend_error(message)
                        }
                    };
                }
            }),
        )?;
        *lock(&self.watcher) = Some(watcher);
        let refresh_result = (|| {
            let _delivery = lock(&self.delivery);
            let mut state = self.open_state()?;
            state.service.refresh_loaded_snapshot()?;
            state.project_revision = 1;
            Ok(())
        })();
        if let Err(error) = refresh_result {
            self.publish();
            self.close_watcher();
            return Err(error);
        }
        Ok(())
    }

    fn publish(&self) {
        let mut published = lock(&self.published);
        *published = true;
        self.publication_ready.notify_all();
    }

    fn wait_until_published(&self) {
        let mut published = lock(&self.published);
        while !*published {
            published = self
                .publication_ready
                .wait(published)
                .expect("Project publication wait lock poisoned");
        }
    }

    pub(crate) fn apply_watched_file_changes(
        &self,
        paths: Vec<ProjectWatchPath>,
    ) -> Result<(), ProjectError> {
        self.apply_watched_refresh(&ProjectWatchSignal::Paths(paths))
    }

    fn apply_watcher_backend_error(&self, message: String) -> Result<(), ProjectError> {
        self.apply_watched_refresh(&ProjectWatchSignal::RescanRequired(message))
    }

    // One delivery guard owns the complete refresh transaction.
    fn apply_watched_refresh(&self, signal: &ProjectWatchSignal) -> Result<(), ProjectError> {
        let feedback_source = match signal {
            ProjectWatchSignal::Paths(paths)
                if paths.len() == 1
                    && paths[0].project_relative_path != super::CANVAS_FEEDBACK_PROJECT_PATH =>
            {
                Some(paths[0].project_relative_path.clone())
            }
            ProjectWatchSignal::Paths(_) | ProjectWatchSignal::RescanRequired(_) => None,
        };
        let delivery = lock(&self.delivery);
        let mut state = self.open_state()?;
        if let ProjectWatchSignal::Paths(paths) = signal
            && state.service.watch_paths_match_current_documents(paths)
        {
            return Ok(());
        }
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let previous = state.service.snapshot().clone();
        let diagnostic_path = match signal {
            ProjectWatchSignal::Paths(paths) => paths
                .first()
                .map_or("", |path| path.project_relative_path.as_str()),
            ProjectWatchSignal::RescanRequired(_) => "",
        };
        let refresh_result = match signal {
            ProjectWatchSignal::Paths(paths) => state.service.refresh_watched_paths(paths),
            ProjectWatchSignal::RescanRequired(_) => {
                state.service.refresh_loaded_snapshot_for_watcher()
            }
        };
        let refresh = match refresh_result {
            Ok(refresh) => refresh,
            Err(error) => {
                let message = match signal {
                    ProjectWatchSignal::Paths(_) => error.to_string(),
                    ProjectWatchSignal::RescanRequired(watch_error) => {
                        format!("{watch_error}; loaded Project Tree refresh failed: {error}")
                    }
                };
                if error.leaves_mutation_outcome_uncertain() {
                    let snapshot = state
                        .service
                        .watch_refresh_failed(diagnostic_path, &message);
                    state.project_revision = next_revision;
                    let event = ProjectEvent {
                        project_revision: state.project_revision,
                        change: ProjectChange::ProjectChanged(snapshot),
                    };
                    publish_event(&mut state, &event);
                    drop(state);
                    drop(delivery);
                    (self.on_change)();
                    return Err(error);
                }
                state
                    .service
                    .watch_refresh_failed(diagnostic_path, &message);
                super::service::WatchedProjectRefresh {
                    snapshot: state.service.snapshot().clone(),
                    path_state_invalidated: Vec::new(),
                    path_state_persistence_errors: Vec::new(),
                    refresh_error: None,
                }
            }
        };
        let mut snapshot = if let Some(error) = &refresh.refresh_error {
            let message = match signal {
                ProjectWatchSignal::Paths(_) => error.to_string(),
                ProjectWatchSignal::RescanRequired(watch_error) => {
                    format!("{watch_error}; loaded Project state refresh failed: {error}")
                }
            };
            state
                .service
                .watch_refresh_failed(diagnostic_path, &message)
        } else {
            refresh.snapshot
        };
        if !refresh.path_state_invalidated.is_empty() {
            let mut errors = refresh.path_state_persistence_errors;
            if let Err(error) = self
                .path_state_reconciler
                .prune(self.canonical_root(), &refresh.path_state_invalidated)
            {
                errors.push(error.to_string());
            }
            snapshot = state.service.complete_path_state_persistence(&errors);
        }
        if snapshots_equivalent(&previous, &snapshot) {
            state.service.preserve_public_snapshot(previous);
            let feedback = state.service.canvas_feedback().clone();
            let project_revision = state.project_revision;
            let dispatch_error = match feedback_source.as_deref() {
                Some(source) => self
                    .feedback_artifacts
                    .enqueue_source_ordered(&self.root, project_revision, source, feedback)
                    .err(),
                None => self
                    .feedback_artifacts
                    .enqueue_document_ordered(&self.root, project_revision, feedback)
                    .err(),
            };
            drop(state);
            drop(delivery);
            if let Some(error) = dispatch_error {
                self.feedback_artifacts.report_dispatch_error(&error);
            }
            self.invalidate_image_cache_for_watch_signal(signal);
            return Ok(());
        }
        state.project_revision = next_revision;
        let change = match signal {
            ProjectWatchSignal::Paths(paths) if paths.len() == 1 => {
                ProjectChange::ProjectFileChanged {
                    project_relative_path: paths[0].project_relative_path.clone(),
                    snapshot,
                }
            }
            ProjectWatchSignal::Paths(_) | ProjectWatchSignal::RescanRequired(_) => {
                ProjectChange::ProjectChanged(snapshot)
            }
        };
        let event = ProjectEvent {
            project_revision: state.project_revision,
            change,
        };
        publish_event(&mut state, &event);
        let feedback = state.service.canvas_feedback().clone();
        let project_revision = state.project_revision;
        let dispatch_error = match feedback_source.as_deref() {
            Some(source) => self
                .feedback_artifacts
                .enqueue_source_ordered(&self.root, project_revision, source, feedback)
                .err(),
            None => self
                .feedback_artifacts
                .enqueue_document_ordered(&self.root, project_revision, feedback)
                .err(),
        };
        drop(state);
        drop(delivery);
        (self.on_change)();
        if let Some(error) = dispatch_error {
            self.feedback_artifacts.report_dispatch_error(&error);
        }
        self.invalidate_image_cache_for_watch_signal(signal);
        Ok(())
    }

    fn invalidate_image_cache_for_watch_signal(&self, signal: &ProjectWatchSignal) {
        match signal {
            ProjectWatchSignal::Paths(paths) => {
                for path in paths {
                    match ProjectRelativePath::parse(&path.project_relative_path) {
                        Ok(relative) => self
                            .feedback_artifacts
                            .invalidate_image_cache_source(&self.root, &relative),
                        Err(error) => self
                            .feedback_artifacts
                            .report_runtime_error(&self.root, &error),
                    }
                }
            }
            ProjectWatchSignal::RescanRequired(_) => {
                self.feedback_artifacts.clear_image_cache(&self.root);
            }
        }
    }

    fn unsubscribe(&self, id: Uuid) {
        let mut state = lock(&self.state);
        state.observers.remove(&id);
    }

    fn close(&self) -> Result<(), ProjectError> {
        let delivery = lock(&self.delivery);
        let mut state = lock(&self.state);
        if state.closed {
            drop(state);
            drop(delivery);
            self.publish();
            return self.finalize_close();
        }
        state.closed = true;
        state.observers.clear();
        drop(state);
        drop(delivery);
        self.publish();
        self.finalize_close()
    }

    fn finalize_close(&self) -> Result<(), ProjectError> {
        self.close_watcher();
        let detach_result = self.feedback_artifacts.detach(&self.root);
        if detach_result.is_ok() {
            lock(&self.state).service.release_capability_binding();
        }
        detach_result
    }

    fn close_watcher(&self) {
        let watcher = { lock(&self.watcher).take() };
        if let Some(mut watcher) = watcher {
            watcher.close();
        }
    }
}

pub struct ProjectSubscription {
    session: Weak<ProjectSession>,
    id: Uuid,
    initial: Option<ProjectSyncSnapshot>,
    receiver: mpsc::Receiver<ProjectEvent>,
    released: bool,
}

impl ProjectSubscription {
    /// Receives the initial snapshot first, followed by strictly ordered deltas.
    ///
    /// # Errors
    /// Returns an error after the Project session closes or detaches a slow stream.
    pub fn recv(&mut self) -> Result<ProjectStreamItem, ProjectError> {
        if let Some(snapshot) = self.initial.take() {
            return Ok(ProjectStreamItem::Snapshot(snapshot));
        }
        self.receiver
            .recv()
            .map(ProjectStreamItem::Event)
            .map_err(|_| ProjectError::service("project_stream_closed", "Project stream closed."))
    }

    /// Receives the initial snapshot first, then waits up to `timeout` for one delta.
    ///
    /// # Errors
    /// Returns an error after the Project session closes or detaches a slow stream.
    pub fn recv_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<ProjectStreamItem>, ProjectError> {
        if let Some(snapshot) = self.initial.take() {
            return Ok(Some(ProjectStreamItem::Snapshot(snapshot)));
        }
        match self.receiver.recv_timeout(timeout) {
            Ok(event) => Ok(Some(ProjectStreamItem::Event(event))),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ProjectError::service(
                "project_stream_closed",
                "Project stream closed.",
            )),
        }
    }

    /// Explicitly removes this observer; dropping it has the same effect.
    ///
    pub fn release(mut self) {
        self.release_once();
    }

    fn release_once(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if let Some(session) = self.session.upgrade() {
            session.unsubscribe(self.id);
        }
    }
}

fn execute_project_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    match command {
        ProjectCommand::Refresh => {
            let snapshot = service.refresh()?;
            Ok(project_snapshot_mutation(snapshot))
        }
        ProjectCommand::Validate => {
            let snapshot = service.validate_complete_snapshot()?;
            Ok(ProjectMutation::unchanged(ProjectCommandResult::Snapshot(
                snapshot,
            )))
        }
        ProjectCommand::LoadDirectory {
            project_relative_directory,
        } => {
            let previous = service.snapshot().clone();
            let snapshot = service.load_project_directory(&project_relative_directory)?;
            if snapshots_equivalent(&previous, &snapshot) {
                Ok(ProjectMutation::unchanged(ProjectCommandResult::Snapshot(
                    snapshot,
                )))
            } else {
                Ok(project_snapshot_mutation(snapshot))
            }
        }
        ProjectCommand::ResetCanvas => {
            let snapshot = service.reset_canvas()?;
            Ok(project_snapshot_mutation(snapshot))
        }
        ProjectCommand::PatchCanvasState { patch } => match service.patch_canvas_state(&patch)? {
            CanvasStatePatchOutcome::Unchanged => Ok(ProjectMutation::unchanged(
                ProjectCommandResult::CanvasStateUpdated,
            )),
            CanvasStatePatchOutcome::StateChanged(change) => Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasStateUpdated,
                ProjectChange::CanvasStateChanged { change },
            )),
            CanvasStatePatchOutcome::ProjectChanged(snapshot) => {
                Ok(project_snapshot_mutation(*snapshot))
            }
        },
        ProjectCommand::UpdateCanvasFeedback { input } => {
            let affects_rendered_artifact = input.affects_rendered_artifact();
            let update = service.update_canvas_feedback(&input)?;
            let result = ProjectCommandResult::CanvasFeedbackUpdated {
                feedback: update.feedback.clone(),
            };
            if update.changed {
                Ok(ProjectMutation::changed(
                    result,
                    ProjectChange::CanvasFeedbackChanged {
                        feedback: update.feedback,
                        affects_rendered_artifact,
                    },
                ))
            } else {
                Ok(ProjectMutation::unchanged(result))
            }
        }
        command @ (ProjectCommand::WriteTextFile { .. }
        | ProjectCommand::CreatePath { .. }
        | ProjectCommand::RenamePath { .. }) => execute_single_file_command(service, command),
        command => execute_file_batch_command(service, command),
    }
}

fn is_path_state_command(command: &ProjectCommand) -> bool {
    matches!(
        command,
        ProjectCommand::CreatePath { .. }
            | ProjectCommand::RenamePath { .. }
            | ProjectCommand::CopyPaths { .. }
            | ProjectCommand::MovePaths { .. }
            | ProjectCommand::DeletePaths { .. }
            | ProjectCommand::ImportLocalPaths { .. }
            | ProjectCommand::ImportUploadEntries { .. }
    )
}

fn execute_single_file_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    match command {
        ProjectCommand::WriteTextFile {
            project_relative_path,
            content,
            expected_revision,
        } => {
            let committed = write_project_text_file(
                service.root(),
                &project_relative_path,
                &content,
                &expected_revision,
            )?;
            let snapshot = service
                .reconcile_committed_content_change(&project_relative_path, committed.identity);
            Ok(ProjectMutation::changed(
                ProjectCommandResult::TextFileSaved {
                    file: committed.file,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectFileChanged {
                    project_relative_path: project_relative_path.to_string(),
                    snapshot,
                },
            ))
        }
        ProjectCommand::CreatePath {
            parent_project_relative_path,
            name,
            kind,
        } => {
            let result =
                create_project_path(service.root(), &parent_project_relative_path, &name, kind)?;
            let path = result.project_relative_path.clone();
            let snapshot =
                service.reconcile_committed_path_mutation(std::slice::from_ref(&path), &[]);
            Ok(ProjectMutation::changed(
                ProjectCommandResult::PathChanged {
                    result,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        ProjectCommand::RenamePath {
            project_relative_path,
            name,
        } => {
            let result = rename_project_path(service.root(), &project_relative_path, &name)?;
            let target = result.project_relative_path.clone();
            let snapshot = service.reconcile_committed_path_mutation(
                std::slice::from_ref(&target),
                &[(project_relative_path.into_string(), target.clone())],
            );
            Ok(ProjectMutation::changed(
                ProjectCommandResult::PathChanged {
                    result,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        _ => unreachable!("non-file command reached the single-file executor"),
    }
}

fn execute_file_batch_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    let (results, removed, rewrites) = match command {
        ProjectCommand::CopyPaths {
            entries,
            target_directory,
        } => {
            let results = copy_project_paths(service.root(), &entries, &target_directory)?;
            let removed = result_project_paths(&results).collect();
            (results, removed, Vec::new())
        }
        ProjectCommand::MovePaths {
            entries,
            target_directory,
            overwrite,
        } => {
            let results =
                move_project_paths(service.root(), &entries, &target_directory, overwrite)?;
            let rewrites = results
                .iter()
                .filter(|result| result.status == ProjectPathOperationStatus::Ok)
                .filter(|result| {
                    result.source_project_relative_path != result.project_relative_path
                })
                .map(|result| {
                    (
                        result.source_project_relative_path.clone(),
                        result.project_relative_path.clone(),
                    )
                })
                .collect::<Vec<_>>();
            let removed = rewrites.iter().map(|(_, target)| target.clone()).collect();
            (results, removed, rewrites)
        }
        ProjectCommand::DeletePaths { entries } => {
            let removed = entries_project_paths(&entries);
            let results = delete_project_paths(service.root(), &entries)?;
            (results, removed, Vec::new())
        }
        ProjectCommand::ImportLocalPaths {
            source_paths,
            target_directory,
            overwrite,
        } => {
            let results = import_local_project_paths(
                service.root(),
                &source_paths,
                &target_directory,
                overwrite,
            )?;
            let removed = result_project_paths(&results).collect();
            (results, removed, Vec::new())
        }
        ProjectCommand::ImportUploadEntries {
            entries,
            target_directory,
            overwrite,
        } => {
            let results = import_upload_project_entries(
                service.root(),
                &entries,
                &target_directory,
                overwrite,
            )?;
            let removed = result_project_paths(&results).collect();
            (results, removed, Vec::new())
        }
        _ => unreachable!("non-batch command reached the file batch executor"),
    };
    let snapshot = service.reconcile_committed_path_mutation(&removed, &rewrites);
    Ok(ProjectMutation::changed(
        ProjectCommandResult::PathsChanged {
            results,
            snapshot: snapshot.clone(),
        },
        ProjectChange::ProjectChanged(snapshot),
    ))
}

fn project_snapshot_mutation(snapshot: ProjectSnapshot) -> ProjectMutation<ProjectCommandResult> {
    ProjectMutation::changed(
        ProjectCommandResult::Snapshot(snapshot.clone()),
        ProjectChange::ProjectChanged(snapshot),
    )
}

fn entries_project_paths(entries: &[AdmittedProjectPathEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.project_relative_path.to_string())
        .collect()
}

fn result_project_paths(
    results: &[ProjectPathBatchItemResult],
) -> impl Iterator<Item = String> + '_ {
    results
        .iter()
        .map(|result| result.project_relative_path.clone())
}

fn publish_event(state: &mut ProjectSessionState, event: &ProjectEvent) {
    let failed = state
        .observers
        .iter()
        .filter_map(|(id, sender)| match sender.try_send(event.clone()) {
            Ok(()) => None,
            Err(mpsc::TrySendError::Full(_) | mpsc::TrySendError::Disconnected(_)) => Some(*id),
        })
        .collect::<Vec<_>>();
    for id in failed {
        state.observers.remove(&id);
    }
}

impl Drop for ProjectSubscription {
    fn drop(&mut self) {
        self.release_once();
    }
}

fn add_use(
    registry: &Arc<ProjectSessionRegistryInner>,
    state: &mut ProjectSessionRegistryState,
    canonical_root: &Path,
    kind: ProjectUseKind,
) -> Result<ProjectUse, ProjectError> {
    let canonical_root = state
        .sessions_by_root
        .get_key_value(canonical_root)
        .map(|(canonical_root, _)| canonical_root.clone())
        .ok_or_else(|| {
            ProjectError::ProjectNotOpen(canonical_root.to_string_lossy().into_owned())
        })?;
    let use_id = Uuid::new_v4();
    state
        .uses_by_root
        .entry(canonical_root.clone())
        .or_default()
        .insert(use_id, kind);
    Ok(ProjectUse {
        registry: Arc::downgrade(registry),
        canonical_root,
        use_id,
        kind,
    })
}

fn release_use(
    registry: &Arc<ProjectSessionRegistryInner>,
    canonical_root: &CanonicalProjectRoot,
    use_id: Uuid,
) {
    let closing = {
        let mut state = registry
            .state
            .lock()
            .expect("Project registry lock poisoned");
        let Some(project_uses) = state.uses_by_root.get_mut(canonical_root) else {
            return;
        };
        if project_uses.remove(&use_id).is_none() || !project_uses.is_empty() {
            return;
        }
        state.uses_by_root.remove(canonical_root);
        let Some(session) = state.sessions_by_root.remove(canonical_root) else {
            return;
        };
        let transition = Arc::new(RootTransition::new());
        state
            .transitions_by_root
            .insert(session.project_root().clone(), Arc::clone(&transition));
        Some((session, transition))
    };
    if let Some((session, transition)) = closing {
        let close_result = session.close();
        let failure = close_result
            .as_ref()
            .err()
            .map(RootTransitionFailure::from_error);
        if failure.is_none() {
            registry
                .state
                .lock()
                .expect("Project registry lock poisoned")
                .transitions_by_root
                .remove(session.project_root());
        }
        transition.finish(failure.clone(), failure);
    }
    (registry.on_change)();
}

fn sync_snapshot(state: &ProjectSessionState) -> ProjectSyncSnapshot {
    ProjectSyncSnapshot {
        project_revision: state.project_revision,
        snapshot: state.service.snapshot().clone(),
    }
}

fn snapshots_equivalent(left: &ProjectSnapshot, right: &ProjectSnapshot) -> bool {
    left.canonical_root == right.canonical_root
        && left.canvas_workspace == right.canvas_workspace
        && left.project_tree == right.project_tree
        && left.diagnostics == right.diagnostics
        && left.health.project_name == right.health.project_name
        && left.health.diagnostic_counts == right.health.diagnostic_counts
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().expect("Project session lock poisoned")
}
