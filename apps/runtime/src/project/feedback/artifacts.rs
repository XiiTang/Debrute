//! Bounded latest-epoch rendering for derived Canvas feedback artifacts.

use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Weak, mpsc},
    thread,
};

use image::GenericImageView as _;
use uuid::Uuid;

use super::{
    CanvasFeedbackDocument, CanvasFeedbackEntry, CanvasFeedbackItem, CanvasFeedbackMomentRef,
    CanvasFeedbackScope, MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES,
    canvas_feedback_rendered_moment_project_path, canvas_feedback_rendered_project_path,
    validate_canvas_feedback_document,
};
use crate::project::{
    CanvasMediaKind, PreviewCancellation, ProjectCapabilityFs, ProjectDiagnostic,
    ProjectDiagnosticSeverity, ProjectError, ProjectPreviewService, ProjectSession,
    canvas_media_kind_from_path,
    previews::raster::{composite_svg_overlay, encode_png},
};
#[cfg(test)]
use std::fs;

const DEFAULT_MAX_CONCURRENT_ARTIFACTS: usize = 3;
const SCHEDULER_COMMAND_CAPACITY: usize = 32;
const RUNTIME_DIAGNOSTIC_ID: &str = "canvas-feedback.runtime_failed";
const CLEANUP_DIAGNOSTIC_ID: &str = "canvas-feedback.cleanup_failed";
type FeedbackDiagnosticSink =
    Arc<dyn Fn(PathBuf, Uuid, CanvasFeedbackDiagnosticUpdate) + Send + Sync>;

struct SessionRoute {
    epoch: Uuid,
    session: Weak<ProjectSession>,
}

pub(crate) struct CanvasFeedbackDispatchError {
    root: PathBuf,
    epoch: Uuid,
    error: ProjectError,
}

/// Project-session router around the one feedback artifact scheduler.
pub struct CanvasFeedbackArtifacts {
    previews: Arc<ProjectPreviewService>,
    scheduler: CanvasFeedbackArtifactScheduler,
    sessions: Arc<Mutex<HashMap<PathBuf, SessionRoute>>>,
}

impl CanvasFeedbackArtifacts {
    /// Starts the bounded renderer and routes item-local diagnostics back into the
    /// matching revisioned Project session.
    ///
    /// # Errors
    /// Returns an error when the scheduler thread cannot be started.
    pub fn new(previews: Arc<ProjectPreviewService>) -> Result<Self, ProjectError> {
        let sessions = Arc::new(Mutex::new(HashMap::<PathBuf, SessionRoute>::new()));
        let diagnostic_sessions = Arc::clone(&sessions);
        let scheduler = CanvasFeedbackArtifactScheduler::new(
            CanvasFeedbackArtifactRenderer::new(Arc::clone(&previews)),
            None,
            Arc::new(move |root, epoch, update| {
                let session = lock(&diagnostic_sessions, "Canvas feedback session registry")
                    .get(&root)
                    .filter(|route| route.epoch == epoch)
                    .and_then(|route| route.session.upgrade());
                if let Some(session) = session {
                    let _ = session.apply_canvas_feedback_diagnostics(&update);
                }
            }),
        )?;
        Ok(Self {
            previews,
            scheduler,
            sessions,
        })
    }

    pub(crate) fn attach(&self, session: &Arc<ProjectSession>) {
        let epoch = Uuid::new_v4();
        lock(&self.sessions, "Canvas feedback session registry").insert(
            session.root().to_path_buf(),
            SessionRoute {
                epoch,
                session: Arc::downgrade(session),
            },
        );
        if let Ok(feedback) = session.canvas_feedback() {
            if let Ok(snapshot) = session.sync_snapshot()
                && let Err(error) = self
                    .previews
                    .reconcile_image_cache(session.root(), &snapshot.snapshot.files)
            {
                self.report_runtime_error_for_epoch(session.root(), epoch, &error);
            }
            if let Err(error) = self.scheduler.enqueue_document(
                session.root(),
                epoch,
                feedback.project_revision,
                feedback.value,
            ) {
                self.report_runtime_error_for_epoch(session.root(), epoch, &error);
            }
        }
    }

    pub(crate) fn enqueue_document_ordered(
        &self,
        root: &Path,
        project_revision: u64,
        document: CanvasFeedbackDocument,
    ) -> Result<(), CanvasFeedbackDispatchError> {
        let Some(epoch) = self.epoch(root) else {
            return Ok(());
        };
        self.scheduler
            .enqueue_document(root, epoch, project_revision, document)
            .map_err(|error| CanvasFeedbackDispatchError {
                root: root.to_path_buf(),
                epoch,
                error,
            })
    }

    pub(crate) fn enqueue_source_ordered(
        &self,
        root: &Path,
        project_revision: u64,
        project_relative_path: &str,
        document: CanvasFeedbackDocument,
    ) -> Result<(), CanvasFeedbackDispatchError> {
        let Some(epoch) = self.epoch(root) else {
            return Ok(());
        };
        self.scheduler
            .enqueue_source(
                root,
                epoch,
                project_revision,
                project_relative_path,
                document,
            )
            .map_err(|error| CanvasFeedbackDispatchError {
                root: root.to_path_buf(),
                epoch,
                error,
            })
    }

    pub(crate) fn reconcile_image_cache_for_source(
        &self,
        root: &Path,
        files: &[crate::project::ProjectFileEntry],
        project_relative_path: &str,
    ) {
        let epoch = self.epoch(root);
        if canvas_media_kind_from_path(project_relative_path) == CanvasMediaKind::Image
            && let Err(error) = self.previews.reconcile_image_cache(root, files)
            && let Some(epoch) = epoch
        {
            self.report_runtime_error_for_epoch(root, epoch, &error);
        }
    }

    pub(crate) fn reconcile_image_cache(
        &self,
        root: &Path,
        files: &[crate::project::ProjectFileEntry],
    ) {
        let epoch = self.epoch(root);
        if let Err(error) = self.previews.reconcile_image_cache(root, files)
            && let Some(epoch) = epoch
        {
            self.report_runtime_error_for_epoch(root, epoch, &error);
        }
    }

    pub(crate) fn detach(&self, root: &Path) -> Result<(), ProjectError> {
        let epoch = self.epoch(root);
        if let Some(epoch) = epoch {
            self.scheduler.cancel_project(root, epoch)?;
        }
        let mut sessions = lock(&self.sessions, "Canvas feedback session registry");
        if sessions
            .get(root)
            .is_some_and(|route| Some(route.epoch) == epoch)
        {
            sessions.remove(root);
        }
        Ok(())
    }

    fn epoch(&self, root: &Path) -> Option<Uuid> {
        lock(&self.sessions, "Canvas feedback session registry")
            .get(root)
            .map(|route| route.epoch)
    }

