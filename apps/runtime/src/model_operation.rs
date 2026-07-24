use std::{
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::{
    now_rfc3339,
    project::{
        DebruteProjectMetadata, GeneratedArtifactRole, PROJECT_FILE, ProjectCapabilityFs,
        assert_project_tree_visible_mutation_path, is_valid_stable_project_id,
        normalize_project_path_basename,
    },
};

pub const MAX_MODEL_OPERATION_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TERMINAL_OPERATIONS: usize = 100;
const DEFAULT_BATCH_CONCURRENCY: usize = 1;
const DEFAULT_MODEL_TIMEOUT_SECONDS: u64 = 10 * 60;
const DEFAULT_VIDEO_TIMEOUT_SECONDS: u64 = 30 * 60;
const OBSERVER_DISCONNECT_POLL: Duration = Duration::from_millis(100);
const MAX_PROJECT_METADATA_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelKind {
    Image,
    Video,
    Tts,
    Music,
    SoundEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionShape {
    Single,
    Batch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRequest {
    pub model: String,
    pub arguments: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<ModelOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPointer {
    pub artifact_index: u64,
    pub role: GeneratedArtifactRole,
    pub project_relative_path: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationState {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

impl OperationState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    #[must_use]
    pub const fn is_active(self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "shape", rename_all = "lowercase")]
pub enum ModelOperationExecution {
    Single {
        model: String,
        timeout_seconds: u64,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        artifacts: Vec<ArtifactPointer>,
    },
    Batch {
        item_count: usize,
        concurrency: usize,
        timeout_seconds: u64,
        active: usize,
        succeeded: usize,
        failed: usize,
    },
}

impl ModelOperationExecution {
    #[must_use]
    pub fn single_artifacts(&self) -> &[ArtifactPointer] {
        match self {
            Self::Single { artifacts, .. } => artifacts,
            Self::Batch { .. } => &[],
        }
    }

    #[must_use]
    pub const fn batch_counts(&self) -> Option<(usize, usize, usize)> {
        match self {
            Self::Batch {
                active,
                succeeded,
                failed,
                ..
            } => Some((*active, *succeeded, *failed)),
            Self::Single { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOperationSnapshot {
    pub id: String,
    pub model_kind: ModelKind,
    pub project_root: String,
    pub state: OperationState,
    pub accepted_at: String,
    pub execution: ModelOperationExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchItemStatus {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemOutcome {
    pub item_index: usize,
    pub model: String,
    pub status: BatchItemStatus,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactPointer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

impl BatchItemOutcome {
    #[must_use]
    pub const fn status(&self) -> BatchItemStatus {
        self.status
    }
}

#[derive(Debug, Clone)]
pub struct SubmitModelOperation {
    pub project_root: PathBuf,
    pub shape: ExecutionShape,
    pub requests: Vec<ModelRequest>,
    pub concurrency: Option<usize>,
    pub timeout_seconds: Option<u64>,
    pub replace: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationListState {
    Active,
    Terminal,
    Queued,
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

impl OperationListState {
    fn matches(self, state: OperationState) -> bool {
        match self {
            Self::Active => state.is_active(),
            Self::Terminal => state.is_terminal(),
            Self::Queued => state == OperationState::Queued,
            Self::Running => state == OperationState::Running,
            Self::Cancelling => state == OperationState::Cancelling,
            Self::Succeeded => state == OperationState::Succeeded,
            Self::Failed => state == OperationState::Failed,
            Self::Cancelled => state == OperationState::Cancelled,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelOperationListQuery {
    pub state: Option<OperationListState>,
    pub model_kind: Option<ModelKind>,
    pub project_root: Option<PathBuf>,
    pub limit: usize,
    pub cursor: Option<String>,
}

impl Default for ModelOperationListQuery {
    fn default() -> Self {
        Self {
            state: None,
            model_kind: None,
            project_root: None,
            limit: 25,
            cursor: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOperationList {
    pub operations: Vec<ModelOperationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModelRunError {
    code: &'static str,
    log: String,
    cancelled: bool,
}

impl ModelRunError {
    #[must_use]
    pub fn failed(log: impl Into<String>) -> Self {
        Self {
            code: "model_request_failed",
            log: log.into(),
            cancelled: false,
        }
    }

    #[must_use]
    pub fn validation(code: &'static str, log: impl Into<String>) -> Self {
        Self {
            code,
            log: log.into(),
            cancelled: false,
        }
    }

    #[must_use]
    pub fn cancelled() -> Self {
        Self {
            code: "operation_cancelled",
            log: "Model Run was cancelled.".to_owned(),
            cancelled: true,
        }
    }

    #[must_use]
    pub fn log(&self) -> &str {
        &self.log
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ModelRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.log)
    }
}

impl std::error::Error for ModelRunError {}

#[derive(Debug, Clone, Default)]
pub struct ModelCancellation(Arc<AtomicBool>);

impl ModelCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    /// Returns an error after cancellation has been requested.
    ///
    /// # Errors
    ///
    /// Returns `operation_cancelled` when the cancellation flag is set.
    pub fn check(&self) -> Result<(), ModelRunError> {
        if self.is_cancelled() {
            Err(ModelRunError::cancelled())
        } else {
            Ok(())
        }
    }
}

pub(crate) trait ModelOperationExecutor: Send + Sync + 'static {
    type Prepared: Send + 'static;
    type Staged: Send + 'static;

    /// Resolves and validates a request without performing its Model Run.
    ///
    /// # Errors
    ///
    /// Returns a closed validation error when the request cannot be executed.
    fn validate(&self, request: &mut ModelRequest) -> Result<ModelKind, ModelRunError>;

    /// Performs the interruptible Model Run without publishing artifacts.
    ///
    /// # Errors
    ///
    /// Returns a model, timeout, transport, or cancellation error.
    fn run(
        &self,
        project_root: &Path,
        request: &ModelRequest,
        timeout: Duration,
        cancellation: &ModelCancellation,
    ) -> Result<Self::Prepared, ModelRunError>;

    /// Stages completed output bytes without publishing their target paths.
    ///
    /// # Errors
    ///
    /// Returns an error when artifact publication or provenance recording fails.
    fn stage(
        &self,
        project_capability: &ProjectCapabilityFs,
        operation_id: &str,
        request: &ModelRequest,
        replace: bool,
        prepared: Self::Prepared,
    ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError>;

    /// Publishes already-staged outputs and their provenance at the short,
    /// non-interruptible completion boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when artifact publication or provenance recording fails.
    fn commit(&self, project_root: &Path, staged: Self::Staged) -> Result<(), ModelRunError>;
}

#[derive(Debug, Clone)]
pub struct ModelOperationError {
    code: &'static str,
    log: Option<String>,
    snapshot: Option<Box<ModelOperationSnapshot>>,
}

impl ModelOperationError {
    fn new(code: &'static str, log: impl Into<String>) -> Self {
        Self {
            code,
            log: Some(log.into()),
            snapshot: None,
        }
    }

    fn with_snapshot(mut self, snapshot: ModelOperationSnapshot) -> Self {
        self.snapshot = Some(Box::new(snapshot));
        self
    }

    #[must_use]
    pub const fn code(&self) -> &'static str {
        self.code
    }

    #[must_use]
    pub fn log(&self) -> Option<&str> {
        self.log.as_deref()
    }

    #[must_use]
    pub fn snapshot(&self) -> Option<&ModelOperationSnapshot> {
        self.snapshot.as_deref()
    }
}

impl fmt::Display for ModelOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.log.as_deref().unwrap_or(self.code))
    }
}

impl std::error::Error for ModelOperationError {}

struct OperationRecord {
    sequence: u64,
    id: String,
    model_kind: ModelKind,
    project_root: PathBuf,
    project_id: String,
    project_capability: ProjectCapabilityFs,
    state: OperationState,
    accepted_at: String,
    requests: Arc<[ModelRequest]>,
    shape: ExecutionShape,
    concurrency: usize,
    timeout_seconds: u64,
    replace: bool,
    cancellation: ModelCancellation,
    completion: Arc<Mutex<()>>,
    single_artifacts: Vec<ArtifactPointer>,
    active: usize,
    succeeded: usize,
    failed: usize,
    outcomes: Vec<BatchItemOutcome>,
    claimed_outputs: HashSet<String>,
    log: Option<String>,
    cancellation_failure: Option<String>,
    change: u64,
}

impl OperationRecord {
    fn snapshot(&self) -> ModelOperationSnapshot {
        let execution = match self.shape {
            ExecutionShape::Single => ModelOperationExecution::Single {
                model: self.requests[0].model.clone(),
                timeout_seconds: self.timeout_seconds,
                artifacts: self.single_artifacts.clone(),
            },
            ExecutionShape::Batch => ModelOperationExecution::Batch {
                item_count: self.requests.len(),
                concurrency: self.concurrency,
                timeout_seconds: self.timeout_seconds,
                active: self.active,
                succeeded: self.succeeded,
                failed: self.failed,
            },
        };
        ModelOperationSnapshot {
            id: self.id.clone(),
            model_kind: self.model_kind,
            project_root: self.project_root.to_string_lossy().into_owned(),
            state: self.state,
            accepted_at: self.accepted_at.clone(),
            execution,
            log: self.log.clone(),
        }
    }
}

struct RegistryState {
    next_sequence: u64,
    operations: HashMap<String, OperationRecord>,
    terminal_order: VecDeque<String>,
}

#[allow(private_bounds)]
pub struct ModelOperationService<Executor: ModelOperationExecutor> {
    executor: Arc<Executor>,
    runtime_id: String,
    state: Mutex<RegistryState>,
    changed: Condvar,
    workers: Mutex<HashMap<String, thread::JoinHandle<()>>>,
    lifecycle: Mutex<()>,
    shutting_down: AtomicBool,
}

struct ValidatedSubmission {
    project_root: PathBuf,
    project_id: String,
    project_capability: ProjectCapabilityFs,
    model_kind: ModelKind,
    timeout_seconds: u64,
    concurrency: usize,
}

type BatchItemExecutionContext = (
    PathBuf,
    String,
    ProjectCapabilityFs,
    Duration,
    Arc<Mutex<()>>,
    bool,
);

#[allow(private_bounds)]
impl<Executor: ModelOperationExecutor> ModelOperationService<Executor> {
    #[must_use]
    pub fn new(executor: Arc<Executor>) -> Self {
        Self {
            executor,
            runtime_id: Uuid::new_v4().to_string(),
            state: Mutex::new(RegistryState {
                next_sequence: 1,
                operations: HashMap::new(),
                terminal_order: VecDeque::new(),
            }),
            changed: Condvar::new(),
            workers: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        }
    }

    /// Validates and atomically accepts one Model Operation.
    ///
    /// # Errors
    ///
    /// Returns a closed input, Project, executor-validation, or task-start error before
    /// acceptance. An execution task that cannot start after acceptance is recorded as failed.
    pub fn submit(
        self: &Arc<Self>,
        mut input: SubmitModelOperation,
    ) -> Result<ModelOperationSnapshot, ModelOperationError> {
        let _lifecycle = lock(&self.lifecycle, "Model Operation lifecycle");
        self.reap_workers();
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ModelOperationError::new(
                "internal_error",
                "Runtime is shutting down and no longer accepts Model Operations.",
            ));
        }
        let validated = self.validate_submission(&mut input)?;
        let id = Uuid::new_v4().to_string();
        let accepted_at = now_rfc3339();
        let requests = Arc::<[ModelRequest]>::from(input.requests);
        let cancellation = ModelCancellation::default();

        let (start_sender, start_receiver) = std::sync::mpsc::sync_channel::<()>(0);
        let weak = Arc::downgrade(self);
        let worker_id = id.clone();
        let worker = thread::Builder::new()
            .name(format!("debrute-model-operation-{id}"))
            .spawn(move || {
                if start_receiver.recv().is_ok()
                    && let Some(service) = weak.upgrade()
                {
                    service.execute(&worker_id);
                }
            })
            .map_err(|error| ModelOperationError::new("internal_error", error.to_string()))?;

        let snapshot = {
            let mut state = self.lock_state();
            let sequence = state.next_sequence;
            state.next_sequence = state.next_sequence.checked_add(1).ok_or_else(|| {
                ModelOperationError::new("internal_error", "Operation sequence is exhausted.")
            })?;
            let record = OperationRecord {
                sequence,
                id: id.clone(),
                model_kind: validated.model_kind,
                project_root: validated.project_root,
                project_id: validated.project_id,
                project_capability: validated.project_capability,
                state: OperationState::Queued,
                accepted_at,
                requests,
                shape: input.shape,
                concurrency: validated.concurrency,
                timeout_seconds: validated.timeout_seconds,
                replace: input.replace,
                cancellation,
                completion: Arc::new(Mutex::new(())),
                single_artifacts: Vec::new(),
                active: 0,
                succeeded: 0,
                failed: 0,
                outcomes: Vec::new(),
                claimed_outputs: HashSet::new(),
                log: None,
                cancellation_failure: None,
                change: 1,
            };
            let snapshot = record.snapshot();
            state.operations.insert(id.clone(), record);
            snapshot
        };
        lock(&self.workers, "Model Operation worker registry").insert(id.clone(), worker);
        if start_sender.send(()).is_err() {
            self.finish_failed(&id, "Model Operation execution task did not start.");
        }
        Ok(snapshot)
    }

    /// Cancels and joins every Runtime-owned Operation worker.
    ///
    /// # Panics
    /// Panics if an Operation worker panicked.
    pub fn shutdown(&self) {
        let lifecycle = lock(&self.lifecycle, "Model Operation lifecycle");
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let active = {
            let state = self.lock_state();
            state
                .operations
                .values()
                .filter(|record| record.state.is_active())
                .map(|record| record.id.clone())
                .collect::<Vec<_>>()
        };
        for id in active {
            let _ = self.cancel(&id);
        }
        let workers = std::mem::take(&mut *lock(&self.workers, "Model Operation worker registry"));
        drop(lifecycle);
        for worker in workers.into_values() {
            worker.join().expect("Model Operation worker panicked");
        }
    }

    fn reap_workers(&self) {
        let finished = {
            let mut workers = lock(&self.workers, "Model Operation worker registry");
            let ids = workers
                .iter()
                .filter(|(_, worker)| worker.is_finished())
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| workers.remove(&id))
                .collect::<Vec<_>>()
        };
        for worker in finished {
            worker.join().expect("Model Operation worker panicked");
        }
    }

    fn validate_submission(
        &self,
        input: &mut SubmitModelOperation,
    ) -> Result<ValidatedSubmission, ModelOperationError> {
        let (project_root, project_id, project_capability) = validate_project(&input.project_root)?;
        validate_shape(input.shape, &input.requests, input.concurrency)?;
        let mut model_kind = None;
        let mut output_names = HashSet::new();
        for request in &mut input.requests {
            validate_model_request(request)?;
            let kind = self
                .executor
                .validate(request)
                .map_err(|error| ModelOperationError::new(error.code(), error.log().to_owned()))?;
            if model_kind
                .replace(kind)
                .is_some_and(|previous| previous != kind)
            {
                return Err(ModelOperationError::new(
                    "invalid_input",
                    "Every Batch Item must resolve to the same Model Kind.",
                ));
            }
            if let Some(output) = &request.output
                && let Some(filename) = &output.filename
                && !output_names.insert((output.directory.clone(), filename.clone()))
            {
                return Err(ModelOperationError::new(
                    "invalid_input",
                    "Batch contains duplicate explicit output names.",
                ));
            }
        }
        let model_kind = model_kind.ok_or_else(|| {
            ModelOperationError::new("invalid_input", "Model Request input must not be empty.")
        })?;
        let timeout_seconds = input.timeout_seconds.unwrap_or_else(|| {
            if model_kind == ModelKind::Video {
                DEFAULT_VIDEO_TIMEOUT_SECONDS
            } else {
                DEFAULT_MODEL_TIMEOUT_SECONDS
            }
        });
        if timeout_seconds == 0 {
            return Err(ModelOperationError::new(
                "invalid_input",
                "Model Run timeout must be representable and positive.",
            ));
        }
        let concurrency = match input.shape {
            ExecutionShape::Single => 1,
            ExecutionShape::Batch => input
                .concurrency
                .unwrap_or(DEFAULT_BATCH_CONCURRENCY)
                .min(input.requests.len()),
        };
        if concurrency == 0 {
            return Err(ModelOperationError::new(
                "invalid_input",
                "Batch concurrency must be positive.",
            ));
        }
        Ok(ValidatedSubmission {
            project_root,
            project_id,
            project_capability,
            model_kind,
            timeout_seconds,
            concurrency,
        })
    }

    /// Returns the latest snapshot of an Operation.
    ///
    /// # Errors
    ///
    /// Returns `operation_not_found` when the current Runtime does not retain the identifier.
    pub fn inspect(&self, id: &str) -> Result<ModelOperationSnapshot, ModelOperationError> {
        let state = self.lock_state();
        state
            .operations
            .get(id)
            .map(OperationRecord::snapshot)
            .ok_or_else(operation_not_found)
    }

    /// Observes the current snapshot, replays settled Batch Items, and waits for terminal state.
    ///
    /// # Errors
    ///
    /// Returns `operation_not_found` when the current Runtime does not retain the identifier.
    /// Returns `Ok(None)` when the command-scoped observer disconnects before terminal state.
    pub fn wait(
        &self,
        id: &str,
        mut is_observing: impl FnMut() -> bool,
        mut on_observed: impl FnMut(&ModelOperationSnapshot) -> bool,
        mut on_outcome: impl FnMut(&BatchItemOutcome) -> bool,
    ) -> Result<Option<ModelOperationSnapshot>, ModelOperationError> {
        let mut delivered = 0usize;
        let mut observed = false;
        loop {
            if !is_observing() {
                return Ok(None);
            }
            let (snapshot, pending, change) = {
                let state = self.lock_state();
                let record = state.operations.get(id).ok_or_else(operation_not_found)?;
                (
                    record.snapshot(),
                    record.outcomes[delivered..].to_vec(),
                    record.change,
                )
            };
            if !observed {
                observed = true;
                if snapshot.state.is_active() && !on_observed(&snapshot) {
                    return Ok(None);
                }
            }
            delivered += pending.len();
            for outcome in &pending {
                if !on_outcome(outcome) {
                    return Ok(None);
                }
            }
            if snapshot.state.is_terminal() {
                return Ok(Some(snapshot));
            }
            self.wait_for_change(id, change);
        }
    }

    /// Requests cancellation and returns the linearized snapshot.
    ///
    /// # Errors
    ///
    /// Returns `operation_not_found` or `operation_already_terminal` when cancellation cannot win.
    pub fn cancel(&self, id: &str) -> Result<ModelOperationSnapshot, ModelOperationError> {
        let completion = {
            let state = self.lock_state();
            let record = state.operations.get(id).ok_or_else(operation_not_found)?;
            Arc::clone(&record.completion)
        };
        let _completion = lock(&completion, "Model Operation completion");
        let mut retain_terminal = false;
        let snapshot = {
            let mut state = self.lock_state();
            let record = state
                .operations
                .get_mut(id)
                .ok_or_else(operation_not_found)?;
            match record.state {
                OperationState::Queued => {
                    record.cancellation.cancel();
                    record.state = OperationState::Cancelled;
                    record.change = record.change.saturating_add(1);
                    retain_terminal = true;
                }
                OperationState::Running => {
                    record.cancellation.cancel();
                    record.state = OperationState::Cancelling;
                    record.change = record.change.saturating_add(1);
                }
                OperationState::Cancelling | OperationState::Cancelled => {}
                OperationState::Succeeded | OperationState::Failed => {
                    return Err(ModelOperationError::new(
                        "operation_already_terminal",
                        "Model Operation already completed.",
                    )
                    .with_snapshot(record.snapshot()));
                }
            }
            record.snapshot()
        };
        if retain_terminal {
            self.retain_terminal(id);
        }
        self.changed.notify_all();
        Ok(snapshot)
    }

    /// Lists retained Operations newest first.
    ///
    /// # Errors
    ///
    /// Returns an input, cursor, or Project error when a filter is invalid.
    pub fn list(
        &self,
        query: &ModelOperationListQuery,
    ) -> Result<ModelOperationList, ModelOperationError> {
        if !(1..=100).contains(&query.limit) {
            return Err(ModelOperationError::new(
                "invalid_input",
                "Operation list limit must be between 1 and 100.",
            ));
        }
        let before_sequence = query
            .cursor
            .as_deref()
            .map(|cursor| self.parse_cursor(cursor))
            .transpose()?;
        let project = query
            .project_root
            .as_deref()
            .map(validate_project)
            .transpose()?;
        let state = self.lock_state();
        let mut records = state
            .operations
            .values()
            .filter(|record| before_sequence.is_none_or(|sequence| record.sequence < sequence))
            .filter(|record| {
                query
                    .state
                    .is_none_or(|filter| filter.matches(record.state))
            })
            .filter(|record| {
                query
                    .model_kind
                    .is_none_or(|kind| kind == record.model_kind)
            })
            .filter(|record| {
                project.as_ref().is_none_or(|(root, project_id, _)| {
                    root == &record.project_root && project_id == &record.project_id
                })
            })
            .collect::<Vec<_>>();
        records.sort_by_key(|record| std::cmp::Reverse(record.sequence));
        let has_more = records.len() > query.limit;
        records.truncate(query.limit);
        let next_cursor = records
            .last()
            .filter(|_| has_more)
            .map(|record| format!("{}:{}", self.runtime_id, record.sequence));
        Ok(ModelOperationList {
            operations: records.into_iter().map(OperationRecord::snapshot).collect(),
            next_cursor,
        })
    }

    #[cfg(test)]
    #[must_use]
    pub fn retained_terminal_count(&self) -> usize {
        self.lock_state().terminal_order.len()
    }

    fn execute(self: &Arc<Self>, id: &str) {
        let shape = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state != OperationState::Queued {
                return;
            }
            record.state = OperationState::Running;
            record.change = record.change.saturating_add(1);
            record.shape
        };
        self.changed.notify_all();
        match shape {
            ExecutionShape::Single => self.execute_single(id),
            ExecutionShape::Batch => self.execute_batch(id),
        }
    }

    fn execute_single(&self, id: &str) {
        let (
            root,
            project_id,
            project_capability,
            request,
            timeout,
            cancellation,
            completion,
            replace,
        ) = {
            let state = self.lock_state();
            let Some(record) = state.operations.get(id) else {
                return;
            };
            (
                record.project_root.clone(),
                record.project_id.clone(),
                record.project_capability.clone(),
                record.requests[0].clone(),
                Duration::from_secs(record.timeout_seconds),
                record.cancellation.clone(),
                Arc::clone(&record.completion),
                record.replace,
            )
        };
        let staged = validate_project_identity(&root, &project_id)
            .and_then(|()| self.executor.run(&root, &request, timeout, &cancellation))
            .and_then(|prepared| {
                self.executor
                    .stage(&project_capability, id, &request, replace, prepared)
            });
        match staged {
            Ok((staged, artifacts)) => {
                let _completion = lock(&completion, "Model Operation completion");
                if cancellation.is_cancelled() {
                    self.finish_cancelled(id);
                    return;
                }
                if let Err(error) = validate_project_identity(&root, &project_id) {
                    self.finish_failed(id, error.log());
                    return;
                }
                match self.executor.commit(&root, staged) {
                    Ok(()) => {
                        let mut state = self.lock_state();
                        let Some(record) = state.operations.get_mut(id) else {
                            return;
                        };
                        record.single_artifacts = artifacts;
                        record.state = OperationState::Succeeded;
                        record.change = record.change.saturating_add(1);
                        drop(state);
                        self.retain_terminal(id);
                        self.changed.notify_all();
                    }
                    Err(error) => {
                        self.finish_failed(id, error.log());
                    }
                }
            }
            Err(error) if error.cancelled => self.finish_cancelled(id),
            Err(error) => self.finish_failed(id, error.log()),
        }
    }

    fn execute_batch(self: &Arc<Self>, id: &str) {
        let (requests, concurrency, cancellation) = {
            let state = self.lock_state();
            let Some(record) = state.operations.get(id) else {
                return;
            };
            (
                Arc::clone(&record.requests),
                record.concurrency,
                record.cancellation.clone(),
            )
        };
        let next = AtomicUsize::new(0);
        thread::scope(|scope| {
            for _ in 0..concurrency {
                let service = Arc::clone(self);
                let requests = Arc::clone(&requests);
                let cancellation = cancellation.clone();
                let next = &next;
                scope.spawn(move || {
                    loop {
                        if cancellation.is_cancelled() {
                            return;
                        }
                        let item_index = next.fetch_add(1, Ordering::AcqRel);
                        let Some(request) = requests.get(item_index).cloned() else {
                            return;
                        };
                        let Some((
                            root,
                            project_id,
                            project_capability,
                            timeout,
                            completion,
                            replace,
                        )) = service.begin_item(id)
                        else {
                            return;
                        };
                        let staged = validate_project_identity(&root, &project_id)
                            .and_then(|()| {
                                service
                                    .executor
                                    .run(&root, &request, timeout, &cancellation)
                            })
                            .and_then(|prepared| {
                                service.executor.stage(
                                    &project_capability,
                                    id,
                                    &request,
                                    replace,
                                    prepared,
                                )
                            });
                        match staged {
                            Ok((staged, artifacts)) => service.commit_batch_item(
                                id,
                                item_index,
                                request.model,
                                &root,
                                &project_id,
                                &cancellation,
                                &completion,
                                staged,
                                artifacts,
                            ),
                            Err(error) => {
                                service.finish_item(id, item_index, request.model, Err(error));
                            }
                        }
                    }
                });
            }
        });
        let cancellation_failure = {
            let state = self.lock_state();
            state
                .operations
                .get(id)
                .filter(|record| record.state == OperationState::Cancelling)
                .and_then(|record| record.cancellation_failure.clone())
        };
        if let Some(log) = cancellation_failure {
            self.finish_failed(id, &log);
        } else if cancellation.is_cancelled() {
            self.finish_cancelled(id);
        } else {
            self.finish_succeeded_batch(id);
        }
    }

    fn begin_item(&self, id: &str) -> Option<BatchItemExecutionContext> {
        let mut state = self.lock_state();
        let record = state.operations.get_mut(id)?;
        if record.state != OperationState::Running || record.cancellation.is_cancelled() {
            return None;
        }
        record.active = record.active.saturating_add(1);
        record.change = record.change.saturating_add(1);
        Some((
            record.project_root.clone(),
            record.project_id.clone(),
            record.project_capability.clone(),
            Duration::from_secs(record.timeout_seconds),
            Arc::clone(&record.completion),
            record.replace,
        ))
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the Batch completion boundary keeps its Operation and Project inputs explicit"
    )]
    fn commit_batch_item(
        &self,
        id: &str,
        item_index: usize,
        model: String,
        project_root: &Path,
        project_id: &str,
        cancellation: &ModelCancellation,
        completion: &Mutex<()>,
        staged: Executor::Staged,
        artifacts: Vec<ArtifactPointer>,
    ) {
        let _completion = lock(completion, "Model Operation completion");
        let result = if cancellation.is_cancelled() {
            Err(ModelRunError::cancelled())
        } else if let Err(error) = validate_project_identity(project_root, project_id) {
            Err(error)
        } else if let Err(error) = self.claim_batch_outputs(id, &artifacts) {
            Err(error)
        } else {
            self.executor
                .commit(project_root, staged)
                .map(|()| artifacts)
        };
        self.finish_item(id, item_index, model, result);
    }

    fn claim_batch_outputs(
        &self,
        id: &str,
        artifacts: &[ArtifactPointer],
    ) -> Result<(), ModelRunError> {
        let mut item_paths = HashSet::with_capacity(artifacts.len());
        let mut state = self.lock_state();
        let record = state.operations.get_mut(id).ok_or_else(|| {
            ModelRunError::failed("Model Operation disappeared before output commit.")
        })?;
        for artifact in artifacts {
            let path = &artifact.project_relative_path;
            if !item_paths.insert(path.clone()) || record.claimed_outputs.contains(path) {
                return Err(ModelRunError::failed(format!(
                    "Batch items resolved to the same output path: {path}"
                )));
            }
        }
        record.claimed_outputs.extend(item_paths);
        Ok(())
    }

    fn finish_item(
        &self,
        id: &str,
        item_index: usize,
        model: String,
        result: Result<Vec<ArtifactPointer>, ModelRunError>,
    ) {
        {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            record.active = record.active.saturating_sub(1);
            let outcome = match result {
                Ok(artifacts) => {
                    record.succeeded = record.succeeded.saturating_add(1);
                    Some(BatchItemOutcome {
                        item_index,
                        model,
                        status: BatchItemStatus::Succeeded,
                        artifacts,
                        log: None,
                    })
                }
                Err(error) if record.cancellation.is_cancelled() => {
                    if !error.cancelled && record.cancellation_failure.is_none() {
                        record.cancellation_failure = Some(error.log);
                    }
                    None
                }
                Err(error) => {
                    record.failed = record.failed.saturating_add(1);
                    Some(BatchItemOutcome {
                        item_index,
                        model,
                        status: BatchItemStatus::Failed,
                        artifacts: Vec::new(),
                        log: Some(error.log),
                    })
                }
            };
            if let Some(outcome) = outcome {
                record.outcomes.push(outcome);
            }
            record.change = record.change.saturating_add(1);
        }
        self.changed.notify_all();
    }

    fn finish_succeeded_batch(&self, id: &str) {
        let changed = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state == OperationState::Running {
                record.state = OperationState::Succeeded;
                record.change = record.change.saturating_add(1);
                true
            } else {
                false
            }
        };
        if changed {
            self.retain_terminal(id);
            self.changed.notify_all();
        }
    }

    fn finish_cancelled(&self, id: &str) {
        let changed = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state.is_terminal() {
                false
            } else {
                record.state = OperationState::Cancelled;
                record.active = 0;
                record.change = record.change.saturating_add(1);
                true
            }
        };
        if changed {
            self.retain_terminal(id);
            self.changed.notify_all();
        }
    }

    fn finish_failed(&self, id: &str, log: &str) {
        let changed = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state.is_terminal() {
                false
            } else {
                record.state = OperationState::Failed;
                record.active = 0;
                record.log = Some(log.to_owned());
                record.change = record.change.saturating_add(1);
                true
            }
        };
        if changed {
            self.retain_terminal(id);
            self.changed.notify_all();
        }
    }

    fn retain_terminal(&self, id: &str) {
        let mut state = self.lock_state();
        if state.terminal_order.iter().any(|retained| retained == id) {
            return;
        }
        state.terminal_order.push_back(id.to_owned());
        while state.terminal_order.len() > MAX_TERMINAL_OPERATIONS {
            if let Some(retired) = state.terminal_order.pop_front() {
                state.operations.remove(&retired);
            }
        }
    }

    fn parse_cursor(&self, cursor: &str) -> Result<u64, ModelOperationError> {
        let Some((runtime_id, sequence)) = cursor.rsplit_once(':') else {
            return Err(invalid_cursor());
        };
        if runtime_id != self.runtime_id {
            return Err(invalid_cursor());
        }
        sequence.parse::<u64>().map_err(|_| invalid_cursor())
    }

    fn lock_state(&self) -> MutexGuard<'_, RegistryState> {
        lock(&self.state, "Model Operation registry")
    }

    fn wait_for_change(&self, id: &str, change: u64) {
        let state = self.lock_state();
        let _ =
            self.changed
                .wait_timeout_while(state, OBSERVER_DISCONNECT_POLL, |state| {
                    state.operations.get(id).is_some_and(|record| {
                        record.change == change && !record.state.is_terminal()
                    })
                })
                .expect("Model Operation observer wait lock poisoned");
    }
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    mutex
        .lock()
        .unwrap_or_else(|_| panic!("{name} lock poisoned"))
}

/// Parses the complete strict JSONL input for one Model Operation.
///
/// # Errors
///
/// Returns `invalid_input` for oversized, non-UTF-8, blank, malformed, or shape-mismatched input.
pub fn parse_model_requests(
    source: &[u8],
    shape: ExecutionShape,
) -> Result<Vec<ModelRequest>, ModelOperationError> {
    if source.len() > MAX_MODEL_OPERATION_INPUT_BYTES {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Model Request input exceeds 16 MiB.",
        ));
    }
    if source.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Model Request JSONL must not contain a UTF-8 BOM.",
        ));
    }
    let source = std::str::from_utf8(source).map_err(|_| {
        ModelOperationError::new("invalid_input", "Model Request input must be UTF-8 JSONL.")
    })?;
    let source = source.strip_suffix('\n').unwrap_or(source);
    let mut requests = Vec::new();
    for (index, line) in source.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            return Err(ModelOperationError::new(
                "invalid_input",
                format!("Model Request JSONL line {} is blank.", index + 1),
            ));
        }
        let request = serde_json::from_str::<ModelRequest>(line.trim()).map_err(|error| {
            ModelOperationError::new(
                "invalid_input",
                format!("Model Request JSONL line {} is invalid: {error}", index + 1),
            )
        })?;
        requests.push(request);
    }
    match (shape, requests.len()) {
        (ExecutionShape::Single, 1) | (ExecutionShape::Batch, 1..) => Ok(requests),
        (ExecutionShape::Single, _) => Err(ModelOperationError::new(
            "invalid_input",
            "Single Model Request input must contain exactly one JSONL record.",
        )),
        (ExecutionShape::Batch, 0) => Err(ModelOperationError::new(
            "invalid_input",
            "Batch Model Request input must contain at least one JSONL record.",
        )),
    }
}

