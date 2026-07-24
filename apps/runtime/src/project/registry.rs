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
    CanvasDocument, CanvasFeedbackArtifacts, CanvasFeedbackDiagnosticUpdate,
    CanvasFeedbackDocument, CanvasMapPathRuleSet, CanvasNodeLayoutUpdate, CanvasProjection,
    CanvasTextViewportUpdate, CanvasVideoPlaybackUpdate, ProjectChange, ProjectError, ProjectEvent,
    ProjectNativePathEntry, ProjectNativeShellService, ProjectNodeAdapter, ProjectPathBatchEntry,
    ProjectPathBatchItemResult, ProjectPathKind, ProjectPathOperationResult,
    ProjectPathOperationStatus, ProjectService, ProjectSnapshot, ProjectSyncSnapshot,
    ProjectTextFile, ProjectUploadEntry, UpdateCanvasFeedbackEntryInput, copy_project_paths,
    create_project_path, delete_project_paths, import_local_project_paths,
    import_upload_project_entries, move_project_paths, rename_project_path,
    watcher::{ProjectFileWatcher, ProjectWatchSignal},
    write_project_text_file,
};

const PROJECT_STREAM_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectUseKind {
    Workbench,
    Request,
    Operation,
    RunningTerminal,
    Transfer,
    PhotoshopLink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionSummary {
    pub project_id: String,
    pub project_revision: u64,
    pub project_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRevisionResult<T> {
    pub value: T,
    pub project_id: String,
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

#[derive(Debug, Clone, PartialEq)]
/// Closed mutation vocabulary accepted by a revisioned Project session.
///
/// Keeping effectful operations in this enum prevents callers from changing
/// the filesystem without the session deriving the matching revision and event.
pub enum ProjectCommand {
    Refresh,
    CreateCanvas,
    RenameCanvas {
        canvas_id: String,
        name: String,
    },
    ReorderCanvases {
        order: Vec<String>,
    },
    DeleteCanvas {
        canvas_id: String,
    },
    RepairCanvasRegistry,
    UpdateCanvasLayouts {
        canvas_id: String,
        updates: Vec<CanvasNodeLayoutUpdate>,
    },
    BringCanvasNodeToFront {
        canvas_id: String,
        project_relative_path: String,
    },
    UpdateCanvasVideoPlayback {
        canvas_id: String,
        updates: Vec<CanvasVideoPlaybackUpdate>,
    },
    UpdateCanvasTextViewports {
        canvas_id: String,
        updates: Vec<CanvasTextViewportUpdate>,
    },
    UpdateCanvasFeedback {
        input: UpdateCanvasFeedbackEntryInput,
    },
    PushCanvasMap {
        canvas_id: String,
    },
    AddProjectPathToCanvasMap {
        canvas_id: String,
        project_relative_path: String,
    },
    ResetCanvasLayout {
        canvas_id: String,
        rules: Option<CanvasMapPathRuleSet>,
    },
    WriteTextFile {
        project_relative_path: String,
        content: String,
        expected_revision: String,
    },
    CreatePath {
        parent_project_relative_path: String,
        name: String,
        kind: ProjectPathKind,
    },
    RenamePath {
        project_relative_path: String,
        name: String,
    },
    CopyPaths {
        entries: Vec<ProjectPathBatchEntry>,
        target_directory: String,
    },
    MovePaths {
        entries: Vec<ProjectPathBatchEntry>,
        target_directory: String,
        overwrite: bool,
    },
    DeletePaths {
        entries: Vec<ProjectPathBatchEntry>,
    },
    ImportLocalPaths {
        source_paths: Vec<PathBuf>,
        target_directory: String,
        overwrite: bool,
    },
    ImportUploadEntries {
        entries: Vec<ProjectUploadEntry>,
        target_directory: String,
        overwrite: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
/// Typed result produced by one successfully accepted [`ProjectCommand`].
pub enum ProjectCommandResult {
    Snapshot(ProjectSnapshot),
    CanvasCreated {
        canvas_id: String,
        snapshot: ProjectSnapshot,
    },
    CanvasDeleted {
        active_canvas_id: String,
        snapshot: ProjectSnapshot,
    },
    CanvasRegistryRepaired {
        active_canvas_id: String,
        snapshot: ProjectSnapshot,
    },
    CanvasChanged {
        canvas: CanvasDocument,
        projection: CanvasProjection,
        changed: bool,
    },
    CanvasMapPathAdded {
        canvas: CanvasDocument,
        projection: CanvasProjection,
        project_relative_path: String,
    },
    CanvasLayoutReset {
        canvas: CanvasDocument,
        projection: CanvasProjection,
        reset_count: usize,
    },
    CanvasFeedbackUpdated {
        feedback: CanvasFeedbackDocument,
    },
    TextFileSaved {
        file: ProjectTextFile,
        snapshot: ProjectSnapshot,
    },
    PathChanged {
        result: ProjectPathOperationResult,
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

struct ProjectSessionRegistryInner {
    debrute_home: PathBuf,
    node_adapter: Arc<dyn ProjectNodeAdapter>,
    feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
    state: Mutex<ProjectSessionRegistryState>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

#[derive(Default)]
struct ProjectSessionRegistryState {
    closed: bool,
    close_transition: Option<Arc<RootTransition>>,
    sessions_by_id: HashMap<String, Arc<ProjectSession>>,
    project_ids_by_root: HashMap<PathBuf, String>,
    uses_by_project: HashMap<String, HashMap<Uuid, ProjectUseKind>>,
    transitions_by_root: HashMap<PathBuf, Arc<RootTransition>>,
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
    ) -> Result<(), ProjectError> {
        let mut state = lock(&self.state)?;
        state.failure = failure;
        state.cleanup_failure = cleanup_failure;
        state.complete = true;
        self.ready.notify_all();
        Ok(())
    }

    fn wait(&self) -> Result<(), ProjectError> {
        let state = self.wait_complete()?;
        if let Some(failure) = &state.failure {
            return Err(ProjectError::service(failure.code, &failure.message));
        }
        Ok(())
    }

    fn wait_cleanup(&self) -> Result<(), ProjectError> {
        let state = self.wait_complete()?;
        if let Some(failure) = &state.cleanup_failure {
            return Err(ProjectError::service(failure.code, &failure.message));
        }
        Ok(())
    }

    fn wait_complete(&self) -> Result<MutexGuard<'_, RootTransitionState>, ProjectError> {
        let mut state = lock(&self.state)?;
        while !state.complete {
            state = self
                .ready
                .wait(state)
                .map_err(|_| ProjectError::StatePoisoned)?;
        }
        Ok(state)
    }
}

impl ProjectSessionRegistry {
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

    #[must_use]
    pub fn with_change_callback(
        debrute_home: impl Into<PathBuf>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(ProjectSessionRegistryInner {
                debrute_home: debrute_home.into(),
                node_adapter,
                feedback_artifacts,
                state: Mutex::new(ProjectSessionRegistryState::default()),
                on_change,
            }),
        }
    }

    /// Opens a canonical Project root and atomically issues its first typed Project use.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed, the root cannot be initialized,
    /// or its Project watcher cannot be established.
    pub fn open_project(
        &self,
        project_root: impl AsRef<Path>,
        use_kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, ProjectError> {
        let requested_root = project_root.as_ref();
        let canonical_root = requested_root.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::ProjectNotFound(requested_root.to_string_lossy().into_owned())
            } else {
                ProjectError::from(error)
            }
        })?;
        loop {
            let transition = {
                let mut state = lock(&self.inner.state)?;
                if state.closed {
                    return Err(ProjectError::RegistryClosed);
                }
                if let Some(project_id) = state.project_ids_by_root.get(&canonical_root).cloned()
                    && let Some(session) = state.sessions_by_id.get(&project_id).cloned()
                {
                    session.require_use_admission()?;
                    let project_use = add_use(&self.inner, &mut state, &project_id, use_kind)?;
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

        self.open_new_project(canonical_root, use_kind)
    }

    fn open_new_project(
        &self,
        canonical_root: PathBuf,
        use_kind: ProjectUseKind,
    ) -> Result<OpenProjectSession, ProjectError> {
        let opened = ProjectService::open(
            &canonical_root,
            &self.inner.debrute_home,
            Arc::clone(&self.inner.node_adapter),
        )
        .and_then(|service| {
            let project_id = service.snapshot().metadata.project.id.clone();
            let session = Arc::new(ProjectSession::new(
                project_id,
                service,
                Arc::clone(&self.inner.feedback_artifacts),
            ));
            session.prepare_for_publication()?;
            Ok(session)
        });
        let mut state = lock(&self.inner.state)?;
        let transition = state
            .transitions_by_root
            .remove(&canonical_root)
            .ok_or(ProjectError::StatePoisoned)?;
        match opened {
            Ok(session) if !state.closed => {
                let project_id = session.project_id.clone();
                if state.sessions_by_id.contains_key(&project_id) {
                    drop(state);
                    let error = ProjectError::service(
                        "duplicate_project_id",
                        "Another Project root has the same stable Project id",
                    );
                    let cleanup_failure = session
                        .close()
                        .err()
                        .map(|cleanup| RootTransitionFailure::from_error(&cleanup));
                    transition.finish(
                        Some(RootTransitionFailure::from_error(&error)),
                        cleanup_failure,
                    )?;
                    return Err(error);
                }
                state
                    .project_ids_by_root
                    .insert(canonical_root, project_id.clone());
                state
                    .sessions_by_id
                    .insert(project_id.clone(), Arc::clone(&session));
                let project_use = add_use(&self.inner, &mut state, &project_id, use_kind)?;
                session.publish()?;
                self.inner.feedback_artifacts.attach(&session);
                drop(state);
                transition.finish(None, None)?;
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
                )?;
                close_result?;
                Err(ProjectError::RegistryClosed)
            }
            Err(error) => {
                let failure = RootTransitionFailure::from_error(&error);
                drop(state);
                transition.finish(Some(failure), None)?;
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
        project_id: &str,
        kind: ProjectUseKind,
    ) -> Result<ProjectUse, ProjectError> {
        let mut state = lock(&self.inner.state)?;
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        let session = state
            .sessions_by_id
            .get(project_id)
            .ok_or_else(|| ProjectError::ProjectNotOpen(project_id.to_owned()))?;
        session.require_use_admission()?;
        let project_use = add_use(&self.inner, &mut state, project_id, kind)?;
        drop(state);
        (self.inner.on_change)();
        Ok(project_use)
    }

    /// Resolves an open Project session by its opaque Runtime id.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed or the Project is not open.
    pub fn get(&self, project_id: &str) -> Result<Arc<ProjectSession>, ProjectError> {
        let state = lock(&self.inner.state)?;
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        state
            .sessions_by_id
            .get(project_id)
            .cloned()
            .ok_or_else(|| ProjectError::ProjectNotOpen(project_id.to_owned()))
    }

    /// Captures summaries for every currently live Project session.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry is closed or a session cannot be read.
    pub fn list(&self) -> Result<Vec<ProjectSessionSummary>, ProjectError> {
        let state = lock(&self.inner.state)?;
        if state.closed {
            return Err(ProjectError::RegistryClosed);
        }
        let mut summaries = state
            .sessions_by_id
            .values()
            .map(|session| session.summary())
            .collect::<Result<Vec<_>, _>>()?;
        summaries.sort_by(|left, right| left.project_id.cmp(&right.project_id));
        Ok(summaries)
    }

    /// Irreversibly closes the registry and drains all accepted session work.
    ///
    /// # Errors
    ///
    /// Returns an error if a session, watcher, or concurrent opening fails to close.
    pub fn close(&self) -> Result<(), ProjectError> {
        let (close_transition, sessions, transitions) = {
            let mut state = lock(&self.inner.state)?;
            if let Some(transition) = &state.close_transition {
                (Arc::clone(transition), None, Vec::new())
            } else {
                state.closed = true;
                let close_transition = Arc::new(RootTransition::new());
                state.close_transition = Some(Arc::clone(&close_transition));
                let sessions: Vec<Arc<ProjectSession>> = state
                    .sessions_by_id
                    .drain()
                    .map(|(_, session)| session)
                    .collect();
                state.project_ids_by_root.clear();
                state.uses_by_project.clear();
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
        close_transition.finish(failure.clone(), failure)?;
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
    project_id: String,
    use_id: Uuid,
    kind: ProjectUseKind,
    released: bool,
}

impl ProjectUse {
    #[must_use]
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    #[must_use]
    pub fn kind(&self) -> ProjectUseKind {
        self.kind
    }

    /// Explicitly releases this Project use; dropping it has the same effect.
    ///
    /// # Errors
    ///
    /// Returns an error if final Project-use cleanup fails.
    pub fn release(mut self) -> Result<(), ProjectError> {
        self.release_once()
    }

    fn release_once(&mut self) -> Result<(), ProjectError> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        let Some(registry) = self.registry.upgrade() else {
            return Ok(());
        };
        release_use(&registry, &self.project_id, self.use_id)
    }
}

impl Drop for ProjectUse {
    fn drop(&mut self) {
        let _ = self.release_once();
    }
}

pub struct ProjectSession {
    project_id: String,
    root: PathBuf,
    feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
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
    mutation_poisoned: bool,
    closed: bool,
}

impl ProjectSession {
    fn new(
        project_id: String,
        service: ProjectService,
        feedback_artifacts: Arc<CanvasFeedbackArtifacts>,
    ) -> Self {
        Self {
            project_id,
            root: service.root().to_path_buf(),
            feedback_artifacts,
            delivery: Mutex::new(()),
            watcher: Mutex::new(None),
            published: Mutex::new(false),
            publication_ready: Condvar::new(),
            state: Mutex::new(ProjectSessionState {
                service,
                project_revision: 1,
                observers: HashMap::new(),
                mutation_poisoned: false,
                closed: false,
            }),
        }
    }

    #[must_use]
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Captures the current Project snapshot and its revision barrier.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn sync_snapshot(&self) -> Result<ProjectSyncSnapshot, ProjectError> {
        let state = self.open_state()?;
        Ok(sync_snapshot(&self.project_id, &state))
    }

    /// Captures the current public session summary.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn summary(&self) -> Result<ProjectSessionSummary, ProjectError> {
        let state = self.open_state()?;
        Ok(ProjectSessionSummary {
            project_id: self.project_id.clone(),
            project_revision: state.project_revision,
            project_name: state.service.snapshot().metadata.project.name.clone(),
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
            value: state.service.canvas_feedback()?.clone(),
            project_id: self.project_id.clone(),
            project_revision: state.project_revision,
        })
    }

    /// Applies one asynchronous derived-artifact diagnostic delta as a Project revision.
    ///
    /// # Errors
    /// Returns an error when the Project session is closed, poisoned, or revision-exhausted.
    pub fn apply_canvas_feedback_diagnostics(
        &self,
        update: &CanvasFeedbackDiagnosticUpdate,
    ) -> Result<(), ProjectError> {
        let _delivery = lock(&self.delivery)?;
        let mut state = self.open_state()?;
        if state.mutation_poisoned {
            return Err(mutation_poisoned_error());
        }
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let Some(snapshot) = state.service.apply_canvas_feedback_diagnostics(update) else {
            return Ok(());
        };
        state.project_revision = next_revision;
        let event = ProjectEvent {
            project_id: self.project_id.clone(),
            project_revision: state.project_revision,
            change: ProjectChange::ProjectChanged(snapshot),
        };
        publish_event(&mut state, &event);
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
        let _delivery = lock(&self.delivery)?;
        let mut state = self.open_state()?;
        if state.mutation_poisoned {
            return Err(mutation_poisoned_error());
        }
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let result = match mutation(&mut state.service) {
            Ok(result) => result,
            Err(error) => {
                if error.leaves_mutation_outcome_uncertain() {
                    // The visible filesystem outcome is no longer knowable. Keep the exact
                    // failure for this command and reject every later mutation in this session;
                    // Releasing its final Project use is the only recovery boundary.
                    state.mutation_poisoned = true;
                }
                return Err(error);
            }
        };
        let event = if let Some(change) = result.change {
            state.project_revision = next_revision;
            Some(ProjectEvent {
                project_id: self.project_id.clone(),
                project_revision: state.project_revision,
                change,
            })
        } else {
            None
        };
        let revision = state.project_revision;
        if let Some(event) = &event {
            publish_event(&mut state, event);
        }
        let result = ProjectRevisionResult {
            value: result.value,
            project_id: self.project_id.clone(),
            project_revision: revision,
        };
        post_commit(&result);
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
        let feedback_source = match &command {
            ProjectCommand::UpdateCanvasFeedback { input } if input.affects_rendered_artifact() => {
                Some(input.project_relative_path().to_owned())
            }
            _ => None,
        };
        let dispatch_error = std::cell::RefCell::new(None);
        let result = self.commit_mutation_with(
            |service| execute_project_command(service, command),
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

    /// Moves a fully validated Project batch to native trash inside the same
    /// revision admission lane as every filesystem mutation.
    ///
    /// # Errors
    /// Returns a stale revision before any native effect, or the exact native
    /// shell/refresh error. An outcome-unknown native failure poisons the
    /// session instead of permitting an automatic retry.
    pub fn trash_paths(
        &self,
        native_shell: &ProjectNativeShellService,
        entries: &[ProjectNativePathEntry],
    ) -> Result<ProjectRevisionResult<ProjectCommandResult>, ProjectError> {
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
                let snapshot = service.refresh()?;
                Ok(ProjectMutation::changed(
                    ProjectCommandResult::PathsChanged {
                        results,
                        snapshot: snapshot.clone(),
                    },
                    ProjectChange::ProjectChanged(snapshot),
                ))
            },
            |_| {},
        )
    }

    /// Registers an ordered observer and captures its snapshot-first revision barrier.
    ///
    /// # Errors
    ///
    /// Returns an error if the Project has closed or its state is unavailable.
    pub fn subscribe(self: &Arc<Self>) -> Result<ProjectSubscription, ProjectError> {
        let _delivery = lock(&self.delivery)?;
        let mut state = self.open_state()?;
        let id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(PROJECT_STREAM_CAPACITY);
        state.observers.insert(id, sender);
        Ok(ProjectSubscription {
            session: Arc::downgrade(self),
            id,
            initial: Some(sync_snapshot(&self.project_id, &state)),
            receiver,
            released: false,
        })
    }

    /// Explicitly refreshes the Project as one revisioned mutation.
    ///
    /// # Errors
    /// Returns a stale-revision, closed-session, filesystem, or validation error.
    pub fn refresh(&self) -> Result<ProjectRevisionResult<ProjectSnapshot>, ProjectError> {
        let result = self.execute(ProjectCommand::Refresh)?;
        let ProjectCommandResult::Snapshot(snapshot) = result.value else {
            return Err(ProjectError::StatePoisoned);
        };
        Ok(ProjectRevisionResult {
            value: snapshot,
            project_id: result.project_id,
            project_revision: result.project_revision,
        })
    }

    fn open_state(&self) -> Result<MutexGuard<'_, ProjectSessionState>, ProjectError> {
        let state = lock(&self.state)?;
        if state.closed {
            return Err(ProjectError::ProjectNotOpen(self.project_id.clone()));
        }
        Ok(state)
    }

    fn require_use_admission(&self) -> Result<(), ProjectError> {
        let state = self.open_state()?;
        if state.mutation_poisoned {
            return Err(mutation_poisoned_error());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn set_revision_for_test(&self, revision: u64) -> Result<(), ProjectError> {
        lock(&self.state)?.project_revision = revision;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn fail_watcher_for_test(&self) -> Result<(), ProjectError> {
        lock(&self.watcher)?
            .as_ref()
            .ok_or_else(|| {
                ProjectError::service("project_watcher_failed", "Project watcher is not running.")
            })?
            .fail_worker_for_test()
    }

    #[cfg(test)]
    pub(super) fn apply_watched_change_for_test(&self, path: &str) -> Result<(), ProjectError> {
        self.apply_watched_file_change(path.to_owned())
    }

    #[cfg(test)]
    pub(super) fn report_watcher_backend_error_for_test(
        &self,
        message: &str,
    ) -> Result<(), ProjectError> {
        lock(&self.watcher)?
            .as_ref()
            .ok_or_else(|| {
                ProjectError::service("project_watcher_failed", "Project watcher is not running.")
            })?
            .report_backend_error_for_test(message)
    }

    fn prepare_for_publication(self: &Arc<Self>) -> Result<(), ProjectError> {
        let weak = Arc::downgrade(self);
        let watcher = ProjectFileWatcher::start(
            &self.root,
            Arc::new(move |signal| {
                if let Some(session) = weak.upgrade() {
                    if session.wait_until_published().is_err() {
                        return;
                    }
                    let _ = match signal {
                        ProjectWatchSignal::Path(path) => session.apply_watched_file_change(path),
                        ProjectWatchSignal::RescanRequired(message) => {
                            session.apply_watcher_backend_error(message)
                        }
                    };
                }
            }),
        )?;
        *lock(&self.watcher)? = Some(watcher);
        let refresh_result = (|| {
            let _delivery = lock(&self.delivery)?;
            let mut state = self.open_state()?;
            state.service.refresh()?;
            state.project_revision = 1;
            Ok(())
        })();
        if let Err(error) = refresh_result {
            let _ = self.publish();
            let _ = self.close_watcher();
            return Err(error);
        }
        Ok(())
    }

    fn publish(&self) -> Result<(), ProjectError> {
        let mut published = lock(&self.published)?;
        *published = true;
        self.publication_ready.notify_all();
        Ok(())
    }

    fn wait_until_published(&self) -> Result<(), ProjectError> {
        let mut published = lock(&self.published)?;
        while !*published {
            published = self
                .publication_ready
                .wait(published)
                .map_err(|_| ProjectError::StatePoisoned)?;
        }
        Ok(())
    }

    fn apply_watched_file_change(&self, path: String) -> Result<(), ProjectError> {
        self.apply_watched_refresh(ProjectWatchSignal::Path(path))
    }

    fn apply_watcher_backend_error(&self, message: String) -> Result<(), ProjectError> {
        self.apply_watched_refresh(ProjectWatchSignal::RescanRequired(message))
    }

    #[allow(clippy::too_many_lines)] // One delivery guard owns the complete refresh transaction.
    fn apply_watched_refresh(&self, signal: ProjectWatchSignal) -> Result<(), ProjectError> {
        let feedback_source = match &signal {
            ProjectWatchSignal::Path(path) if path != super::CANVAS_FEEDBACK_PROJECT_PATH => {
                Some(path.clone())
            }
            ProjectWatchSignal::Path(_) | ProjectWatchSignal::RescanRequired(_) => None,
        };
        let delivery = lock(&self.delivery)?;
        let mut state = self.open_state()?;
        if state.mutation_poisoned {
            return Err(mutation_poisoned_error());
        }
        let next_revision = state
            .project_revision
            .checked_add(1)
            .ok_or(ProjectError::RevisionExhausted)?;
        let previous = state.service.snapshot().clone();
        let diagnostic_path = match &signal {
            ProjectWatchSignal::Path(path) => path.as_str(),
            ProjectWatchSignal::RescanRequired(_) => "",
        };
        let snapshot = match state.service.refresh() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let message = match &signal {
                    ProjectWatchSignal::Path(_) => error.to_string(),
                    ProjectWatchSignal::RescanRequired(watch_error) => {
                        format!("{watch_error}; full refresh failed: {error}")
                    }
                };
                if error.leaves_mutation_outcome_uncertain() {
                    state.mutation_poisoned = true;
                    let snapshot = state
                        .service
                        .watch_refresh_failed(diagnostic_path, &message);
                    state.project_revision = next_revision;
                    let event = ProjectEvent {
                        project_id: self.project_id.clone(),
                        project_revision: state.project_revision,
                        change: ProjectChange::ProjectChanged(snapshot),
                    };
                    publish_event(&mut state, &event);
                    return Err(error);
                }
                state
                    .service
                    .watch_refresh_failed(diagnostic_path, &message)
            }
        };
        if snapshots_equivalent(&previous, &snapshot) {
            let files = snapshot.files.clone();
            state.service.preserve_public_snapshot(previous);
            let feedback = state.service.canvas_feedback().ok().cloned();
            let project_revision = state.project_revision;
            let dispatch_error = feedback.and_then(|feedback| match feedback_source.as_deref() {
                Some(source) => self
                    .feedback_artifacts
                    .enqueue_source_ordered(&self.root, project_revision, source, feedback)
                    .err(),
                None => self
                    .feedback_artifacts
                    .enqueue_document_ordered(&self.root, project_revision, feedback)
                    .err(),
            });
            drop(state);
            drop(delivery);
            if let Some(error) = dispatch_error {
                self.feedback_artifacts.report_dispatch_error(&error);
            }
            if let Some(source) = feedback_source.as_deref() {
                self.feedback_artifacts
                    .reconcile_image_cache_for_source(&self.root, &files, source);
            } else {
                self.feedback_artifacts
                    .reconcile_image_cache(&self.root, &files);
            }
            return Ok(());
        }
        state.project_revision = next_revision;
        let change = match signal {
            ProjectWatchSignal::Path(path) => ProjectChange::ProjectFileChanged {
                project_relative_path: path,
                snapshot,
            },
            ProjectWatchSignal::RescanRequired(_) => ProjectChange::ProjectChanged(snapshot),
        };
        let event = ProjectEvent {
            project_id: self.project_id.clone(),
            project_revision: state.project_revision,
            change,
        };
        publish_event(&mut state, &event);
        let files = state.service.snapshot().files.clone();
        let feedback = state.service.canvas_feedback().ok().cloned();
        let project_revision = state.project_revision;
        let dispatch_error = feedback.and_then(|feedback| match feedback_source.as_deref() {
            Some(source) => self
                .feedback_artifacts
                .enqueue_source_ordered(&self.root, project_revision, source, feedback)
                .err(),
            None => self
                .feedback_artifacts
                .enqueue_document_ordered(&self.root, project_revision, feedback)
                .err(),
        });
        drop(state);
        drop(delivery);
        if let Some(error) = dispatch_error {
            self.feedback_artifacts.report_dispatch_error(&error);
        }
        if let Some(source) = feedback_source.as_deref() {
            self.feedback_artifacts
                .reconcile_image_cache_for_source(&self.root, &files, source);
        } else {
            self.feedback_artifacts
                .reconcile_image_cache(&self.root, &files);
        }
        Ok(())
    }

    fn unsubscribe(&self, id: Uuid) -> Result<(), ProjectError> {
        let mut state = lock(&self.state)?;
        state.observers.remove(&id);
        Ok(())
    }

    fn close(&self) -> Result<(), ProjectError> {
        let delivery = lock(&self.delivery)?;
        let mut state = lock(&self.state)?;
        if state.closed {
            drop(state);
            drop(delivery);
            self.publish()?;
            return self.finalize_close();
        }
        state.closed = true;
        state.observers.clear();
        drop(state);
        drop(delivery);
        self.publish()?;
        self.finalize_close()
    }

    fn finalize_close(&self) -> Result<(), ProjectError> {
        let watcher_result = self.close_watcher();
        let detach_result = self.feedback_artifacts.detach(&self.root);
        if detach_result.is_ok()
            && let Ok(state) = self.state.lock()
        {
            state.service.release_capability_binding();
        }
        watcher_result.and(detach_result)
    }

    fn close_watcher(&self) -> Result<(), ProjectError> {
        if let Some(mut watcher) = lock(&self.watcher)?.take() {
            watcher.close()?;
        }
        Ok(())
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
    /// # Errors
    ///
    /// Returns an error if the session state is unavailable.
    pub fn release(mut self) -> Result<(), ProjectError> {
        self.release_once()
    }

    fn release_once(&mut self) -> Result<(), ProjectError> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        if let Some(session) = self.session.upgrade() {
            session.unsubscribe(self.id)?;
        }
        Ok(())
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
        command @ (ProjectCommand::CreateCanvas
        | ProjectCommand::RenameCanvas { .. }
        | ProjectCommand::ReorderCanvases { .. }
        | ProjectCommand::DeleteCanvas { .. }
        | ProjectCommand::RepairCanvasRegistry) => {
            execute_canvas_registry_command(service, command)
        }
        command @ (ProjectCommand::UpdateCanvasLayouts { .. }
        | ProjectCommand::BringCanvasNodeToFront { .. }
        | ProjectCommand::UpdateCanvasVideoPlayback { .. }
        | ProjectCommand::UpdateCanvasTextViewports { .. }) => {
            execute_visual_canvas_command(service, command)
        }
        ProjectCommand::UpdateCanvasFeedback { input } => {
            let affects_rendered_artifact = input.affects_rendered_artifact();
            let feedback = service.update_canvas_feedback(&input)?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasFeedbackUpdated {
                    feedback: feedback.clone(),
                },
                ProjectChange::CanvasFeedbackChanged {
                    feedback,
                    affects_rendered_artifact,
                },
            ))
        }
        command @ (ProjectCommand::PushCanvasMap { .. }
        | ProjectCommand::AddProjectPathToCanvasMap { .. }
        | ProjectCommand::ResetCanvasLayout { .. }) => execute_canvas_map_command(service, command),
        command @ (ProjectCommand::WriteTextFile { .. }
        | ProjectCommand::CreatePath { .. }
        | ProjectCommand::RenamePath { .. }) => execute_single_file_command(service, command),
        command => execute_file_batch_command(service, command),
    }
}

fn execute_canvas_registry_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    match command {
        ProjectCommand::CreateCanvas => {
            let (canvas_id, snapshot) = service.create_canvas()?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasCreated {
                    canvas_id,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        ProjectCommand::RenameCanvas { canvas_id, name } => {
            let snapshot = service.rename_canvas(&canvas_id, &name)?;
            Ok(project_snapshot_mutation(snapshot))
        }
        ProjectCommand::ReorderCanvases { order } => {
            let snapshot = service.reorder_canvases(&order)?;
            Ok(project_snapshot_mutation(snapshot))
        }
        ProjectCommand::DeleteCanvas { canvas_id } => {
            let (active_canvas_id, snapshot) = service.delete_canvas(&canvas_id)?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasDeleted {
                    active_canvas_id,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        ProjectCommand::RepairCanvasRegistry => {
            let (active_canvas_id, snapshot) = service.repair_canvas_registry()?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasRegistryRepaired {
                    active_canvas_id,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        _ => Err(ProjectError::StatePoisoned),
    }
}

fn execute_visual_canvas_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    let (canvas, projection, changed) = match command {
        ProjectCommand::UpdateCanvasLayouts { canvas_id, updates } => {
            service.update_canvas_layouts(&canvas_id, &updates)?
        }
        ProjectCommand::BringCanvasNodeToFront {
            canvas_id,
            project_relative_path,
        } => service.bring_canvas_node_to_front(&canvas_id, &project_relative_path)?,
        ProjectCommand::UpdateCanvasVideoPlayback { canvas_id, updates } => {
            service.update_canvas_video_playback(&canvas_id, &updates)?
        }
        ProjectCommand::UpdateCanvasTextViewports { canvas_id, updates } => {
            service.update_canvas_text_viewports(&canvas_id, &updates)?
        }
        _ => return Err(ProjectError::StatePoisoned),
    };
    Ok(canvas_change_mutation(canvas, projection, changed))
}

fn execute_canvas_map_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    match command {
        ProjectCommand::PushCanvasMap { canvas_id } => {
            let snapshot = service.push_canvas_map(&canvas_id)?;
            Ok(project_snapshot_mutation(snapshot))
        }
        ProjectCommand::AddProjectPathToCanvasMap {
            canvas_id,
            project_relative_path,
        } => {
            let (canvas, projection, added) =
                service.add_project_path_to_canvas_map(&canvas_id, &project_relative_path)?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasMapPathAdded {
                    canvas: canvas.clone(),
                    projection: projection.clone(),
                    project_relative_path: added,
                },
                ProjectChange::CanvasChanged { canvas, projection },
            ))
        }
        ProjectCommand::ResetCanvasLayout { canvas_id, rules } => {
            let (canvas, projection, reset_count) =
                service.reset_canvas_layout(&canvas_id, rules.as_ref())?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::CanvasLayoutReset {
                    canvas: canvas.clone(),
                    projection: projection.clone(),
                    reset_count,
                },
                ProjectChange::CanvasChanged { canvas, projection },
            ))
        }
        _ => Err(ProjectError::StatePoisoned),
    }
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
            let file = write_project_text_file(
                service.root(),
                &project_relative_path,
                &content,
                &expected_revision,
            )?;
            let snapshot = service.finish_committed_change(&project_relative_path)?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::TextFileSaved {
                    file,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectFileChanged {
                    project_relative_path: project_relative_path.clone(),
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
            project_path_mutation(service, result)
        }
        ProjectCommand::RenamePath {
            project_relative_path,
            name,
        } => {
            let result = rename_project_path(service.root(), &project_relative_path, &name)?;
            let target = result.project_relative_path.clone();
            let snapshot = service.finish_committed_change(&target)?;
            Ok(ProjectMutation::changed(
                ProjectCommandResult::PathChanged {
                    result,
                    snapshot: snapshot.clone(),
                },
                ProjectChange::ProjectChanged(snapshot),
            ))
        }
        _ => Err(ProjectError::StatePoisoned),
    }
}

fn execute_file_batch_command(
    service: &mut ProjectService,
    command: ProjectCommand,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    let (results, paths) = match command {
        ProjectCommand::CopyPaths {
            entries,
            target_directory,
        } => {
            let results = copy_project_paths(service.root(), &entries, &target_directory)?;
            let paths = result_project_paths(&results).collect();
            (results, paths)
        }
        ProjectCommand::MovePaths {
            entries,
            target_directory,
            overwrite,
        } => {
            let results =
                move_project_paths(service.root(), &entries, &target_directory, overwrite)?;
            let paths = entries_project_paths(&entries)
                .into_iter()
                .chain(result_project_paths(&results))
                .collect();
            (results, paths)
        }
        ProjectCommand::DeletePaths { entries } => {
            let paths = entries_project_paths(&entries);
            let results = delete_project_paths(service.root(), &entries)?;
            (results, paths)
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
            let paths = result_project_paths(&results).collect();
            (results, paths)
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
            let paths = result_project_paths(&results).collect();
            (results, paths)
        }
        _ => return Err(ProjectError::StatePoisoned),
    };
    project_paths_mutation(service, results, paths)
}

fn project_snapshot_mutation(snapshot: ProjectSnapshot) -> ProjectMutation<ProjectCommandResult> {
    ProjectMutation::changed(
        ProjectCommandResult::Snapshot(snapshot.clone()),
        ProjectChange::ProjectChanged(snapshot),
    )
}

fn canvas_change_mutation(
    canvas: CanvasDocument,
    projection: CanvasProjection,
    changed: bool,
) -> ProjectMutation<ProjectCommandResult> {
    let value = ProjectCommandResult::CanvasChanged {
        canvas: canvas.clone(),
        projection: projection.clone(),
        changed,
    };
    if changed {
        ProjectMutation::changed(value, ProjectChange::CanvasChanged { canvas, projection })
    } else {
        ProjectMutation::unchanged(value)
    }
}

fn project_path_mutation(
    service: &mut ProjectService,
    result: ProjectPathOperationResult,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    let path = result.project_relative_path.clone();
    let snapshot = service.finish_committed_change(&path)?;
    Ok(ProjectMutation::changed(
        ProjectCommandResult::PathChanged {
            result,
            snapshot: snapshot.clone(),
        },
        ProjectChange::ProjectChanged(snapshot),
    ))
}

fn project_paths_mutation(
    service: &mut ProjectService,
    results: Vec<ProjectPathBatchItemResult>,
    paths: impl IntoIterator<Item = String>,
) -> Result<ProjectMutation<ProjectCommandResult>, ProjectError> {
    let paths = paths.into_iter().collect::<Vec<_>>();
    let diagnostic_path = paths.first().map_or("", String::as_str);
    let snapshot = service.finish_committed_change(diagnostic_path)?;
    Ok(ProjectMutation::changed(
        ProjectCommandResult::PathsChanged {
            results,
            snapshot: snapshot.clone(),
        },
        ProjectChange::ProjectChanged(snapshot),
    ))
}

fn entries_project_paths(entries: &[ProjectPathBatchEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry.project_relative_path.clone())
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
        let _ = self.release_once();
    }
}

fn add_use(
    registry: &Arc<ProjectSessionRegistryInner>,
    state: &mut ProjectSessionRegistryState,
    project_id: &str,
    kind: ProjectUseKind,
) -> Result<ProjectUse, ProjectError> {
    if !state.sessions_by_id.contains_key(project_id) {
        return Err(ProjectError::ProjectNotOpen(project_id.to_owned()));
    }
    let use_id = Uuid::new_v4();
    state
        .uses_by_project
        .entry(project_id.to_owned())
        .or_default()
        .insert(use_id, kind);
    Ok(ProjectUse {
        registry: Arc::downgrade(registry),
        project_id: project_id.to_owned(),
        use_id,
        kind,
        released: false,
    })
}

fn release_use(
    registry: &Arc<ProjectSessionRegistryInner>,
    project_id: &str,
    use_id: Uuid,
) -> Result<(), ProjectError> {
    let closing = {
        let mut state = lock(&registry.state)?;
        let Some(project_uses) = state.uses_by_project.get_mut(project_id) else {
            return Ok(());
        };
        if project_uses.remove(&use_id).is_none() || !project_uses.is_empty() {
            return Ok(());
        }
        state.uses_by_project.remove(project_id);
        let Some(session) = state.sessions_by_id.remove(project_id) else {
            return Ok(());
        };
        state.project_ids_by_root.remove(session.root());
        let transition = Arc::new(RootTransition::new());
        state
            .transitions_by_root
            .insert(session.root().to_path_buf(), Arc::clone(&transition));
        Some((session, transition))
    };
    let result = if let Some((session, transition)) = closing {
        let close_result = session.close();
        let failure = close_result
            .as_ref()
            .err()
            .map(RootTransitionFailure::from_error);
        let finish_result = (|| {
            if failure.is_none() {
                lock(&registry.state)?
                    .transitions_by_root
                    .remove(session.root());
            }
            transition.finish(failure.clone(), failure)
        })();
        finish_result.and(close_result)
    } else {
        Ok(())
    };
    (registry.on_change)();
    result
}

fn sync_snapshot(project_id: &str, state: &ProjectSessionState) -> ProjectSyncSnapshot {
    ProjectSyncSnapshot {
        project_id: project_id.to_owned(),
        project_revision: state.project_revision,
        snapshot: state.service.snapshot().clone(),
    }
}

fn snapshots_equivalent(left: &ProjectSnapshot, right: &ProjectSnapshot) -> bool {
    left.project_root == right.project_root
        && left.metadata == right.metadata
        && left.files == right.files
        && left.canvases == right.canvases
        && left.projections == right.projections
        && left.diagnostics == right.diagnostics
        && left.canvas_registry == right.canvas_registry
        && left.health.project_name == right.health.project_name
        && left.health.canvas_count == right.health.canvas_count
        && left.health.diagnostic_counts == right.health.diagnostic_counts
        && left.health.runtime_data_location == right.health.runtime_data_location
}

fn mutation_poisoned_error() -> ProjectError {
    ProjectError::service(
        "project_session_mutation_poisoned",
        "Project mutation outcome is uncertain. Release the session's remaining Project uses and reopen the Project.",
    )
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, ProjectError> {
    mutex.lock().map_err(|_| ProjectError::StatePoisoned)
}