    pub(crate) fn report_dispatch_error(&self, dispatch: &CanvasFeedbackDispatchError) {
        self.report_runtime_error_for_epoch(&dispatch.root, dispatch.epoch, &dispatch.error);
    }

    fn report_runtime_error_for_epoch(&self, root: &Path, epoch: Uuid, error: &ProjectError) {
        let session = lock(&self.sessions, "Canvas feedback session registry")
            .get(root)
            .filter(|route| route.epoch == epoch)
            .and_then(|route| route.session.upgrade());
        if let Some(session) = session {
            let _ = session.apply_canvas_feedback_diagnostics(&CanvasFeedbackDiagnosticUpdate {
                diagnostics: vec![ProjectDiagnostic {
                    id: RUNTIME_DIAGNOSTIC_ID.to_owned(),
                    severity: ProjectDiagnosticSeverity::Error,
                    code: "canvas-feedback.runtime_failed".to_owned(),
                    message: format!("Canvas feedback runtime failed: {error}"),
                    file_path: None,
                    line: None,
                    column: None,
                    entity_id: None,
                }],
                checked_project_relative_paths: Vec::new(),
                checked_all_entries: false,
                retained_project_relative_paths: Vec::new(),
                resolved_diagnostic_ids: Vec::new(),
            });
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CanvasFeedbackArtifact {
    Image {
        project_relative_path: String,
        entry: Arc<CanvasFeedbackEntry>,
    },
    VideoMoment {
        project_relative_path: String,
        moment: CanvasFeedbackMomentRef,
        entry: Arc<CanvasFeedbackEntry>,
    },
}

impl CanvasFeedbackArtifact {
    fn project_relative_path(&self) -> &str {
        match self {
            Self::Image {
                project_relative_path,
                ..
            }
            | Self::VideoMoment {
                project_relative_path,
                ..
            } => project_relative_path,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanvasFeedbackDiagnosticUpdate {
    pub diagnostics: Vec<ProjectDiagnostic>,
    pub checked_project_relative_paths: Vec<String>,
    pub checked_all_entries: bool,
    pub retained_project_relative_paths: Vec<String>,
    pub resolved_diagnostic_ids: Vec<String>,
}

pub struct CanvasFeedbackArtifactRenderer {
    previews: Arc<ProjectPreviewService>,
}

impl CanvasFeedbackArtifactRenderer {
    #[must_use]
    pub fn new(previews: Arc<ProjectPreviewService>) -> Self {
        Self { previews }
    }

    fn render(
        &self,
        project_root: &Path,
        artifact: &CanvasFeedbackArtifact,
        cancellation: &PreviewCancellation,
    ) -> Result<Vec<u8>, ProjectError> {
        cancellation.check()?;
        self.previews.with_feedback_raster(cancellation, || {
            let mut image = match artifact {
                CanvasFeedbackArtifact::Image {
                    project_relative_path,
                    ..
                } => ProjectPreviewService::feedback_image(
                    project_root,
                    project_relative_path,
                    cancellation,
                )?,
                CanvasFeedbackArtifact::VideoMoment {
                    project_relative_path,
                    moment,
                    ..
                } => self.previews.feedback_video_frame(
                    project_root,
                    project_relative_path,
                    moment.current_time_seconds,
                    cancellation,
                )?,
            };
            let (width, height) = image.dimensions();
            let overlay = create_canvas_feedback_overlay_svg(
                width,
                height,
                &artifact_spatial_items(artifact),
            );
            composite_svg_overlay(&mut image, overlay.as_bytes())?;
            cancellation.check()?;
            let bytes = encode_png(&image)?;
            cancellation.check()?;
            Ok(bytes)
        })
    }
}

pub struct CanvasFeedbackArtifactScheduler {
    sender: mpsc::SyncSender<SchedulerCommand>,
    actor: Mutex<Option<thread::JoinHandle<()>>>,
}

impl CanvasFeedbackArtifactScheduler {
    /// Starts one bounded scheduler. A key retains at most one queued epoch.
    ///
    /// # Errors
    /// Returns an error when the coordinator thread cannot be started.
    pub fn new(
        renderer: CanvasFeedbackArtifactRenderer,
        max_concurrent_artifacts: Option<usize>,
        on_diagnostic: FeedbackDiagnosticSink,
    ) -> Result<Self, ProjectError> {
        let (sender, receiver) = mpsc::sync_channel(SCHEDULER_COMMAND_CAPACITY);
        let actor_sender = sender.clone();
        let actor = thread::Builder::new()
            .name("debrute-feedback-scheduler".to_owned())
            .spawn(move || {
                let renderer = Arc::new(renderer);
                run_scheduler(
                    &receiver,
                    &actor_sender,
                    &renderer,
                    max_concurrent_artifacts
                        .unwrap_or(DEFAULT_MAX_CONCURRENT_ARTIFACTS)
                        .max(1),
                    &on_diagnostic,
                );
            })
            .map_err(ProjectError::Io)?;
        Ok(Self {
            sender,
            actor: Mutex::new(Some(actor)),
        })
    }

    /// Coalesces every artifact described by one complete feedback document.
    ///
    /// # Errors
    /// Returns an error when the scheduler has stopped.
    pub fn enqueue_document(
        &self,
        project_root: impl Into<PathBuf>,
        session_epoch: Uuid,
        project_revision: u64,
        document: CanvasFeedbackDocument,
    ) -> Result<(), ProjectError> {
        validate_scheduler_document(&document)?;
        self.send(SchedulerCommand::EnqueueDocument {
            project_root: project_root.into(),
            session_epoch,
            project_revision,
            document,
        })
    }

    /// Coalesces only artifacts derived from one source while retaining document-wide cleanup.
    ///
    /// # Errors
    /// Returns an error when the scheduler has stopped.
    pub fn enqueue_source(
        &self,
        project_root: impl Into<PathBuf>,
        session_epoch: Uuid,
        project_revision: u64,
        project_relative_path: impl Into<String>,
        document: CanvasFeedbackDocument,
    ) -> Result<(), ProjectError> {
        validate_scheduler_document(&document)?;
        self.send(SchedulerCommand::EnqueueSource {
            project_root: project_root.into(),
            session_epoch,
            project_revision,
            project_relative_path: project_relative_path.into(),
            document,
        })
    }

    /// Removes queued work and marks active derived work stale without waiting for it.
    ///
    /// # Errors
    /// Returns an error when the scheduler has stopped.
    pub fn cancel_project(
        &self,
        project_root: impl Into<PathBuf>,
        session_epoch: Uuid,
    ) -> Result<(), ProjectError> {
        self.send(SchedulerCommand::CancelProject {
            project_root: project_root.into(),
            session_epoch,
        })
    }

    /// Stops the coordinator without waiting for active native rendering to drain.
    ///
    /// # Panics
    /// Panics if the scheduler thread panicked.
    pub fn close(&self) {
        let mut actor = lock(&self.actor, "Canvas feedback scheduler actor");
        let Some(actor) = actor.take() else {
            return;
        };
        let _ = self.sender.send(SchedulerCommand::Shutdown);
        actor
            .join()
            .expect("Canvas feedback scheduler thread panicked");
    }

    fn send(&self, command: SchedulerCommand) -> Result<(), ProjectError> {
        self.sender.try_send(command).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => ProjectError::service(
                "canvas_feedback_scheduler_backpressure",
                "Canvas feedback scheduler admission queue is full.",
            ),
            mpsc::TrySendError::Disconnected(_) => ProjectError::service(
                "canvas_feedback_scheduler_closed",
                "Canvas feedback scheduler is closed.",
            ),
        })
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(|_| panic!("{name} lock poisoned"))
}

fn validate_scheduler_document(document: &CanvasFeedbackDocument) -> Result<(), ProjectError> {
    validate_canvas_feedback_document(document)?;
    if serde_json::to_vec(document)?.len() > MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES {
        return Err(ProjectError::service(
            "canvas_feedback_document_too_large",
            format!(
                "Canvas feedback scheduler payload exceeds {MAX_CANVAS_FEEDBACK_DOCUMENT_BYTES} bytes."
            ),
        ));
    }
    Ok(())
}

impl Drop for CanvasFeedbackArtifactScheduler {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Clone)]
struct ArtifactDescriptor {
    artifact_project_path: String,
    diagnostic_project_relative_path: String,
    artifact: CanvasFeedbackArtifact,
}

struct RenderState {
    project_root: PathBuf,
    session_epoch: Uuid,
    project_revision: u64,
    descriptor: ArtifactDescriptor,
    epoch: u64,
    queued: Option<QueuedEpoch>,
    active: Option<ActiveEpoch>,
    queued_for_start: bool,
}

struct QueuedEpoch {
    epoch: u64,
    job_id: Uuid,
    artifact: CanvasFeedbackArtifact,
}

struct ActiveEpoch {
    epoch: u64,
    job_id: Uuid,
    cancellation: PreviewCancellation,
}

enum SchedulerCommand {
    EnqueueDocument {
        project_root: PathBuf,
        session_epoch: Uuid,
        project_revision: u64,
        document: CanvasFeedbackDocument,
    },
    EnqueueSource {
        project_root: PathBuf,
        session_epoch: Uuid,
        project_revision: u64,
        project_relative_path: String,
        document: CanvasFeedbackDocument,
    },
    CancelProject {
        project_root: PathBuf,
        session_epoch: Uuid,
    },
    Completed {
        key: String,
        epoch: u64,
        job_id: Uuid,
        result: Result<Vec<u8>, String>,
    },
    Shutdown,
}

struct SchedulerState {
    states: HashMap<String, RenderState>,
    latest_document_revisions: HashMap<(PathBuf, Uuid), u64>,
    latest_source_revisions: HashMap<(PathBuf, Uuid, String), u64>,
    ready: VecDeque<String>,
    active_count: usize,
    max_concurrent: usize,
    shutting_down: bool,
}

fn run_scheduler(
    receiver: &mpsc::Receiver<SchedulerCommand>,
    sender: &mpsc::SyncSender<SchedulerCommand>,
    renderer: &Arc<CanvasFeedbackArtifactRenderer>,
    max_concurrent: usize,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    let mut state = SchedulerState {
        states: HashMap::new(),
        latest_document_revisions: HashMap::new(),
        latest_source_revisions: HashMap::new(),
        ready: VecDeque::new(),
        active_count: 0,
        max_concurrent,
        shutting_down: false,
    };
    while let Ok(command) = receiver.recv() {
        handle_scheduler_command(&mut state, command, on_diagnostic);
        if state.shutting_down {
            break;
        }
        start_ready(&mut state, sender, renderer, on_diagnostic);
    }
}

// The command is consumed by the coordinator and never observed by its caller again.
#[allow(clippy::needless_pass_by_value)]
fn handle_scheduler_command(
    state: &mut SchedulerState,
    command: SchedulerCommand,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    match command {
        SchedulerCommand::EnqueueDocument {
            project_root,
            session_epoch,
            project_revision,
            document,
        } if !state.shutting_down => {
            if accept_document_revision(state, &project_root, session_epoch, project_revision) {
                enqueue_document_state(
                    state,
                    &project_root,
                    session_epoch,
                    project_revision,
                    &document,
                    on_diagnostic,
                );
            }
        }
        SchedulerCommand::EnqueueSource {
            project_root,
            session_epoch,
            project_revision,
            project_relative_path,
            document,
        } if !state.shutting_down => {
            if accept_source_revision(
                state,
                &project_root,
                session_epoch,
                project_revision,
                &project_relative_path,
            ) {
                enqueue_source_state(
                    state,
                    &project_root,
                    session_epoch,
                    project_revision,
                    &project_relative_path,
                    &document,
                    on_diagnostic,
                );
            }
        }
        SchedulerCommand::CancelProject {
            project_root,
            session_epoch,
        } => {
            cancel_project_state(state, &project_root, session_epoch);
        }
        SchedulerCommand::Completed {
            key,
            epoch,
            job_id,
            result,
        } => {
            complete_epoch(state, &key, epoch, job_id, result, on_diagnostic);
        }
        SchedulerCommand::Shutdown => {
            state.shutting_down = true;
            for render in state.states.values_mut() {
                render.queued = None;
                render.queued_for_start = false;
            }
            state.ready.clear();
        }
        SchedulerCommand::EnqueueDocument { .. } | SchedulerCommand::EnqueueSource { .. } => {}
    }
}

fn enqueue_document_state(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    project_revision: u64,
    document: &CanvasFeedbackDocument,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    let descriptors = artifact_descriptors_for_document(document);
    let expected = descriptors
        .iter()
        .map(|descriptor| descriptor.artifact_project_path.clone())
        .collect::<BTreeSet<_>>();
    let retained = descriptors
        .iter()
        .map(|descriptor| descriptor.diagnostic_project_relative_path.clone())
        .collect::<BTreeSet<_>>();
    remove_obsolete_states(
        state,
        project_root,
        session_epoch,
        &expected,
        None,
        on_diagnostic,
    );
    for descriptor in descriptors {
        enqueue_descriptor(
            state,
            project_root,
            session_epoch,
            project_revision,
            descriptor,
        );
    }
    let cleanup_succeeded = match remove_unexpected_artifacts(project_root, &expected) {
        Ok(()) => true,
        Err(error) => {
            publish_cleanup_failure(
                on_diagnostic,
                project_root,
                session_epoch,
                &error.to_string(),
            );
            false
        }
    };
    on_diagnostic(
        project_root.to_path_buf(),
        session_epoch,
        CanvasFeedbackDiagnosticUpdate {
            diagnostics: Vec::new(),
            checked_project_relative_paths: Vec::new(),
            checked_all_entries: true,
            retained_project_relative_paths: retained.into_iter().collect(),
            resolved_diagnostic_ids: if cleanup_succeeded {
                vec![
                    RUNTIME_DIAGNOSTIC_ID.to_owned(),
                    CLEANUP_DIAGNOSTIC_ID.to_owned(),
                ]
            } else {
                vec![RUNTIME_DIAGNOSTIC_ID.to_owned()]
            },
        },
    );
}

fn accept_document_revision(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    project_revision: u64,
) -> bool {
    activate_session_epoch(state, project_root, session_epoch);
    let key = (project_root.to_path_buf(), session_epoch);
    if state
        .latest_document_revisions
        .get(&key)
        .is_some_and(|latest| project_revision <= *latest)
    {
        return false;
    }
    state
        .latest_document_revisions
        .insert(key, project_revision);
    state
        .latest_source_revisions
        .retain(|(root, epoch, _), revision| {
            root != project_root || *epoch != session_epoch || *revision > project_revision
        });
    true
}

fn accept_source_revision(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    project_revision: u64,
    project_relative_path: &str,
) -> bool {
    activate_session_epoch(state, project_root, session_epoch);
    let project_key = (project_root.to_path_buf(), session_epoch);
    if state
        .latest_document_revisions
        .get(&project_key)
        .is_some_and(|revision| project_revision <= *revision)
    {
        return false;
    }
    let source_key = (
        project_root.to_path_buf(),
        session_epoch,
        project_relative_path.to_owned(),
    );
    if state
        .latest_source_revisions
        .get(&source_key)
        .is_some_and(|latest| project_revision <= *latest)
    {
        return false;
    }
    state
        .latest_source_revisions
        .insert(source_key, project_revision);
    true
}

fn activate_session_epoch(state: &mut SchedulerState, project_root: &Path, session_epoch: Uuid) {
    for render in state.states.values_mut() {
        if render.project_root != project_root || render.session_epoch == session_epoch {
            continue;
        }
        render.epoch = render.epoch.saturating_add(1);
        render.queued = None;
        render.queued_for_start = false;
        if let Some(active) = &render.active {
            active.cancellation.cancel();
        }
    }
    state.ready.retain(|key| {
        state.states.get(key).is_some_and(|render| {
            render.project_root != project_root || render.session_epoch == session_epoch
        })
    });
    state.states.retain(|_, render| {
        render.project_root != project_root
            || render.session_epoch == session_epoch
            || render.active.is_some()
    });
    state
        .latest_document_revisions
        .retain(|(root, epoch), _| root != project_root || *epoch == session_epoch);
    state
        .latest_source_revisions
        .retain(|(root, epoch, _), _| root != project_root || *epoch == session_epoch);
}

fn enqueue_source_state(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    project_revision: u64,
    project_relative_path: &str,
    document: &CanvasFeedbackDocument,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    let descriptors = artifact_descriptors_for_entry(document.entries.get(project_relative_path));
    let descriptors_empty = descriptors.is_empty();
    let expected_source = descriptors
        .iter()
        .map(|descriptor| descriptor.artifact_project_path.clone())
        .collect::<BTreeSet<_>>();
    let expected_document = artifact_descriptors_for_document(document)
        .into_iter()
        .map(|descriptor| descriptor.artifact_project_path)
        .collect::<BTreeSet<_>>();
    remove_obsolete_states(
        state,
        project_root,
        session_epoch,
        &expected_source,
        Some(project_relative_path),
        on_diagnostic,
    );
    for descriptor in descriptors {
        enqueue_descriptor(
            state,
            project_root,
            session_epoch,
            project_revision,
            descriptor,
        );
    }
    let cleanup_succeeded = match remove_unexpected_artifacts(project_root, &expected_document) {
        Ok(()) => true,
        Err(error) => {
            publish_cleanup_failure(
                on_diagnostic,
                project_root,
                session_epoch,
                &error.to_string(),
            );
            false
        }
    };
    if descriptors_empty {
        on_diagnostic(
            project_root.to_path_buf(),
            session_epoch,
            CanvasFeedbackDiagnosticUpdate {
                diagnostics: Vec::new(),
                checked_project_relative_paths: vec![project_relative_path.to_owned()],
                checked_all_entries: false,
                retained_project_relative_paths: Vec::new(),
                resolved_diagnostic_ids: Vec::new(),
            },
        );
    }
    publish_infrastructure_recovery(
        on_diagnostic,
        project_root,
        session_epoch,
        cleanup_succeeded,
    );
}

fn enqueue_descriptor(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    project_revision: u64,
    descriptor: ArtifactDescriptor,
) {
    let key = render_key(
        project_root,
        session_epoch,
        &descriptor.artifact_project_path,
    );
    let render = state
        .states
        .entry(key.clone())
        .or_insert_with(|| RenderState {
            project_root: project_root.to_path_buf(),
            session_epoch,
            project_revision,
            descriptor: descriptor.clone(),
            epoch: 0,
            queued: None,
            active: None,
            queued_for_start: false,
        });
    render.descriptor = descriptor.clone();
    render.project_revision = project_revision;
    render.epoch = render.epoch.saturating_add(1);
    render.queued = Some(QueuedEpoch {
        epoch: render.epoch,
        job_id: Uuid::new_v4(),
        artifact: descriptor.artifact,
    });
    if let Some(active) = &render.active {
        active.cancellation.cancel();
    } else {
        queue_for_start(state, key);
    }
}

fn queue_for_start(state: &mut SchedulerState, key: String) {
    let Some(render) = state.states.get_mut(&key) else {
        return;
    };
    if render.active.is_some() || render.queued.is_none() || render.queued_for_start {
        return;
    }
    render.queued_for_start = true;
    state.ready.push_back(key);
}

fn start_ready(
    state: &mut SchedulerState,
    sender: &mpsc::SyncSender<SchedulerCommand>,
    renderer: &Arc<CanvasFeedbackArtifactRenderer>,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    while state.active_count < state.max_concurrent {
        let Some(key) = state.ready.pop_front() else {
            break;
        };
        let Some(render) = state.states.get_mut(&key) else {
            continue;
        };
        render.queued_for_start = false;
        if render.active.is_some() {
            continue;
        }
        let Some(queued) = render.queued.take() else {
            continue;
        };
        let cancellation = PreviewCancellation::default();
        let active = ActiveEpoch {
            epoch: queued.epoch,
            job_id: queued.job_id,
            cancellation: cancellation.clone(),
        };
        render.active = Some(active);
        state.active_count += 1;
        let root = render.project_root.clone();
        let artifact = queued.artifact;
        let key_for_worker = key.clone();
        let sender_for_worker = sender.clone();
        let renderer = Arc::clone(renderer);
        let spawn = thread::Builder::new()
            .name("debrute-feedback-render".to_owned())
            .spawn(move || {
                let result = renderer
                    .render(&root, &artifact, &cancellation)
                    .map_err(|error| error.to_string());
                let _ = sender_for_worker.send(SchedulerCommand::Completed {
                    key: key_for_worker,
                    epoch: queued.epoch,
                    job_id: queued.job_id,
                    result,
                });
            });
        if let Err(error) = spawn {
            complete_epoch(
                state,
                &key,
                queued.epoch,
                queued.job_id,
                Err(error.to_string()),
                on_diagnostic,
            );
        }
    }
}

fn complete_epoch(
    state: &mut SchedulerState,
    key: &str,
    epoch: u64,
    job_id: Uuid,
    result: Result<Vec<u8>, String>,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    let Some(render) = state.states.get_mut(key) else {
        return;
    };
    let Some(active) = render.active.take() else {
        return;
    };
    if active.epoch != epoch || active.job_id != job_id {
        render.active = Some(active);
        return;
    }
    state.active_count = state.active_count.saturating_sub(1);
    let latest = render.epoch == epoch && !active.cancellation_is_cancelled();
    if latest {
        match result {
            Ok(bytes) => match ProjectCapabilityFs::open(&render.project_root).and_then(|project| {
                project.atomic_write(&render.descriptor.artifact_project_path, &bytes)
            }) {
                Ok(()) => publish_render_success(on_diagnostic, render),
                Err(error) => publish_render_failure(on_diagnostic, render, &error.to_string()),
            },
            Err(message) => publish_render_failure(on_diagnostic, render, &message),
        }
    }
    if render.queued.is_some() {
        queue_for_start(state, key.to_owned());
    } else {
        state.states.remove(key);
    }
}

impl ActiveEpoch {
    fn cancellation_is_cancelled(&self) -> bool {
        self.cancellation.check().is_err()
    }
}

fn remove_obsolete_states(
    state: &mut SchedulerState,
    project_root: &Path,
    session_epoch: Uuid,
    expected: &BTreeSet<String>,
    source: Option<&str>,
    on_diagnostic: &FeedbackDiagnosticSink,
) {
    let keys = state
        .states
        .iter()
        .filter(|(_, render)| {
            render.project_root == project_root
                && render.session_epoch == session_epoch
                && source.is_none_or(|source| {
                    render.descriptor.artifact.project_relative_path() == source
                })
                && !expected.contains(&render.descriptor.artifact_project_path)
        })
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    for key in keys {
        let Some(render) = state.states.get_mut(&key) else {
            continue;
        };
        render.epoch = render.epoch.saturating_add(1);
        render.queued = None;
        render.queued_for_start = false;
        if let Some(active) = &render.active {
            active.cancellation.cancel();
        }
        let removal = ProjectCapabilityFs::open(&render.project_root)
            .and_then(|project| project.remove_file(&render.descriptor.artifact_project_path));
        match removal {
            Ok(()) => publish_render_success(on_diagnostic, render),
            Err(ProjectError::Io(ref error)) if error.kind() == std::io::ErrorKind::NotFound => {
                publish_render_success(on_diagnostic, render);
            }
            Err(error) => publish_render_failure(on_diagnostic, render, &error.to_string()),
        }
        if render.active.is_none() {
            state.states.remove(&key);
        }
    }
}

fn cancel_project_state(state: &mut SchedulerState, project_root: &Path, session_epoch: Uuid) {
    for render in state.states.values_mut() {
        if render.project_root != project_root || render.session_epoch != session_epoch {
            continue;
        }
        render.epoch = render.epoch.saturating_add(1);
        render.queued = None;
        render.queued_for_start = false;
        if let Some(active) = &render.active {
            active.cancellation.cancel();
        }
    }
    state.ready.retain(|key| {
        state.states.get(key).is_some_and(|render| {
            render.project_root != project_root || render.session_epoch != session_epoch
        })
    });
    state.states.retain(|_, render| {
        render.project_root != project_root
            || render.session_epoch != session_epoch
            || render.active.is_some()
    });
    state
        .latest_document_revisions
        .remove(&(project_root.to_path_buf(), session_epoch));
    state
        .latest_source_revisions
        .retain(|(root, epoch, _), _| root != project_root || *epoch != session_epoch);
}

fn publish_render_success(on_diagnostic: &FeedbackDiagnosticSink, render: &RenderState) {
    on_diagnostic(
        render.project_root.clone(),
        render.session_epoch,
        CanvasFeedbackDiagnosticUpdate {
            diagnostics: Vec::new(),
            checked_project_relative_paths: vec![
                render.descriptor.diagnostic_project_relative_path.clone(),
            ],
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: Vec::new(),
        },
    );
}

fn publish_render_failure(
    on_diagnostic: &FeedbackDiagnosticSink,
    render: &RenderState,
    message: &str,
) {
    let cleanup_error = ProjectCapabilityFs::open(&render.project_root)
        .and_then(|project| project.remove_file(&render.descriptor.artifact_project_path))
        .err()
        .filter(|error| {
            !matches!(error, ProjectError::Io(error) if error.kind() == std::io::ErrorKind::NotFound)
        });
    let message = cleanup_error.map_or_else(
        || message.to_owned(),
        |error| format!("{message}; stale artifact cleanup failed: {error}"),
    );
    on_diagnostic(
        render.project_root.clone(),
        render.session_epoch,
        CanvasFeedbackDiagnosticUpdate {
            diagnostics: vec![canvas_feedback_render_diagnostic(
                &render.project_root,
                &render.descriptor.artifact,
                &render.descriptor.diagnostic_project_relative_path,
                &message,
            )],
            checked_project_relative_paths: vec![
                render.descriptor.diagnostic_project_relative_path.clone(),
            ],
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: Vec::new(),
        },
    );
}

fn artifact_descriptors_for_document(document: &CanvasFeedbackDocument) -> Vec<ArtifactDescriptor> {
    document
        .entries
        .values()
        .flat_map(|entry| artifact_descriptors_for_entry(Some(entry)))
        .collect()
}

fn artifact_descriptors_for_entry(entry: Option<&CanvasFeedbackEntry>) -> Vec<ArtifactDescriptor> {
    let Some(entry) = entry else {
        return Vec::new();
    };
    let shared_entry = Arc::new(entry.clone());
    let mut descriptors = Vec::new();
    if entry
        .items
        .iter()
        .any(|item| item.is_spatial() && item.scope == CanvasFeedbackScope::File)
    {
        descriptors.push(ArtifactDescriptor {
            artifact_project_path: canvas_feedback_rendered_project_path(
                &entry.project_relative_path,
            ),
            diagnostic_project_relative_path: entry.project_relative_path.clone(),
            artifact: CanvasFeedbackArtifact::Image {
                project_relative_path: entry.project_relative_path.clone(),
                entry: Arc::clone(&shared_entry),
            },
        });
    }
    for moment in moment_refs(entry) {
        descriptors.push(ArtifactDescriptor {
            artifact_project_path: canvas_feedback_rendered_moment_project_path(
                &entry.project_relative_path,
                &moment.label,
            ),
            diagnostic_project_relative_path: format!(
                "{}#{}",
                entry.project_relative_path, moment.label
            ),
            artifact: CanvasFeedbackArtifact::VideoMoment {
                project_relative_path: entry.project_relative_path.clone(),
                moment,
                entry: Arc::clone(&shared_entry),
            },
        });
    }
    descriptors
}

fn moment_refs(entry: &CanvasFeedbackEntry) -> Vec<CanvasFeedbackMomentRef> {
    let mut seen = BTreeSet::new();
    entry
        .items
        .iter()
        .filter_map(|item| item.moment.clone())
        .filter(|moment| seen.insert((moment.label.clone(), moment.current_time_seconds.to_bits())))
        .collect()
}

fn artifact_spatial_items(artifact: &CanvasFeedbackArtifact) -> Vec<&CanvasFeedbackItem> {
    match artifact {
        CanvasFeedbackArtifact::Image { entry, .. } => entry
            .items
            .iter()
            .filter(|item| item.is_spatial() && item.scope == CanvasFeedbackScope::File)
            .collect(),
        CanvasFeedbackArtifact::VideoMoment { moment, entry, .. } => entry
            .items
            .iter()
            .filter(|item| {
                item.is_spatial()
                    && item.scope == CanvasFeedbackScope::Moment
                    && item.moment.as_ref() == Some(moment)
            })
            .collect(),
    }
}

fn create_canvas_feedback_overlay_svg(
    width: u32,
    height: u32,
    items: &[&CanvasFeedbackItem],
) -> String {
    let content = items
        .iter()
        .filter_map(|item| spatial_item_svg(item, width, height))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
<style>.shape{{fill:none;stroke:#ffcc00;stroke-width:4;paint-order:stroke}}.halo{{fill:none;stroke:#101010;stroke-width:7;opacity:.82}}.badge{{fill:#ffcc00;stroke:#101010;stroke-width:3}}.label{{fill:#101010;font-family:system-ui,sans-serif;font-size:18px;font-weight:700;text-anchor:middle;dominant-baseline:central}}</style>{content}</svg>"#
    )
}

#[allow(clippy::cast_possible_truncation)]
fn spatial_item_svg(item: &CanvasFeedbackItem, width: u32, height: u32) -> Option<String> {
    let label = item.label?;
    let geometry = item.geometry.as_ref()?;
    let width = f64::from(width);
    let height = f64::from(height);
    match geometry {
        super::CanvasFeedbackGeometry::Point { x, y } => {
            let cx = (x * width).round() as i64;
            let cy = (y * height).round() as i64;
            Some(format!(
                "{}<path class=\"halo\" d=\"M {cx} {} L {cx} {}\"/><path class=\"shape\" d=\"M {cx} {} L {cx} {}\"/>",
                badge_svg(label, cx, cy),
                cy + 14,
                cy + 31,
                cy + 14,
                cy + 31
            ))
        }
        super::CanvasFeedbackGeometry::Rect {
            x,
            y,
            width: rect_width,
            height: rect_height,
        } => {
            let x = (x * width).round() as i64;
            let y = (y * height).round() as i64;
            let rect_width = (rect_width * width).round() as i64;
            let rect_height = (rect_height * height).round() as i64;
            Some(format!(
                "<rect class=\"halo\" x=\"{x}\" y=\"{y}\" width=\"{rect_width}\" height=\"{rect_height}\"/><rect class=\"shape\" x=\"{x}\" y=\"{y}\" width=\"{rect_width}\" height=\"{rect_height}\"/>{}",
                badge_svg(label, x, y)
            ))
        }
    }
}

fn badge_svg(label: u64, x: i64, y: i64) -> String {
    format!(
        "<circle class=\"badge\" cx=\"{x}\" cy=\"{y}\" r=\"15\"/><text class=\"label\" x=\"{x}\" y=\"{y}\">{label}</text>"
    )
}

fn canvas_feedback_render_diagnostic(
    project_root: &Path,
    artifact: &CanvasFeedbackArtifact,
    diagnostic_path: &str,
    message: &str,
) -> ProjectDiagnostic {
    let suffix = match artifact {
        CanvasFeedbackArtifact::VideoMoment { moment, .. } => format!(" at {}", moment.label),
        CanvasFeedbackArtifact::Image { .. } => String::new(),
    };
    ProjectDiagnostic {
        id: format!("canvas-feedback.render_failed:{diagnostic_path}"),
        severity: ProjectDiagnosticSeverity::Error,
        code: "canvas-feedback.render_failed".to_owned(),
        message: format!(
            "Canvas feedback artifact could not be created for {}{suffix}: {message}",
            artifact.project_relative_path()
        ),
        file_path: Some(
            project_root
                .join(artifact.project_relative_path())
                .to_string_lossy()
                .into_owned(),
        ),
        line: None,
        column: None,
        entity_id: Some(diagnostic_path.to_owned()),
    }
}

fn remove_unexpected_artifacts(
    project_root: &Path,
    expected: &BTreeSet<String>,
) -> Result<(), ProjectError> {
    const ROOT: &str = ".debrute/reviews/rendered-feedback";
    let project = ProjectCapabilityFs::open(project_root)?;
    let root = match project.open_directory(ROOT) {
        Ok(root) => root,
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    remove_unexpected_artifacts_in(&root, ROOT, expected).map(|_| ())
}

fn remove_unexpected_artifacts_in(
    directory: &cap_std::fs::Dir,
    prefix: &str,
    expected: &BTreeSet<String>,
) -> Result<bool, ProjectError> {
    let mut retained_any = false;
    for entry in directory.entries()?.collect::<Result<Vec<_>, _>>()? {
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        let relative = format!("{prefix}/{name_text}");
        let file_type = entry.file_type()?;
        if file_type.is_dir() && !file_type.is_symlink() {
            let child = entry.open_dir()?;
            let child_retained = remove_unexpected_artifacts_in(&child, &relative, expected)?;
            drop(child);
            if child_retained {
                retained_any = true;
            } else {
                directory.remove_dir(&name)?;
            }
        } else if file_type.is_file() && expected.contains(&relative) {
            retained_any = true;
        } else {
            directory.remove_file(name)?;
        }
    }
    Ok(retained_any)
}

fn publish_cleanup_failure(
    on_diagnostic: &FeedbackDiagnosticSink,
    project_root: &Path,
    session_epoch: Uuid,
    message: &str,
) {
    on_diagnostic(
        project_root.to_path_buf(),
        session_epoch,
        CanvasFeedbackDiagnosticUpdate {
            diagnostics: vec![ProjectDiagnostic {
                id: CLEANUP_DIAGNOSTIC_ID.to_owned(),
                severity: ProjectDiagnosticSeverity::Error,
                code: "canvas-feedback.cleanup_failed".to_owned(),
                message: format!("Canvas feedback artifact cleanup failed: {message}"),
                file_path: None,
                line: None,
                column: None,
                entity_id: None,
            }],
            checked_project_relative_paths: Vec::new(),
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: Vec::new(),
        },
    );
}

fn publish_infrastructure_recovery(
    on_diagnostic: &FeedbackDiagnosticSink,
    project_root: &Path,
    session_epoch: Uuid,
    cleanup_succeeded: bool,
) {
    let mut resolved_diagnostic_ids = vec![RUNTIME_DIAGNOSTIC_ID.to_owned()];
    if cleanup_succeeded {
        resolved_diagnostic_ids.push(CLEANUP_DIAGNOSTIC_ID.to_owned());
    }
    on_diagnostic(
        project_root.to_path_buf(),
        session_epoch,
        CanvasFeedbackDiagnosticUpdate {
            diagnostics: Vec::new(),
            checked_project_relative_paths: Vec::new(),
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids,
        },
    );
}

fn render_key(project_root: &Path, session_epoch: Uuid, artifact_project_path: &str) -> String {
    format!(
        "{}\0{session_epoch}\0{artifact_project_path}",
        project_root.display()
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use image::{DynamicImage, RgbaImage};

    use crate::{
        project::{MediaToolPaths, initialize_raster_preview_engine},
        workers::RuntimeWorkerServices,
    };

    use super::*;
    #[cfg(target_os = "macos")]
    use crate::project::CanvasFeedbackMark;
    use crate::project::{
        CanvasFeedbackGeometry, CanvasFeedbackItem, CanvasFeedbackItemKind, CanvasFeedbackScope,
        ProjectPreviewService,
    };

    #[test]
    fn scheduler_renders_latest_image_artifact_and_reports_item_local_success() {
        initialize_raster_preview_engine().expect("native raster engine should initialize");
        let root = std::env::temp_dir().join(format!("debrute-feedback-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("images")).expect("fixture directory should exist");
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            64,
            48,
            image::Rgba([20, 30, 40, 255]),
        ))
        .save(root.join("images/cover.png"))
        .expect("fixture image should save");
        let workers = RuntimeWorkerServices::new();
        let previews = Arc::new(ProjectPreviewService::new(
            &workers,
            MediaToolPaths::unavailable(),
        ));
        let (sender, receiver) = mpsc::sync_channel(8);
        let scheduler = CanvasFeedbackArtifactScheduler::new(
            CanvasFeedbackArtifactRenderer::new(previews),
            Some(1),
            Arc::new(move |_root, _epoch, update| {
                let _ = sender.send(update);
            }),
        )
        .expect("scheduler should start");
        let timestamp = "2026-07-15T01:02:03.004Z".to_owned();
        let entry = CanvasFeedbackEntry {
            project_relative_path: "images/cover.png".to_owned(),
            marks: Vec::new(),
            next_moment_label: 1,
            next_spatial_label: 2,
            items: vec![CanvasFeedbackItem {
                id: "one".to_owned(),
                kind: CanvasFeedbackItemKind::Pin,
                scope: CanvasFeedbackScope::File,
                label: Some(1),
                geometry: Some(CanvasFeedbackGeometry::Point { x: 0.5, y: 0.5 }),
                moment: None,
                comment: "center".to_owned(),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            }],
            updated_at: timestamp.clone(),
        };
        let document = CanvasFeedbackDocument {
            updated_at: timestamp,
            entries: [(entry.project_relative_path.clone(), entry)]
                .into_iter()
                .collect(),
        };
        let session_epoch = Uuid::new_v4();
        scheduler
            .enqueue_document(&root, session_epoch, 1, document)
            .expect("render should enqueue");
        let update = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("document diagnostic barrier should arrive");
        assert!(update.checked_all_entries);
        let update = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("artifact result should arrive");
        assert!(update.diagnostics.is_empty());
        assert_eq!(
            update.checked_project_relative_paths,
            vec!["images/cover.png"]
        );
        assert!(
            root.join(canvas_feedback_rendered_project_path("images/cover.png"))
                .is_file()
        );
        scheduler.close();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn enqueue_coalesces_to_one_latest_epoch_and_cancels_active_work() {
        let root = PathBuf::from("/tmp/debrute-feedback-coalesce");
        let entry = CanvasFeedbackEntry {
            project_relative_path: "images/cover.png".to_owned(),
            marks: Vec::new(),
            next_moment_label: 1,
            next_spatial_label: 1,
            items: Vec::new(),
            updated_at: "2026-07-15T01:02:03.004Z".to_owned(),
        };
        let descriptor = ArtifactDescriptor {
            artifact_project_path: canvas_feedback_rendered_project_path("images/cover.png"),
            diagnostic_project_relative_path: "images/cover.png".to_owned(),
            artifact: CanvasFeedbackArtifact::Image {
                project_relative_path: "images/cover.png".to_owned(),
                entry: Arc::new(entry),
            },
        };
        let session_epoch = Uuid::new_v4();
        let key = render_key(&root, session_epoch, &descriptor.artifact_project_path);
        let mut state = SchedulerState {
            states: HashMap::new(),
            latest_document_revisions: HashMap::new(),
            latest_source_revisions: HashMap::new(),
            ready: VecDeque::new(),
            active_count: 1,
            max_concurrent: 1,
            shutting_down: false,
        };
        enqueue_descriptor(&mut state, &root, session_epoch, 1, descriptor.clone());
        let first = state.states.get_mut(&key).expect("state should exist");
        let queued = first.queued.take().expect("first epoch should queue");
        first.queued_for_start = false;
        first.active = Some(ActiveEpoch {
            epoch: queued.epoch,
            job_id: queued.job_id,
            cancellation: PreviewCancellation::default(),
        });

        enqueue_descriptor(&mut state, &root, session_epoch, 2, descriptor);
        let latest = state.states.get(&key).expect("state should remain");
        assert_eq!(latest.epoch, 2);
        assert_eq!(latest.queued.as_ref().map(|queued| queued.epoch), Some(2));
        assert!(
            latest
                .active
                .as_ref()
                .expect("first render should remain active until completion")
                .cancellation
                .check()
                .is_err()
        );
    }

    #[test]
    fn scheduler_orders_documents_globally_and_sources_independently_by_project_revision() {
        let root = PathBuf::from("/tmp/debrute-feedback-revisions");
        let epoch = Uuid::new_v4();
        let mut state = SchedulerState {
            states: HashMap::new(),
            latest_document_revisions: HashMap::new(),
            latest_source_revisions: HashMap::new(),
            ready: VecDeque::new(),
            active_count: 0,
            max_concurrent: 1,
            shutting_down: false,
        };
        assert!(accept_source_revision(
            &mut state,
            &root,
            epoch,
            2,
            "images/a.png"
        ));
        assert!(accept_source_revision(
            &mut state,
            &root,
            epoch,
            1,
            "images/b.png"
        ));
        assert!(!accept_source_revision(
            &mut state,
            &root,
            epoch,
            1,
            "images/a.png"
        ));
        assert!(accept_document_revision(&mut state, &root, epoch, 3));
        assert!(!accept_document_revision(&mut state, &root, epoch, 3));
        assert!(!accept_source_revision(
            &mut state,
            &root,
            epoch,
            2,
            "images/b.png"
        ));
        assert!(!accept_document_revision(&mut state, &root, epoch, 2));
    }

    #[test]
    fn accepting_a_new_session_epoch_cancels_and_forgets_the_old_session() {
        let root = PathBuf::from("/tmp/debrute-feedback-session-epoch");
        let old_epoch = Uuid::new_v4();
        let new_epoch = Uuid::new_v4();
        let entry = CanvasFeedbackEntry {
            project_relative_path: "images/cover.png".to_owned(),
            marks: Vec::new(),
            next_moment_label: 1,
            next_spatial_label: 1,
            items: Vec::new(),
            updated_at: "2026-07-15T01:02:03.004Z".to_owned(),
        };
        let descriptor = ArtifactDescriptor {
            artifact_project_path: canvas_feedback_rendered_project_path("images/cover.png"),
            diagnostic_project_relative_path: "images/cover.png".to_owned(),
            artifact: CanvasFeedbackArtifact::Image {
                project_relative_path: "images/cover.png".to_owned(),
                entry: Arc::new(entry),
            },
        };
        let old_key = render_key(&root, old_epoch, &descriptor.artifact_project_path);
        let mut state = SchedulerState {
            states: HashMap::new(),
            latest_document_revisions: HashMap::from([((root.clone(), old_epoch), 12)]),
            latest_source_revisions: HashMap::from([(
                (root.clone(), old_epoch, "images/cover.png".to_owned()),
                13,
            )]),
            ready: VecDeque::new(),
            active_count: 1,
            max_concurrent: 1,
            shutting_down: false,
        };
        enqueue_descriptor(&mut state, &root, old_epoch, 13, descriptor);
        let old = state
            .states
            .get_mut(&old_key)
            .expect("old render should exist");
        let queued = old.queued.take().expect("old render should be queued");
        old.queued_for_start = false;
        old.active = Some(ActiveEpoch {
            epoch: queued.epoch,
            job_id: queued.job_id,
            cancellation: PreviewCancellation::default(),
        });

        assert!(accept_document_revision(&mut state, &root, new_epoch, 1));
        let old = state
            .states
            .get(&old_key)
            .expect("active old render remains until completion");
        assert!(old.queued.is_none());
        assert!(
            old.active
                .as_ref()
                .expect("active old render should remain tracked")
                .cancellation
                .check()
                .is_err()
        );
        assert!(!state.ready.contains(&old_key));
        assert!(
            !state
                .latest_document_revisions
                .contains_key(&(root.clone(), old_epoch))
        );
        assert!(
            !state
                .latest_source_revisions
                .keys()
                .any(|(candidate_root, epoch, _)| candidate_root == &root && *epoch == old_epoch)
        );
        assert_eq!(
            state.latest_document_revisions.get(&(root, new_epoch)),
            Some(&1)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn artifact_cleanup_never_follows_an_external_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("debrute-feedback-{}", Uuid::new_v4()));
        let external = std::env::temp_dir().join(format!("debrute-external-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".debrute/reviews")).unwrap();
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("must-survive"), "outside").unwrap();
        symlink(&external, root.join(".debrute/reviews/rendered-feedback")).unwrap();
        assert!(remove_unexpected_artifacts(&root, &BTreeSet::new()).is_err());
        assert!(external.join("must-survive").is_file());

        let timestamp = "2026-07-15T01:02:03.004Z".to_owned();
        let entry = CanvasFeedbackEntry {
            project_relative_path: "images/cover.png".to_owned(),
            marks: vec![CanvasFeedbackMark::Like],
            next_moment_label: 1,
            next_spatial_label: 2,
            items: vec![CanvasFeedbackItem {
                id: "pin-1".to_owned(),
                kind: CanvasFeedbackItemKind::Pin,
                scope: CanvasFeedbackScope::File,
                label: Some(1),
                geometry: Some(CanvasFeedbackGeometry::Point { x: 0.5, y: 0.5 }),
                moment: None,
                comment: "review".to_owned(),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            }],
            updated_at: timestamp.clone(),
        };
        let document = CanvasFeedbackDocument {
            updated_at: timestamp,
            entries: [("images/cover.png".to_owned(), entry)]
                .into_iter()
                .collect(),
        };
        let epoch = Uuid::new_v4();
        let mut state = SchedulerState {
            states: HashMap::new(),
            latest_document_revisions: HashMap::new(),
            latest_source_revisions: HashMap::new(),
            ready: VecDeque::new(),
            active_count: 0,
            max_concurrent: 1,
            shutting_down: false,
        };
        let diagnostic_sink: FeedbackDiagnosticSink = Arc::new(|_, _, _| {});
        enqueue_document_state(&mut state, &root, epoch, 1, &document, &diagnostic_sink);
        assert!(state.states.values().any(|render| render.queued.is_some()));
        fs::remove_file(root.join(".debrute/reviews/rendered-feedback")).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(external).unwrap();
    }

    #[test]
    fn artifact_cleanup_removes_stale_files_and_their_empty_directories() {
        let root =
            std::env::temp_dir().join(format!("debrute-feedback-cleanup-{}", Uuid::new_v4()));
        let stale = root.join(".debrute/reviews/rendered-feedback/nested/source");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("old.png"), b"stale").unwrap();

        remove_unexpected_artifacts(&root, &BTreeSet::new()).unwrap();

        assert!(
            !root
                .join(".debrute/reviews/rendered-feedback/nested")
                .exists()
        );
        assert!(root.join(".debrute/reviews/rendered-feedback").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
}