fn validate_project(
    root: &Path,
) -> Result<(PathBuf, String, ProjectCapabilityFs), ModelOperationError> {
    let root = root
        .canonicalize()
        .map_err(|error| ModelOperationError::new("project_invalid", error.to_string()))?;
    if !root.is_dir() {
        return Err(ModelOperationError::new(
            "project_invalid",
            "Project root must be a directory.",
        ));
    }
    let capability = ProjectCapabilityFs::open_current(&root)
        .map_err(|error| ModelOperationError::new("project_invalid", error.to_string()))?;
    let metadata = capability
        .read_limited(PROJECT_FILE, MAX_PROJECT_METADATA_BYTES)
        .map_err(|error| ModelOperationError::new("project_invalid", error.to_string()))?;
    let metadata = serde_json::from_slice::<DebruteProjectMetadata>(&metadata)
        .map_err(|error| ModelOperationError::new("project_invalid", error.to_string()))?;
    if !is_valid_stable_project_id(&metadata.project.id)
        || metadata.project.name.is_empty()
        || metadata.project.created_at.is_empty()
        || metadata.project.updated_at.is_empty()
    {
        return Err(ModelOperationError::new(
            "project_invalid",
            "Debrute Project metadata is invalid.",
        ));
    }
    Ok((root, metadata.project.id, capability))
}

