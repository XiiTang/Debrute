use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fmt, fs, io,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::now_rfc3339;

pub const MAX_MODEL_OPERATION_INPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TERMINAL_OPERATIONS: usize = 100;
const DEFAULT_BATCH_CONCURRENCY: usize = 1;
const DEFAULT_MODEL_TIMEOUT_SECONDS: u64 = 10 * 60;
const DEFAULT_VIDEO_TIMEOUT_SECONDS: u64 = 30 * 60;
const OBSERVER_DISCONNECT_POLL: Duration = Duration::from_millis(100);
const MAX_OPERATION_DIAGNOSTICS: usize = 64;

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
    pub directory: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRequest {
    pub model: String,
    pub arguments: Map<String, Value>,
    pub output: ModelOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPointer {
    pub artifact_index: u64,
    pub output_path: String,
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
    pub state: OperationState,
    pub accepted_at: String,
    pub execution: ModelOperationExecution,
    pub diagnostics: Vec<ModelOperationDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOperationDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ModelOperationCommitWarnings {
    pub provenance_failures: usize,
    pub artifact_cleanup_failures: usize,
}

pub(crate) type ModelOperationObserver = Arc<dyn Fn(ModelOperationSnapshot) + Send + Sync>;

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
    pub invocation_cwd: PathBuf,
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
    pub limit: usize,
    pub cursor: Option<String>,
}

impl Default for ModelOperationListQuery {
    fn default() -> Self {
        Self {
            state: None,
            model_kind: None,
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
pub struct ModelRequestExecutionError {
    code: &'static str,
    log: String,
    cancelled: bool,
}

impl ModelRequestExecutionError {
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
            log: "Model request was cancelled.".to_owned(),
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

impl fmt::Display for ModelRequestExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.log)
    }
}

impl std::error::Error for ModelRequestExecutionError {}

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
    pub fn check(&self) -> Result<(), ModelRequestExecutionError> {
        if self.is_cancelled() {
            Err(ModelRequestExecutionError::cancelled())
        } else {
            Ok(())
        }
    }
}

pub(crate) trait ModelOperationExecutor: Send + Sync + 'static {
    type ConfigSnapshot;
    type ModelBinding: Send + Sync + 'static;
    type Prepared: Send + 'static;
    type Staged: Send + 'static;

    /// Captures the complete configuration used to accept one submission.
    ///
    /// # Errors
    ///
    /// Returns an internal validation error when configuration cannot be read.
    fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError>;

    /// Resolves one unique Model from the submission configuration snapshot.
    ///
    /// # Errors
    ///
    /// Returns a closed validation error when the Model cannot be bound.
    fn bind_model(
        &self,
        snapshot: &Self::ConfigSnapshot,
        model_id: &str,
    ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError>;

    /// Materializes and validates one request against its accepted Model binding.
    ///
    /// # Errors
    ///
    /// Returns a closed validation error when the request cannot be executed.
    fn validate_request(
        &self,
        binding: &Self::ModelBinding,
        request: &mut ModelRequest,
    ) -> Result<(), ModelRequestExecutionError>;

    /// Performs the interruptible Model request without publishing artifacts.
    ///
    /// # Errors
    ///
    /// Returns a model, timeout, transport, or cancellation error.
    fn run(
        &self,
        binding: &Self::ModelBinding,
        invocation_cwd: &Path,
        request: &ModelRequest,
        timeout: Duration,
        cancellation: &ModelCancellation,
    ) -> Result<Self::Prepared, ModelRequestExecutionError>;

    /// Stages completed output bytes without publishing their target paths.
    ///
    /// # Errors
    ///
    /// Returns an error when artifact staging or provenance preparation fails.
    fn stage(
        &self,
        binding: &Self::ModelBinding,
        operation_id: &str,
        item_index: usize,
        request: &ModelRequest,
        replace: bool,
        prepared: Self::Prepared,
    ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError>;

    /// Publishes already-staged outputs and their provenance at the short,
    /// non-interruptible completion boundary.
    ///
    /// # Errors
    ///
    /// Returns an error when artifact publication fails. The successful result
    /// reports bounded cleanup and provenance warnings after publication.
    fn commit(
        &self,
        staged: Self::Staged,
    ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError>;
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

struct AcceptedModelRequest<ModelBinding> {
    request: ModelRequest,
    binding: Option<Arc<ModelBinding>>,
}

struct OperationRecord<ModelBinding> {
    sequence: u64,
    id: String,
    model_kind: ModelKind,
    invocation_cwd: PathBuf,
    state: OperationState,
    accepted_at: String,
    accepted_requests: Vec<AcceptedModelRequest<ModelBinding>>,
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
    log: Option<String>,
    cancellation_failure: Option<String>,
    provenance_failures: usize,
    artifact_cleanup_failures: usize,
    diagnostics: Vec<ModelOperationDiagnostic>,
    change: u64,
}

impl<ModelBinding> OperationRecord<ModelBinding> {
    fn snapshot(&self) -> ModelOperationSnapshot {
        let execution = match self.shape {
            ExecutionShape::Single => ModelOperationExecution::Single {
                model: self.accepted_requests[0].request.model.clone(),
                timeout_seconds: self.timeout_seconds,
                artifacts: self.single_artifacts.clone(),
            },
            ExecutionShape::Batch => ModelOperationExecution::Batch {
                item_count: self.accepted_requests.len(),
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
            state: self.state,
            accepted_at: self.accepted_at.clone(),
            execution,
            diagnostics: self.diagnostics.clone(),
            log: self.log.clone(),
        }
    }

    fn release_model_bindings(&mut self) {
        for accepted in &mut self.accepted_requests {
            accepted.binding = None;
        }
    }
}

struct RegistryState<ModelBinding> {
    next_sequence: u64,
    operations: HashMap<String, OperationRecord<ModelBinding>>,
    terminal_order: VecDeque<String>,
}

struct PendingModelOperationObservation {
    revision: u64,
    observer: Option<ModelOperationObserver>,
    snapshot: ModelOperationSnapshot,
}

struct ModelOperationObserverDispatch {
    next_revision: u64,
    pending: BTreeMap<u64, PendingModelOperationObservation>,
    draining: bool,
}

#[allow(private_bounds)]
pub struct ModelOperationService<Executor: ModelOperationExecutor> {
    executor: Arc<Executor>,
    runtime_id: String,
    state: Mutex<RegistryState<Executor::ModelBinding>>,
    changed: Condvar,
    observer: Mutex<Option<ModelOperationObserver>>,
    observer_revision: AtomicU64,
    observer_dispatch: Mutex<ModelOperationObserverDispatch>,
    workers: Mutex<HashMap<String, thread::JoinHandle<()>>>,
    lifecycle: Mutex<()>,
    shutting_down: AtomicBool,
}

struct ValidatedSubmission<ModelBinding> {
    invocation_cwd: PathBuf,
    model_kind: ModelKind,
    timeout_seconds: u64,
    concurrency: usize,
    accepted_requests: Vec<AcceptedModelRequest<ModelBinding>>,
}

type BatchItemExecutionContext<ModelBinding> = (
    PathBuf,
    ModelRequest,
    Duration,
    Arc<Mutex<()>>,
    bool,
    Arc<ModelBinding>,
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
            observer: Mutex::new(None),
            observer_revision: AtomicU64::new(1),
            observer_dispatch: Mutex::new(ModelOperationObserverDispatch {
                next_revision: 1,
                pending: BTreeMap::new(),
                draining: false,
            }),
            workers: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub(crate) fn install_observer(&self, observer: ModelOperationObserver) -> bool {
        let mut installed = lock(&self.observer, "Model Operation observer");
        if installed.is_some() {
            return false;
        }
        *installed = Some(observer);
        true
    }

    /// Validates and atomically accepts one Model Operation.
    ///
    /// # Errors
    ///
    /// Returns a closed input, executor-validation, or task-start error before
    /// acceptance. An execution task that cannot start after acceptance is recorded as failed.
    ///
    /// # Panics
    ///
    /// Panics if the Runtime exhausts its process-local Operation sequence.
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

        let (snapshot, observation) = {
            let mut state = self.lock_state();
            let sequence = state.next_sequence;
            state.next_sequence = state
                .next_sequence
                .checked_add(1)
                .expect("Model Operation sequence exhausted");
            let record = OperationRecord {
                sequence,
                id: id.clone(),
                model_kind: validated.model_kind,
                invocation_cwd: validated.invocation_cwd,
                state: OperationState::Queued,
                accepted_at,
                accepted_requests: validated.accepted_requests,
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
                log: None,
                cancellation_failure: None,
                provenance_failures: 0,
                artifact_cleanup_failures: 0,
                diagnostics: Vec::new(),
                change: 1,
            };
            let snapshot = record.snapshot();
            state.operations.insert(id.clone(), record);
            let observation = self.prepare_observed(snapshot.clone());
            (snapshot, observation)
        };
        self.publish_observed(observation);
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
    ) -> Result<ValidatedSubmission<Executor::ModelBinding>, ModelOperationError> {
        let invocation_cwd = validate_invocation_cwd(&input.invocation_cwd)?;
        validate_shape(input.shape, &input.requests, input.concurrency)?;
        for request in &mut input.requests {
            validate_model_request(request)?;
            request.output.directory =
                validate_output_directory(&request.output.directory, &invocation_cwd)?
                    .to_string_lossy()
                    .into_owned();
        }
        let config_snapshot = self
            .executor
            .read_config_snapshot()
            .map_err(|error| ModelOperationError::new(error.code(), error.log().to_owned()))?;
        let mut bindings_by_model =
            HashMap::<String, (ModelKind, Arc<Executor::ModelBinding>)>::new();
        let mut model_kind = None;
        let requests = std::mem::take(&mut input.requests);
        let mut accepted_requests = Vec::with_capacity(requests.len());
        for mut request in requests {
            let model_id = request.model.clone();
            let (kind, binding) = if let Some((kind, binding)) = bindings_by_model.get(&model_id) {
                (*kind, Arc::clone(binding))
            } else {
                let (kind, binding) = self
                    .executor
                    .bind_model(&config_snapshot, &model_id)
                    .map_err(|error| {
                        ModelOperationError::new(error.code(), error.log().to_owned())
                    })?;
                let binding = Arc::new(binding);
                bindings_by_model.insert(model_id, (kind, Arc::clone(&binding)));
                (kind, binding)
            };
            self.executor
                .validate_request(&binding, &mut request)
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
            accepted_requests.push(AcceptedModelRequest {
                request,
                binding: Some(binding),
            });
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
                "Model request timeout must be representable and positive.",
            ));
        }
        let concurrency = match input.shape {
            ExecutionShape::Single => 1,
            ExecutionShape::Batch => input
                .concurrency
                .unwrap_or(DEFAULT_BATCH_CONCURRENCY)
                .min(accepted_requests.len()),
        };
        if concurrency == 0 {
            return Err(ModelOperationError::new(
                "invalid_input",
                "Batch concurrency must be positive.",
            ));
        }
        Ok(ValidatedSubmission {
            invocation_cwd,
            model_kind,
            timeout_seconds,
            concurrency,
            accepted_requests,
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
        let (snapshot, observation) = {
            let mut state = self.lock_state();
            let record = state
                .operations
                .get_mut(id)
                .ok_or_else(operation_not_found)?;
            let changed = match record.state {
                OperationState::Queued => {
                    record.cancellation.cancel();
                    record.state = OperationState::Cancelled;
                    record.release_model_bindings();
                    record.change += 1;
                    true
                }
                OperationState::Running => {
                    record.cancellation.cancel();
                    record.state = OperationState::Cancelling;
                    record.change += 1;
                    true
                }
                OperationState::Cancelling | OperationState::Cancelled => false,
                OperationState::Succeeded | OperationState::Failed => {
                    return Err(ModelOperationError::new(
                        "operation_already_terminal",
                        "Model Operation already completed.",
                    )
                    .with_snapshot(record.snapshot()));
                }
            };
            let snapshot = record.snapshot();
            let observation = changed.then(|| self.prepare_observed(snapshot.clone()));
            (snapshot, observation)
        };
        let changed = observation.is_some();
        if let Some(observation) = observation {
            self.publish_observed(observation);
        }
        if changed && snapshot.state == OperationState::Cancelled {
            self.retain_terminal(id);
        }
        self.changed.notify_all();
        Ok(snapshot)
    }

    /// Lists retained Operations newest first.
    ///
    /// # Errors
    ///
    /// Returns an input or cursor error when a filter is invalid.
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
        let (shape, observation) = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state != OperationState::Queued {
                return;
            }
            record.state = OperationState::Running;
            record.change += 1;
            let snapshot = record.snapshot();
            let shape = record.shape;
            let observation = self.prepare_observed(snapshot);
            (shape, observation)
        };
        self.publish_observed(observation);
        self.changed.notify_all();
        match shape {
            ExecutionShape::Single => self.execute_single(id),
            ExecutionShape::Batch => self.execute_batch(id),
        }
    }

    fn execute_single(&self, id: &str) {
        let (cwd, request, binding, timeout, cancellation, completion, replace) = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            let accepted = record
                .accepted_requests
                .get_mut(0)
                .expect("running Single Operation must own one accepted request");
            let request = accepted.request.clone();
            let binding = accepted
                .binding
                .take()
                .expect("running Single Operation must own its accepted Model binding");
            (
                record.invocation_cwd.clone(),
                request,
                binding,
                Duration::from_secs(record.timeout_seconds),
                record.cancellation.clone(),
                Arc::clone(&record.completion),
                record.replace,
            )
        };
        let staged = self
            .executor
            .run(&binding, &cwd, &request, timeout, &cancellation)
            .and_then(|prepared| {
                self.executor
                    .stage(&binding, id, 0, &request, replace, prepared)
            });
        drop(binding);
        match staged {
            Ok((staged, artifacts)) => {
                let _completion = lock(&completion, "Model Operation completion");
                if cancellation.is_cancelled() {
                    self.finish_cancelled(id);
                    return;
                }
                let committed = self.executor.commit(staged);
                match committed {
                    Ok(warnings) => {
                        let observation = {
                            let mut state = self.lock_state();
                            let Some(record) = state.operations.get_mut(id) else {
                                return;
                            };
                            record.single_artifacts = artifacts;
                            record_commit_warnings(record, warnings);
                            record.state = OperationState::Succeeded;
                            record.release_model_bindings();
                            record.change += 1;
                            let snapshot = record.snapshot();
                            self.prepare_observed(snapshot)
                        };
                        self.publish_observed(observation);
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
        let (item_count, concurrency, cancellation) = {
            let state = self.lock_state();
            let Some(record) = state.operations.get(id) else {
                return;
            };
            (
                record.accepted_requests.len(),
                record.concurrency,
                record.cancellation.clone(),
            )
        };
        let next = AtomicUsize::new(0);
        thread::scope(|scope| {
            for _ in 0..concurrency {
                let service = Arc::clone(self);
                let cancellation = cancellation.clone();
                let next = &next;
                scope.spawn(move || {
                    loop {
                        if cancellation.is_cancelled() {
                            return;
                        }
                        let item_index = next.fetch_add(1, Ordering::AcqRel);
                        if item_index >= item_count {
                            return;
                        }
                        let Some((cwd, request, timeout, completion, replace, binding)) =
                            service.begin_item(id, item_index)
                        else {
                            return;
                        };
                        let staged = service
                            .executor
                            .run(&binding, &cwd, &request, timeout, &cancellation)
                            .and_then(|prepared| {
                                service
                                    .executor
                                    .stage(&binding, id, item_index, &request, replace, prepared)
                            });
                        drop(binding);
                        match staged {
                            Ok((staged, artifacts)) => service.commit_batch_item(
                                id,
                                item_index,
                                request.model,
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

    fn begin_item(
        &self,
        id: &str,
        item_index: usize,
    ) -> Option<BatchItemExecutionContext<Executor::ModelBinding>> {
        let mut state = self.lock_state();
        let record = state.operations.get_mut(id)?;
        if record.state != OperationState::Running || record.cancellation.is_cancelled() {
            return None;
        }
        let binding = record
            .accepted_requests
            .get_mut(item_index)
            .and_then(|accepted| accepted.binding.take())
            .expect("running Batch Item must own its accepted Model binding");
        let request = record.accepted_requests[item_index].request.clone();
        record.active += 1;
        record.change += 1;
        Some((
            record.invocation_cwd.clone(),
            request,
            Duration::from_secs(record.timeout_seconds),
            Arc::clone(&record.completion),
            record.replace,
            binding,
        ))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the Batch completion boundary keeps its Operation and output inputs explicit"
    )]
    fn commit_batch_item(
        &self,
        id: &str,
        item_index: usize,
        model: String,
        cancellation: &ModelCancellation,
        completion: &Mutex<()>,
        staged: Executor::Staged,
        artifacts: Vec<ArtifactPointer>,
    ) {
        let _completion = lock(completion, "Model Operation completion");
        let result = if cancellation.is_cancelled() {
            Err(ModelRequestExecutionError::cancelled())
        } else {
            self.executor.commit(staged).map(|warnings| {
                if warnings != ModelOperationCommitWarnings::default() {
                    let mut state = self.lock_state();
                    if let Some(record) = state.operations.get_mut(id) {
                        record_commit_warnings(record, warnings);
                    }
                }
                artifacts
            })
        };
        self.finish_item(id, item_index, model, result);
    }

    fn finish_item(
        &self,
        id: &str,
        item_index: usize,
        model: String,
        result: Result<Vec<ArtifactPointer>, ModelRequestExecutionError>,
    ) {
        let observation = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            record.active = record
                .active
                .checked_sub(1)
                .expect("settled Batch Item was not active");
            let outcome = match result {
                Ok(artifacts) => {
                    record.succeeded += 1;
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
                    record.failed += 1;
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
            record.change += 1;
            let snapshot = record.snapshot();
            self.prepare_observed(snapshot)
        };
        self.publish_observed(observation);
        self.changed.notify_all();
    }

    fn finish_succeeded_batch(&self, id: &str) {
        let observation = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state == OperationState::Running {
                record.state = OperationState::Succeeded;
                record.release_model_bindings();
                record.change += 1;
                let snapshot = record.snapshot();
                Some(self.prepare_observed(snapshot))
            } else {
                None
            }
        };
        if let Some(observation) = observation {
            self.publish_observed(observation);
            self.retain_terminal(id);
            self.changed.notify_all();
        }
    }

    fn finish_cancelled(&self, id: &str) {
        let observation = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state.is_terminal() {
                None
            } else {
                record.state = OperationState::Cancelled;
                record.active = 0;
                record.release_model_bindings();
                record.change += 1;
                let snapshot = record.snapshot();
                Some(self.prepare_observed(snapshot))
            }
        };
        if let Some(observation) = observation {
            self.publish_observed(observation);
            self.retain_terminal(id);
            self.changed.notify_all();
        }
    }

    fn finish_failed(&self, id: &str, log: &str) {
        let observation = {
            let mut state = self.lock_state();
            let Some(record) = state.operations.get_mut(id) else {
                return;
            };
            if record.state.is_terminal() {
                None
            } else {
                record.state = OperationState::Failed;
                record.active = 0;
                record.log = Some(log.to_owned());
                record.release_model_bindings();
                record.change += 1;
                let snapshot = record.snapshot();
                Some(self.prepare_observed(snapshot))
            }
        };
        if let Some(observation) = observation {
            self.publish_observed(observation);
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

    fn lock_state(&self) -> MutexGuard<'_, RegistryState<Executor::ModelBinding>> {
        lock(&self.state, "Model Operation registry")
    }

    fn prepare_observed(
        &self,
        snapshot: ModelOperationSnapshot,
    ) -> PendingModelOperationObservation {
        let revision = self
            .observer_revision
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .expect("Model Operation observer revision exhausted");
        let observer = lock(&self.observer, "Model Operation observer").clone();
        PendingModelOperationObservation {
            revision,
            observer,
            snapshot,
        }
    }

    fn publish_observed(&self, observation: PendingModelOperationObservation) {
        let should_drain = {
            let mut dispatch = lock(&self.observer_dispatch, "Model Operation observer dispatch");
            assert!(
                dispatch
                    .pending
                    .insert(observation.revision, observation)
                    .is_none(),
                "Model Operation observer revision was queued twice"
            );
            if dispatch.draining {
                false
            } else {
                dispatch.draining = true;
                true
            }
        };
        if !should_drain {
            return;
        }
        loop {
            let observation = {
                let mut dispatch =
                    lock(&self.observer_dispatch, "Model Operation observer dispatch");
                let revision = dispatch.next_revision;
                let Some(observation) = dispatch.pending.remove(&revision) else {
                    dispatch.draining = false;
                    return;
                };
                dispatch.next_revision = revision
                    .checked_add(1)
                    .expect("Model Operation published observer revision exhausted");
                observation
            };
            if let Some(observer) = observation.observer {
                observer(observation.snapshot);
            }
        }
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

fn record_provenance_failures<ModelBinding>(
    record: &mut OperationRecord<ModelBinding>,
    failures: usize,
) {
    if failures == 0 {
        return;
    }
    record.provenance_failures = record
        .provenance_failures
        .checked_add(failures)
        .expect("Model Artifact provenance failure count exhausted");
    let message = format!(
        "Outputs were published, but Model Artifact provenance could not be saved for {} artifact(s).",
        record.provenance_failures
    );
    if let Some(diagnostic) = record
        .diagnostics
        .iter_mut()
        .find(|diagnostic| diagnostic.code == "model_artifact_provenance_persistence_failed")
    {
        diagnostic.message = message;
    } else if record.diagnostics.len() < MAX_OPERATION_DIAGNOSTICS {
        record.diagnostics.push(ModelOperationDiagnostic {
            code: "model_artifact_provenance_persistence_failed".to_owned(),
            message,
            item_index: None,
        });
    }
}

fn record_artifact_cleanup_failures<ModelBinding>(
    record: &mut OperationRecord<ModelBinding>,
    failures: usize,
) {
    if failures == 0 {
        return;
    }
    record.artifact_cleanup_failures = record
        .artifact_cleanup_failures
        .checked_add(failures)
        .expect("Model Artifact cleanup failure count exhausted");
    let message = format!(
        "Outputs were published, but Runtime could not remove {} temporary artifact file(s).",
        record.artifact_cleanup_failures
    );
    if let Some(diagnostic) = record
        .diagnostics
        .iter_mut()
        .find(|diagnostic| diagnostic.code == "model_artifact_cleanup_failed")
    {
        diagnostic.message = message;
    } else if record.diagnostics.len() < MAX_OPERATION_DIAGNOSTICS {
        record.diagnostics.push(ModelOperationDiagnostic {
            code: "model_artifact_cleanup_failed".to_owned(),
            message,
            item_index: None,
        });
    }
}

fn record_commit_warnings<ModelBinding>(
    record: &mut OperationRecord<ModelBinding>,
    warnings: ModelOperationCommitWarnings,
) {
    record_provenance_failures(record, warnings.provenance_failures);
    record_artifact_cleanup_failures(record, warnings.artifact_cleanup_failures);
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

fn validate_invocation_cwd(cwd: &Path) -> Result<PathBuf, ModelOperationError> {
    let cwd = cwd
        .canonicalize()
        .map_err(|error| ModelOperationError::new("invalid_input", error.to_string()))?;
    if !cwd.is_dir() {
        return Err(ModelOperationError::new(
            "invalid_input",
            "CLI working directory must be a directory.",
        ));
    }
    if cwd.to_str().is_none() {
        return Err(ModelOperationError::new(
            "invalid_input",
            "CLI working directory must be a UTF-8 path.",
        ));
    }
    Ok(cwd)
}

fn validate_output_directory(
    value: &str,
    invocation_cwd: &Path,
) -> Result<PathBuf, ModelOperationError> {
    if value.is_empty() || value.contains('\0') {
        return Err(ModelOperationError::new(
            "output_directory_invalid",
            "Model Request output.directory must be a non-empty filesystem path.",
        ));
    }
    let supplied = Path::new(value);
    let absolute = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        invocation_cwd.join(supplied)
    };
    let absolute = normalize_absolute_path(&absolute)?;
    let mut existing = absolute.clone();
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = existing.file_name().ok_or_else(|| {
                    ModelOperationError::new(
                        "output_directory_invalid",
                        "Model Request output.directory has no existing ancestor.",
                    )
                })?;
                missing.push(name.to_owned());
                existing.pop();
            }
            Err(error) => {
                return Err(ModelOperationError::new(
                    "output_directory_invalid",
                    error.to_string(),
                ));
            }
        }
    }
    let mut canonical = existing
        .canonicalize()
        .map_err(|error| ModelOperationError::new("output_directory_invalid", error.to_string()))?;
    if !canonical.is_dir() {
        return Err(ModelOperationError::new(
            "output_directory_invalid",
            "Model Request output.directory has a non-directory existing ancestor.",
        ));
    }
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    if canonical.to_str().is_none() {
        return Err(ModelOperationError::new(
            "output_directory_invalid",
            "Model Request output.directory must be a UTF-8 path.",
        ));
    }
    Ok(canonical)
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, ModelOperationError> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(ModelOperationError::new(
                        "output_directory_invalid",
                        "Model Request output.directory escapes the filesystem root.",
                    ));
                }
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    Ok(normalized)
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
    if request.output.name.is_empty()
        || matches!(request.output.name.as_str(), "." | "..")
        || request.output.name.contains(['/', '\\', '\0'])
    {
        return Err(ModelOperationError::new(
            "invalid_input",
            "Model Request output.name must be an ordinary basename without path separators.",
        ));
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
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use serde_json::{Map, json};
    use uuid::Uuid;

    use super::*;

    struct FixtureExecutor {
        outcomes: Mutex<VecDeque<Result<Vec<ArtifactPointer>, ModelRequestExecutionError>>>,
        provenance_failures_per_commit: usize,
        artifact_cleanup_failures_per_commit: usize,
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

    struct BindingProbeExecutor {
        snapshot_reads: AtomicUsize,
        bind_attempts: AtomicUsize,
        live_bindings: Arc<AtomicUsize>,
        runs: Mutex<Vec<(String, usize)>>,
        rejected_model: Option<String>,
    }

    struct TrackedModelBinding {
        revision: usize,
        live_bindings: Arc<AtomicUsize>,
    }

    impl Drop for TrackedModelBinding {
        fn drop(&mut self) {
            self.live_bindings.fetch_sub(1, Ordering::AcqRel);
        }
    }

    impl BindingProbeExecutor {
        fn new(rejected_model: Option<&str>) -> Self {
            Self {
                snapshot_reads: AtomicUsize::new(0),
                bind_attempts: AtomicUsize::new(0),
                live_bindings: Arc::new(AtomicUsize::new(0)),
                runs: Mutex::new(Vec::new()),
                rejected_model: rejected_model.map(str::to_owned),
            }
        }
    }

    impl ModelOperationExecutor for BindingProbeExecutor {
        type ConfigSnapshot = usize;
        type ModelBinding = TrackedModelBinding;
        type Prepared = ();
        type Staged = ();

        fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError> {
            self.snapshot_reads.fetch_add(1, Ordering::AcqRel);
            Ok(42)
        }

        fn bind_model(
            &self,
            snapshot: &Self::ConfigSnapshot,
            model_id: &str,
        ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError> {
            self.bind_attempts.fetch_add(1, Ordering::AcqRel);
            if self.rejected_model.as_deref() == Some(model_id) {
                return Err(ModelRequestExecutionError::validation(
                    "model_unavailable",
                    format!("Model is unavailable: {model_id}"),
                ));
            }
            self.live_bindings.fetch_add(1, Ordering::AcqRel);
            Ok((
                ModelKind::Image,
                TrackedModelBinding {
                    revision: *snapshot,
                    live_bindings: Arc::clone(&self.live_bindings),
                },
            ))
        }

        fn validate_request(
            &self,
            _binding: &Self::ModelBinding,
            _request: &mut ModelRequest,
        ) -> Result<(), ModelRequestExecutionError> {
            Ok(())
        }

        fn run(
            &self,
            binding: &Self::ModelBinding,
            _invocation_cwd: &Path,
            request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
            cancellation.check()?;
            self.runs
                .lock()
                .expect("probe runs")
                .push((request.model.clone(), binding.revision));
            Ok(())
        }

        fn stage(
            &self,
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            _prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            Ok(((), Vec::new()))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            Ok(ModelOperationCommitWarnings::default())
        }
    }

    macro_rules! unit_image_binding {
        () => {
            type ConfigSnapshot = ();
            type ModelBinding = ();

            fn read_config_snapshot(
                &self,
            ) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError> {
                Ok(())
            }

            fn bind_model(
                &self,
                _snapshot: &Self::ConfigSnapshot,
                _model_id: &str,
            ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError> {
                Ok((ModelKind::Image, ()))
            }

            fn validate_request(
                &self,
                _binding: &Self::ModelBinding,
                _request: &mut ModelRequest,
            ) -> Result<(), ModelRequestExecutionError> {
                Ok(())
            }
        };
    }

    impl ModelOperationExecutor for CancellableExecutor {
        unit_image_binding!();
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn run(
            &self,
            _binding: &Self::ModelBinding,
            _invocation_cwd: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
            self.started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                thread::yield_now();
            }
            Err(ModelRequestExecutionError::cancelled())
        }

        fn stage(
            &self,
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            Ok(ModelOperationCommitWarnings::default())
        }
    }

    impl ModelOperationExecutor for BlockingCommitExecutor {
        unit_image_binding!();
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn run(
            &self,
            _binding: &Self::ModelBinding,
            _invocation_cwd: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
            cancellation.check()?;
            Ok(Vec::new())
        }

        fn stage(
            &self,
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            self.commit_started.store(true, Ordering::Release);
            while !self.release.load(Ordering::Acquire) {
                thread::yield_now();
            }
            Ok(ModelOperationCommitWarnings::default())
        }
    }

    impl ModelOperationExecutor for CleanupFailureExecutor {
        unit_image_binding!();
        type Prepared = Vec<ArtifactPointer>;
        type Staged = Vec<ArtifactPointer>;

        fn run(
            &self,
            _binding: &Self::ModelBinding,
            _invocation_cwd: &Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
            self.started.store(true, Ordering::Release);
            while !cancellation.is_cancelled() {
                thread::yield_now();
            }
            Err(ModelRequestExecutionError::failed("cleanup failed"))
        }

        fn stage(
            &self,
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            Ok((prepared.clone(), prepared))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            Ok(ModelOperationCommitWarnings::default())
        }
    }

    impl ModelOperationExecutor for MaterializingExecutor {
        type ConfigSnapshot = ();
        type ModelBinding = ();
        type Prepared = ();
        type Staged = ();

        fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError> {
            Ok(())
        }

        fn bind_model(
            &self,
            _snapshot: &Self::ConfigSnapshot,
            _model_id: &str,
        ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError> {
            Ok((ModelKind::Image, ()))
        }

        fn validate_request(
            &self,
            _binding: &Self::ModelBinding,
            request: &mut ModelRequest,
        ) -> Result<(), ModelRequestExecutionError> {
            request
                .arguments
                .entry("delivery".to_owned())
                .or_insert_with(|| json!("inline"));
            Ok(())
        }

        fn run(
            &self,
            _binding: &Self::ModelBinding,
            _invocation_cwd: &Path,
            request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
            cancellation.check()?;
            *self.executed_request.lock().expect("executed request") = Some(request.clone());
            Ok(())
        }

        fn stage(
            &self,
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            _prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            Ok(((), Vec::new()))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            Ok(ModelOperationCommitWarnings::default())
        }
    }

    impl ModelOperationExecutor for FixtureExecutor {
        type ConfigSnapshot = ();
        type ModelBinding = ();
        type Prepared = Result<Vec<ArtifactPointer>, ModelRequestExecutionError>;
        type Staged = ();

        fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError> {
            Ok(())
        }

        fn bind_model(
            &self,
            _snapshot: &Self::ConfigSnapshot,
            model_id: &str,
        ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError> {
            let kind = if model_id.starts_with("video-") {
                ModelKind::Video
            } else {
                ModelKind::Image
            };
            Ok((kind, ()))
        }

        fn validate_request(
            &self,
            _binding: &Self::ModelBinding,
            _request: &mut ModelRequest,
        ) -> Result<(), ModelRequestExecutionError> {
            Ok(())
        }

        fn run(
            &self,
            _binding: &Self::ModelBinding,
            _invocation_cwd: &std::path::Path,
            _request: &ModelRequest,
            _timeout: Duration,
            cancellation: &ModelCancellation,
        ) -> Result<Self::Prepared, ModelRequestExecutionError> {
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
            _binding: &Self::ModelBinding,
            _operation_id: &str,
            _item_index: usize,
            _request: &ModelRequest,
            _replace: bool,
            prepared: Self::Prepared,
        ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
            prepared.map(|artifacts| ((), artifacts))
        }

        fn commit(
            &self,
            _staged: Self::Staged,
        ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
            Ok(ModelOperationCommitWarnings {
                provenance_failures: self.provenance_failures_per_commit,
                artifact_cleanup_failures: self.artifact_cleanup_failures_per_commit,
            })
        }
    }

    #[test]
    fn accepted_single_is_owned_by_runtime_until_terminal() {
        let fixture = Fixture::new(vec![Ok(vec![artifact("generated/cover.jpg")])]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
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
    fn accepted_operation_publishes_authoritative_snapshots_for_runtime_activity() {
        let fixture = Fixture::new(vec![Ok(vec![artifact("generated/cover.jpg")])]);
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&snapshots);
        assert!(fixture.service.install_observer(Arc::new(move |snapshot| {
            observed.lock().unwrap().push(snapshot);
        })));

        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .expect("submission should be accepted");
        fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap();

        let snapshots = snapshots.lock().unwrap();
        assert!(
            snapshots
                .iter()
                .any(|snapshot| snapshot.state == OperationState::Running)
        );
        let terminal = snapshots.last().expect("terminal observer snapshot");
        assert_eq!(terminal.id, accepted.id);
        assert_eq!(terminal.state, OperationState::Succeeded);
    }

    #[test]
    fn batch_aggregates_provenance_failures_into_one_operation_diagnostic() {
        let fixture = Fixture::with_provenance_failures(
            vec![
                Ok(vec![artifact("generated/first.jpg")]),
                Ok(vec![artifact("generated/second.jpg")]),
            ],
            1,
        );
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![request("image-model"), request("image-model")],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        let terminal = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();

        assert_eq!(terminal.diagnostics, vec![ModelOperationDiagnostic {
            code: "model_artifact_provenance_persistence_failed".to_owned(),
            message: "Outputs were published, but Model Artifact provenance could not be saved for 2 artifact(s).".to_owned(),
            item_index: None,
        }]);
    }

    #[test]
    fn successful_output_cleanup_failures_are_reported_as_one_warning() {
        let fixture =
            Fixture::with_commit_warnings(vec![Ok(vec![artifact("generated/first.jpg")])], 0, 2);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .unwrap();
        let terminal = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();

        assert_eq!(terminal.state, OperationState::Succeeded);
        assert_eq!(
            terminal.diagnostics,
            vec![ModelOperationDiagnostic {
                code: "model_artifact_cleanup_failed".to_owned(),
                message: "Outputs were published, but Runtime could not remove 2 temporary artifact file(s).".to_owned(),
                item_index: None,
            }]
        );
    }

    #[test]
    fn observer_dispatch_preserves_order_without_blocking_model_operation_state() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let states = Arc::new(Mutex::new(Vec::new()));
        let observed_states = Arc::clone(&states);
        let (running_entered_sender, running_entered_receiver) = mpsc::channel();
        let (release_running_sender, release_running_receiver) = mpsc::channel();
        let release_running_receiver = Mutex::new(release_running_receiver);
        assert!(fixture.service.install_observer(Arc::new(move |snapshot| {
            if snapshot.state == OperationState::Running {
                running_entered_sender.send(()).unwrap();
                release_running_receiver.lock().unwrap().recv().unwrap();
            }
            observed_states.lock().unwrap().push(snapshot.state);
        })));

        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Single,
                requests: vec![request("image-model")],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
            })
            .expect("submission should be accepted");
        running_entered_receiver.recv().unwrap();

        let cancel_service = Arc::clone(&fixture.service);
        let operation_id = accepted.id.clone();
        let (cancel_done_sender, cancel_done_receiver) = mpsc::channel();
        let cancel = thread::spawn(move || {
            let result = cancel_service.cancel(&operation_id);
            cancel_done_sender.send(()).unwrap();
            result
        });
        cancel_done_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("observer delivery must not block the Model Operation authority");
        let cancelling = cancel
            .join()
            .unwrap()
            .expect("cancellation must linearize while the observer is blocked");
        assert_eq!(cancelling.state, OperationState::Cancelling);
        release_running_sender.send(()).unwrap();
        let terminal = fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .expect("cancelled operation must remain observable");
        assert_eq!(terminal.state, OperationState::Cancelled);

        let states = states.lock().unwrap();
        assert_eq!(
            *states,
            vec![
                OperationState::Queued,
                OperationState::Running,
                OperationState::Cancelling,
                OperationState::Cancelled,
            ]
        );
    }

    #[test]
    #[should_panic(expected = "Model Operation sequence exhausted")]
    fn exhausted_operation_sequence_is_process_fatal() {
        let fixture = Fixture::new(Vec::new());
        fixture.service.lock_state().next_sequence = u64::MAX;

        let _ = fixture.service.submit(SubmitModelOperation {
            invocation_cwd: fixture.project.clone(),
            shape: ExecutionShape::Single,
            requests: vec![request("image-model")],
            concurrency: None,
            timeout_seconds: None,
            replace: false,
        });
    }

    #[test]
    #[should_panic(expected = "settled Batch Item was not active")]
    fn impossible_batch_active_underflow_is_process_fatal() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![request("image-model")],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: false,
            })
            .expect("Batch should be accepted");
        fixture
            .service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .expect("Batch should remain observable")
            .expect("test observer remains connected");
        {
            let mut state = fixture.service.lock_state();
            let record = state
                .operations
                .get_mut(&accepted.id)
                .expect("accepted Batch record");
            record.state = OperationState::Running;
            record.active = 0;
        }

        fixture
            .service
            .finish_item(&accepted.id, 0, "image-model".to_owned(), Ok(Vec::new()));
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
                invocation_cwd: fixture.project.clone(),
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
    fn submission_reads_one_snapshot_and_shares_each_unique_model_binding() {
        let fixture = Fixture::new(Vec::new());
        let executor = Arc::new(BindingProbeExecutor::new(None));
        let service = Arc::new(ModelOperationService::new(Arc::clone(&executor)));
        let accepted = service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![
                    request("image-one"),
                    request("image-one"),
                    request("image-two"),
                ],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: false,
            })
            .expect("binding probe Batch should be accepted");
        let terminal = service
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();

        assert_eq!(terminal.state, OperationState::Succeeded);
        assert_eq!(executor.snapshot_reads.load(Ordering::Acquire), 1);
        assert_eq!(executor.bind_attempts.load(Ordering::Acquire), 2);
        assert_eq!(
            *executor.runs.lock().expect("probe runs"),
            vec![
                ("image-one".to_owned(), 42),
                ("image-one".to_owned(), 42),
                ("image-two".to_owned(), 42),
            ]
        );
        assert_eq!(executor.live_bindings.load(Ordering::Acquire), 0);
        assert!(service.inspect(&accepted.id).is_ok());
        service.shutdown();
    }

    #[test]
    fn binding_failure_rejects_the_complete_submission_and_releases_prior_bindings() {
        let fixture = Fixture::new(Vec::new());
        let executor = Arc::new(BindingProbeExecutor::new(Some("image-missing")));
        let service = Arc::new(ModelOperationService::new(Arc::clone(&executor)));
        let error = service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![request("image-one"), request("image-missing")],
                concurrency: Some(1),
                timeout_seconds: None,
                replace: false,
            })
            .expect_err("one unavailable Model must reject the complete Batch");

        assert_eq!(error.code(), "model_unavailable");
        assert_eq!(executor.snapshot_reads.load(Ordering::Acquire), 1);
        assert_eq!(executor.bind_attempts.load(Ordering::Acquire), 2);
        assert_eq!(executor.live_bindings.load(Ordering::Acquire), 0);
        assert!(executor.runs.lock().expect("probe runs").is_empty());
        assert!(
            service
                .list(&ModelOperationListQuery::default())
                .unwrap()
                .operations
                .is_empty()
        );
        service.shutdown();
    }

    #[test]
    fn batch_item_failures_are_retained_in_settlement_order_but_batch_succeeds() {
        let fixture = Fixture::new(vec![
            Err(ModelRequestExecutionError::failed("first failed")),
            Ok(vec![artifact("generated/second.jpg")]),
        ]);
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
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
                invocation_cwd: fixture.project.clone(),
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
        fs::create_dir_all(&project).unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let service = Arc::new(ModelOperationService::new(Arc::new(
            CleanupFailureExecutor {
                started: Arc::clone(&started),
            },
        )));
        let accepted = service
            .submit(SubmitModelOperation {
                invocation_cwd: project,
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
        drop(service);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_or_running_cancellation_is_idempotent_and_terminal_success_rejects_cancel() {
        let fixture = Fixture::new(vec![Ok(Vec::new())]);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_states = Arc::clone(&observed);
        assert!(fixture.service.install_observer(Arc::new(move |snapshot| {
            observed_states.lock().unwrap().push(snapshot.state);
        })));
        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
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
        let observer_deadline = Instant::now() + Duration::from_secs(2);
        while observed
            .lock()
            .unwrap()
            .last()
            .is_none_or(|state| !state.is_terminal())
        {
            assert!(
                Instant::now() < observer_deadline,
                "terminal observer snapshot was not delivered"
            );
            thread::yield_now();
        }
        let observed_before_repeat = observed.lock().unwrap().len();
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
        assert_eq!(observed.lock().unwrap().len(), observed_before_repeat);
    }

    #[test]
    fn list_is_newest_first_cursor_scoped_and_terminal_retention_is_bounded() {
        let fixture = Fixture::new((0..105).map(|_| Ok(Vec::new())).collect());
        for index in 0..105 {
            let accepted = fixture
                .service
                .submit(SubmitModelOperation {
                    invocation_cwd: fixture.project.clone(),
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
        fixture.service.shutdown();
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
        const REQUEST: &str = r#"{"model":"image-model","arguments":{},"output":{"directory":".","name":"artifact"}}"#;
        let one = parse_model_requests(format!("{REQUEST}\n").as_bytes(), ExecutionShape::Single)
            .expect("one JSONL record");
        assert_eq!(one.len(), 1);
        for source in [
            b"\n".to_vec(),
            b"# comment\n".to_vec(),
            format!("\u{feff}{REQUEST}\n").into_bytes(),
            format!("{REQUEST}\n\n").into_bytes(),
        ] {
            assert!(parse_model_requests(&source, ExecutionShape::Batch).is_err());
        }
        let two = format!("{REQUEST}\n{REQUEST}\n");
        assert!(parse_model_requests(two.as_bytes(), ExecutionShape::Single).is_err());
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
    fn runtime_shutdown_cancels_and_joins_owned_operation_workers() {
        let fixture = Fixture::new(Vec::new());
        let started = Arc::new(AtomicBool::new(false));
        let service = Arc::new(ModelOperationService::new(Arc::new(CancellableExecutor {
            started: Arc::clone(&started),
        })));
        let accepted = service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
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
                invocation_cwd: fixture.project.clone(),
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
    fn batch_accepts_duplicate_output_names_for_items_to_commit_independently() {
        let fixture = Fixture::new(vec![Ok(Vec::new()), Ok(Vec::new())]);
        let mut first = request("image-one");
        first.output.name = "cover".to_owned();
        let mut second = request("image-two");
        second.output = first.output.clone();

        let accepted = fixture
            .service
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project.clone(),
                shape: ExecutionShape::Batch,
                requests: vec![first, second],
                concurrency: None,
                timeout_seconds: None,
                replace: false,
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
        assert_eq!((succeeded, failed), (2, 0));
    }

    fn request(model: &str) -> ModelRequest {
        ModelRequest {
            model: model.to_owned(),
            arguments: Map::new(),
            output: ModelOutput {
                directory: ".".to_owned(),
                name: "artifact".to_owned(),
            },
        }
    }

    fn artifact(path: &str) -> ArtifactPointer {
        ArtifactPointer {
            artifact_index: 0,
            output_path: path.to_owned(),
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
        fn new(outcomes: Vec<Result<Vec<ArtifactPointer>, ModelRequestExecutionError>>) -> Self {
            Self::with_provenance_failures(outcomes, 0)
        }

        fn with_provenance_failures(
            outcomes: Vec<Result<Vec<ArtifactPointer>, ModelRequestExecutionError>>,
            provenance_failures_per_commit: usize,
        ) -> Self {
            Self::with_commit_warnings(outcomes, provenance_failures_per_commit, 0)
        }

        fn with_commit_warnings(
            outcomes: Vec<Result<Vec<ArtifactPointer>, ModelRequestExecutionError>>,
            provenance_failures_per_commit: usize,
            artifact_cleanup_failures_per_commit: usize,
        ) -> Self {
            let root = std::env::temp_dir().join(format!("debrute-operation-{}", Uuid::new_v4()));
            let project = root.join("project");
            fs::create_dir_all(&project).expect("output directory");
            let service = Arc::new(ModelOperationService::new(Arc::new(FixtureExecutor {
                outcomes: Mutex::new(VecDeque::from(outcomes)),
                provenance_failures_per_commit,
                artifact_cleanup_failures_per_commit,
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