fn validate_project_identity(root: &Path, expected_id: &str) -> Result<(), ModelRunError> {
    let (_, current_id, _) =
        validate_project(root).map_err(|error| ModelRunError::failed(error.to_string()))?;
    if current_id == expected_id {
        Ok(())
    } else {
        Err(ModelRunError::failed(
            "Project identity changed before Model output commit.",
        ))
    }
}

fn validate_shape(
    shape: ExecutionShape,
    requests: &[ModelRequest],
    concurrency: Option<usize>,
) -> Result<(), ModelOperationError> {
    if requests.is_empty() || shape == ExecutionShape::Single && requests.len() != 1 {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Execution Shape does not match the Model Request count.",
        ));
    }
    if concurrency.is_some_and(|value| value == 0) {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Batch concurrency must be positive.",
        ));
    }
    if shape == ExecutionShape::Single && concurrency.is_some() {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Single Model Operations do not accept Batch concurrency.",
        ));
    }
    Ok(())
}

fn validate_model_request(request: &ModelRequest) -> Result<(), ModelOperationError> {
    if request.model.trim().is_empty() || request.model != request.model.trim() {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Model Request model must be non-empty and unpadded.",
        ));
    }
    let Some(output) = &request.output else {
        return Ok(());
    };
    if output.directory.is_none() && output.filename.is_none() {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Model Request output must specify directory or filename.",
        ));
    }
    if let Some(directory) = &output.directory
        && directory != "."
    {
        let probe = format!("{directory}/debrute-output");
        assert_project_tree_visible_mutation_path(&probe)
            .map_err(|error| ModelOperationError::new("invalid_input", error.to_string()))?;
    }
    if let Some(filename) = &output.filename {
        normalize_project_path_basename(filename)
            .map_err(|error| ModelOperationError::new("invalid_input", error.to_string()))?;
    }
    Ok(())
}

fn operation_not_found() -> ModelOperationError {
    ModelOperationError::new("operation_not_found", "Model Operation was not found.")
}

fn invalid_cursor() -> ModelOperationError {
    ModelOperationError::new("invalid_cursor", "Operation list cursor is invalid.")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs,
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use serde_json::{Map, json};
    use uuid::Uuid;

    use super::*;

    struct FixtureExecutor {
        outcomes: Mutex<VecDeque<Result<Vec<ArtifactPointer>, ModelRunError>>>,
    }

    struct CleanupFailureExecutor {
        started: Arc<AtomicBool>,
    }

    struct CancellableExecutor {
        started: Arc<AtomicBool>,
    }

    struct BlockingCommitExecutor {
        commit_started: Arc<AtomicBool>,
        release: Arc<AtomicBool>,
    }

    struct MaterializingExecutor {
        executed_request: Arc<Mutex<Option<ModelRequest>>>,
    }

    impl ModelOperationExecutor for CancellableExecutor {
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn validate(&self, _request: &mut ModelRequest) -> Result<ModelKind, ModelRunError> {
            Ok(ModelKind::Image)
        }

        fn run(
            &self,
            _project_root: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRunError> {
            self.started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                thread::yield_now();
            }
            Err(ModelRunError::cancelled())
        }

        fn stage(
            &self,
            _project_capability: &ProjectCapabilityFs,
            _operation_id: &str,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(&self, _project_root: &Path, _staged: Self::Staged) -> Result<(), ModelRunError> {
            Ok(())
        }
    }

    impl ModelOperationExecutor for BlockingCommitExecutor {
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn validate(&self, _request: &mut ModelRequest) -> Result<ModelKind, ModelRunError> {
            Ok(ModelKind::Image)
        }

        fn run(
            &self,
            _project_root: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRunError> {
            cancellation.check()?;
            Ok(Vec::new())
        }

        fn stage(
            &self,
            _project_capability: &ProjectCapabilityFs,
            _operation_id: &str,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(&self, _project_root: &Path, _staged: Self::Staged) -> Result<(), ModelRunError> {
            self.commit_started.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) {
                thread::yield_now();
            }
            Ok(())
        }
    }

    impl ModelOperationExecutor for CleanupFailureExecutor {
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn validate(&self, _request: &mut ModelRequest) -> Result<ModelKind, ModelRunError> {
            Ok(ModelKind::Image)
        }

        fn run(
            &self,
            _project_root: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRunError> {
            self.started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                thread::yield_now();
            }
            Err(ModelRunError::failed("cleanup failed"))
        }

        fn stage(
            &self,
            _project_capability: &ProjectCapabilityFs,
            _operation_id: &str,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(&self, _project_root: &Path, _staged: Self::Staged) -> Result<(), ModelRunError> {
            Ok(())
        }
    }

    impl ModelOperationExecutor for MaterializingExecutor {
        type Prepared = ();
        type Staged = ();

        fn validate(&self, request: &mut ModelRequest) -> Result<ModelKind, ModelRunError> {
            request
                .arguments
                .entry("delivery".to_owned())
                .or_insert_with(|| json!("inline"));
            Ok(ModelKind::Image)
        }

        fn run(
            &self,
            _project_root: &Path,
            request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRunError> {
            cancellation.check()?;
            *self.executed_request.lock().expect("executed request") = Some(request.clone());
            Ok(())
        }

        fn stage(
            &self,
            _project_capability: &ProjectCapabilityFs,
            _operation_id: &str,
            _request: &ModelRequest,
            _replace: bool,
            _prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
            Ok(((), Vec::new()))
        }

        fn commit(&self, _project_root: &Path, _staged: Self::Staged) -> Result<(), ModelRunError> {
            Ok(())
        }
    }

    impl ModelOperationExecutor for FixtureExecutor {
        type Prepared = Result<Vec<ArtifactPointer>, ModelRunError>;
        type Staged = ();

        fn validate(&self, request: &mut ModelRequest) -> Result<ModelKind, ModelRunError> {
            Ok(if request.model.starts_with("video-") {
                ModelKind::Video
            } else {
                ModelKind::Image
            })
        }

        fn run(
            &self,
            _project_root: &std::path::Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRunError> {
            cancellation.check()?;
            Ok(self
                .outcomes
                .lock()
                .expect("fixture outcomes")
                .pop_front()
                .expect("fixture outcome"))
        }

        fn stage(
            &self,
            _project_capability: &ProjectCapabilityFs,
            _operation_id: &str,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
            prepared.map(|artifacts| ((), artifacts))
        }

        fn commit(
            &self,
            _project_root: &std::path::Path,
            _staged: Self::Staged,
        ) -> Result<(), ModelRunError> {
            Ok(())
        }
    }

    #[test]
    fn accepted_single_is_owned_by_runtime_until_terminal() {
        let fixture = Fixture::new(vec![Ok(vec![artifact("generated/cover.jpg")])]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .expect("submission should be accepted");
        assert!(matches!(
            accepted.state,
            OperationState::Queued | OperationState::Running
        ));
        let observed = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .expect("accepted Operation should remain observable")
            .expect("test observer remains connected");
        assert_eq!(observed.state, OperationState::Succeeded);
        assert_eq!(observed.execution.single_artifacts().len(), 1);
    }

    #[test]
    fn validation_materialization_is_the_request_executed_after_acceptance() {
        let fixture = Fixture::new(Vec::new());
        let executed_request = Arc::new(Mutex::new(None));
        let service = Arc::new(ModelOperationService::new(Arc::new(
            MaterializingExecutor {
                executed_request: Arc::clone(&executed_request),
            },
        )));
        let accepted = service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .expect("materialized request should be accepted");
        let terminal = service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .expect("materialized operation")
            .expect("observer remains connected");
        assert_eq!(terminal.state, OperationState::Succeeded);
        let executed = executed_request
            .lock()
            .expect("executed request")
            .clone()
            .expect("worker received request");
        assert_eq!(executed.arguments.get("delivery"), Some(&json!("inline")));
    }

    #[test]
    fn batch_item_failures_are_retained_in_settlement_order_but_batch_succeeds() {
        let fixture = Fixture::new(vec![
            Err(ModelRunError::failed("first failed")),
            Ok(vec![artifact("generated/second.jpg")]),
        ]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![request("image-one"), request("image-two")],
                concurrency: Some(1),
                timeout_seconds: Some(60),
                replace: false,
            })
            .expect("batch should be accepted");
        let mut outcomes = Vec::new();
        let terminal = fixture
            .service
            .wait(
                &accepted.id,
                || true,
                |_| true,
                |outcome| {
                    outcomes.push(outcome.clone());
                    true
                },
            )
            .expect("batch wait should finish")
            .expect("test observer remains connected");
        assert_eq!(terminal.state, OperationState::Succeeded);
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0].item_index, 0);
        assert_eq!(outcomes[0].status(), BatchItemStatus::Failed);
        assert_eq!(outcomes[1].item_index, 1);
        assert_eq!(outcomes[1].status(), BatchItemStatus::Succeeded);
        assert_eq!(terminal.execution.batch_counts(), Some((0, 1, 1)));
    }

    #[test]
    fn a_disconnected_command_observer_stops_waiting_without_affecting_the_operation() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .expect("submission");
        let observed = fixture
            .service
            .wait(&accepted.id, || false, |_| true, |_| true)
            .expect("known Operation");
        assert!(observed.is_none());
        assert!(fixture.service.inspect(&accepted.id).is_ok());
    }

    #[test]
    fn cancellation_cleanup_failure_fails_the_batch_after_local_work_drains() {
        let root = std::env::temp_dir().join(format!("debrute-operation-{}", Uuid::new_v4()));
        let project = root.join("project");
        fs::create_dir_all(project.join(".debrute")).unwrap();
        fs::write(
            project.join(".debrute/project.json"),
            serde_json::to_vec(&json!({
                "project": {
                    "id": Uuid::new_v4().to_string(),
                    "name": "Fixture",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let service = Arc::new(ModelOperationService::new(Arc::new(
            CleanupFailureExecutor {
                started: Arc::clone(&started),
            },
        )));
        let accepted = service
            .submit(SubmitModelOperation {
                project_root: project,
                shape: ExecutionShape::Batch,
                requests: vec![request("image-model")],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !started.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(started.load(Ordering::Acquire));
        assert_eq!(
            service.cancel(&accepted.id).unwrap().state,
            OperationState::Cancelling
        );
        let terminal = service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, OperationState::Failed);
        assert_eq!(terminal.log.as_deref(), Some("cleanup failed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_or_running_cancellation_is_idempotent_and_terminal_success_rejects_cancel() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: Some(60),
                replace: false,
            })
            .expect("single should be accepted");
        let first = fixture.service.cancel(&accepted.id);
        match first {
            Ok(snapshot) => assert!(matches!(
                snapshot.state,
                OperationState::Cancelling | OperationState::Cancelled
            )),
            Err(error) => assert_eq!(error.code(), "operation_already_terminal"),
        }
        let terminal = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .expect("wait")
            .expect("test observer remains connected");
        match terminal.state {
            OperationState::Cancelled => {
                assert_eq!(
                    fixture
                        .service
                        .cancel(&accepted.id)
                        .expect("repeat cancel")
                        .state,
                    OperationState::Cancelled
                );
            }
            OperationState::Succeeded => {
                assert_eq!(
                    fixture.service.cancel(&accepted.id).unwrap_err().code(),
                    "operation_already_terminal"
                );
            }
            state => panic!("unexpected terminal state: {state:?}"),
        }
    }

    #[test]
    fn list_is_newest_first_cursor_scoped_and_terminal_retention_is_bounded() {
        let fixture = Fixture::new((0..105).map(|_| Ok(Vec::new())).collect());
        for index in 0..105 {
            let accepted = fixture
                .service
                .submit(SubmitModelOperation {
                    project_root: fixture.project.clone(),
                    shape: ExecutionShape::Single,
                    requests: vec![request(&format!("image-{index}"))],
                    concurrency: None,
                    timeout_seconds: None,
                    replace: false,
                })
                .expect("submission");
            fixture
                .service
                .wait(&accepted.id, || true, |_| true, |_| true)
                .expect("wait")
                .expect("test observer remains connected");
        }
        let first = fixture
            .service
            .list(&ModelOperationListQuery {
                limit: 25,
                ..ModelOperationListQuery::default()
            })
            .expect("first page");
        assert_eq!(first.operations.len(), 25);
        assert!(first.next_cursor.is_some());
        let second = fixture
            .service
            .list(&ModelOperationListQuery {
                limit: 100,
                cursor: first.next_cursor,
                ..ModelOperationListQuery::default()
            })
            .expect("second page");
        assert_eq!(second.operations.len(), 75);
        assert_eq!(fixture.service.retained_terminal_count(), 100);
        assert_eq!(
            fixture
                .service
                .list(&ModelOperationListQuery {
                    cursor: Some("another-runtime:1".to_owned()),
                    ..ModelOperationListQuery::default()
                })
                .unwrap_err()
                .code(),
            "invalid_cursor"
        );
    }

    #[test]
    fn strict_jsonl_has_one_shape_contract_and_a_complete_source_limit() {
        let one = parse_model_requests(
            b"{\"model\":\"image-model\",\"arguments\":{}}\n",
            ExecutionShape::Single,
        )
        .expect("one JSONL record");
        assert_eq!(one.len(), 1);
        for source in [
            b"\n".as_slice(),
            b"# comment\n".as_slice(),
            b"\xef\xbb\xbf{\"model\":\"image-model\",\"arguments\":{}}\n".as_slice(),
            b"{\"model\":\"image-model\",\"arguments\":{}}\n\n".as_slice(),
        ] {
            assert!(parse_model_requests(source, ExecutionShape::Batch).is_err());
        }
        let two = b"{\"model\":\"image-model\",\"arguments\":{}}\n{\"model\":\"image-model\",\"arguments\":{}}\n";
        assert!(parse_model_requests(two, ExecutionShape::Single).is_err());
        assert_eq!(
            parse_model_requests(
                &vec![b'x'; MAX_MODEL_OPERATION_INPUT_BYTES + 1],
                ExecutionShape::Batch
            )
            .unwrap_err()
            .code(),
            "invalid_input"
        );
    }

    #[test]
    fn project_identity_recheck_rejects_a_replaced_root() {
        let fixture = Fixture::new(Vec::new());
        let (_, accepted_id, _) = validate_project(&fixture.project).unwrap();
        let replacement_id = Uuid::new_v4().to_string();
        fs::write(
            fixture.project.join(".debrute/project.json"),
            serde_json::to_vec(&json!({
                "project": {
                    "id": replacement_id,
                    "name": "Replacement",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(validate_project_identity(&fixture.project, &accepted_id).is_err());
    }

    #[test]
    fn project_filter_matches_the_current_stable_identity_not_reused_path_text() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        fs::write(
            fixture.project.join(PROJECT_FILE),
            serde_json::to_vec(&json!({
                "project": {
                    "id": Uuid::new_v4().to_string(),
                    "name": "Replacement",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let listed = fixture
            .service
            .list(&ModelOperationListQuery {
                project_root: Some(fixture.project.clone()),
                ..ModelOperationListQuery::default()
            })
            .unwrap();
        assert!(listed.operations.is_empty());
    }

    #[test]
    fn runtime_shutdown_cancels_and_joins_owned_operation_workers() {
        let fixture = Fixture::new(Vec::new());
        let started = Arc::new(AtomicBool::new(false));
        let service = Arc::new(ModelOperationService::new(Arc::new(CancellableExecutor {
            started: Arc::clone(&started),
        })));
        let accepted = service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        wait_for_flag(&started);
        service.shutdown();
        assert_eq!(
            service.inspect(&accepted.id).unwrap().state,
            OperationState::Cancelled
        );
        assert!(lock(&service.workers, "Model Operation worker registry").is_empty());
    }

    #[test]
    fn a_single_commit_does_not_block_unrelated_registry_inspection() {
        let fixture = Fixture::new(Vec::new());
        let commit_started = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let service = Arc::new(ModelOperationService::new(Arc::new(
            BlockingCommitExecutor {
                commit_started: Arc::clone(&commit_started),
                release: Arc::clone(&release),
            },
        )));
        let accepted = service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        wait_for_flag(&commit_started);
        let (sender, receiver) = mpsc::sync_channel(1);
        let inspection_service = Arc::clone(&service);
        let operation_id = accepted.id.clone();
        let inspection = thread::spawn(move || {
            sender
                .send(inspection_service.inspect(&operation_id))
                .unwrap();
        });
        let snapshot = receiver
            .recv_timeout(Duration::from_millis(200))
            .expect("registry inspection must not wait for Model output commit")
            .unwrap();
        assert_eq!(snapshot.state, OperationState::Running);
        release.store(true, Ordering::Release);
        inspection.join().unwrap();
        let terminal = service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, OperationState::Succeeded);
    }

    #[test]
    fn batch_rejects_names_that_resolve_to_the_same_default_directory() {
        let fixture = Fixture::new(Vec::new());
        let mut first = request("image-one");
        first.output = Some(ModelOutput {
            directory: None,
            filename: Some("cover".to_owned()),
        });
        let mut second = request("image-two");
        second.output = first.output.clone();

        let error = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![first, second],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .unwrap_err();

        assert_eq!(error.code(), "invalid_input");
        assert!(
            fixture
                .service
                .list(&ModelOperationListQuery::default())
                .unwrap()
                .operations
                .is_empty()
        );
    }

    #[test]
    fn batch_rejects_output_paths_that_collide_after_artifact_naming() {
        let shared = artifact("generated/cover_1.jpg");
        let fixture = Fixture::new(vec![Ok(vec![shared.clone()]), Ok(vec![shared])]);
        let mut first = request("image-one");
        first.output = Some(ModelOutput {
            directory: Some("generated".to_owned()),
            filename: Some("cover".to_owned()),
        });
        let mut second = request("image-two");
        second.output = Some(ModelOutput {
            directory: Some("generated".to_owned()),
            filename: Some("cover_1".to_owned()),
        });
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                project_root: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![first, second],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: true,
            })
            .unwrap();

        let terminal = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, OperationState::Succeeded);
        let ModelOperationExecution::Batch {
            succeeded, failed, ..
        } = terminal.execution
        else {
            panic!("expected Batch execution");
        };
        assert_eq!((succeeded, failed), (1, 1));
        let outcomes = fixture
            .service
            .lock_state()
            .operations
            .get(&accepted.id)
            .unwrap()
            .outcomes
            .clone();
        assert_eq!(outcomes[1].status, BatchItemStatus::Failed);
        assert_eq!(
            outcomes[1].log.as_deref(),
            Some("Batch items resolved to the same output path: generated/cover_1.jpg")
        );
    }

    fn request(model: &str) -> ModelRequest {
        ModelRequest {
            model: model.to_owned(),
            arguments: Map::new(),
            output: None,
        }
    }

    fn artifact(path: &str) -> ArtifactPointer {
        ArtifactPointer {
            artifact_index: 0,
            role: crate::project::GeneratedArtifactRole::PrimaryImage,
            project_relative_path: path.to_owned(),
            mime_type: "image/jpeg".to_owned(),
            width: Some(1024),
            height: Some(1024),
        }
    }

    fn wait_for_flag(flag: &AtomicBool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !flag.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "fixture worker did not start");
            thread::yield_now();
        }
    }

    struct Fixture {
        root: PathBuf,
        project: PathBuf,
        service: Arc<ModelOperationService<FixtureExecutor>>,
    }

    impl Fixture {
        fn new(outcomes: Vec<Result<Vec<ArtifactPointer>, ModelRunError>>) -> Self {
            let root = std::env::temp_dir().join(format!("debrute-operation-{}", Uuid::new_v4()));
            let project = root.join("project");
            fs::create_dir_all(project.join(".debrute")).expect("Project directory");
            fs::write(
                project.join(".debrute/project.json"),
                serde_json::to_vec_pretty(&json!({
                    "project": {
                        "id": Uuid::new_v4().to_string(),
                        "name": "Fixture",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }
                }))
                .expect("metadata"),
            )
            .expect("Project metadata");
            let service = Arc::new(ModelOperationService::new(Arc::new(FixtureExecutor {
                outcomes: Mutex::new(VecDeque::from(outcomes)),
            })));
            Self {
                root,
                project,
                service,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
