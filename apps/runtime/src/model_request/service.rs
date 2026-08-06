use std::{path::Path, sync::Arc, time::Duration};

use crate::{
    global::{AudioModelKind, GlobalConfigSnapshot, GlobalConfigStore, ModelCatalog},
    model_operation::{
        ArtifactPointer, ModelCancellation, ModelKind, ModelOperationCommitWarnings,
        ModelOperationExecutor, ModelRequest, ModelRequestExecutionError,
    },
};

use super::{
    audio,
    common::{
        ExecutionContext, StagedModelExecution, commit_staged_execution,
        materialize_argument_defaults, stage_execution,
    },
    http::NativeModelHttpTransport,
    image,
    provenance::ModelArtifactProvenanceStore,
    types::{
        ModelExecution, ModelHttpTransport, ModelRequestCancellation, ModelRequestDeadline,
        ModelRequestError, ResolvedModelRequestModel,
    },
    video,
};

/// Runtime-owned Model Adapter execution and output commit authority.
pub struct ModelRequestExecutor {
    catalog: Arc<ModelCatalog>,
    global_config: Arc<GlobalConfigStore>,
    provenance: Arc<ModelArtifactProvenanceStore>,
    transport: Arc<dyn ModelHttpTransport>,
}

pub struct PreparedModelExecution {
    execution: ModelExecution,
}

pub struct AcceptedModelBinding {
    model: ResolvedModelRequestModel,
    schema: serde_json::Value,
}

impl ModelRequestExecutor {
    #[must_use]
    pub fn new(
        catalog: Arc<ModelCatalog>,
        global_config: Arc<GlobalConfigStore>,
        provenance: Arc<ModelArtifactProvenanceStore>,
    ) -> Self {
        Self {
            catalog,
            global_config,
            provenance,
            transport: Arc::new(NativeModelHttpTransport),
        }
    }
}

impl ModelOperationExecutor for ModelRequestExecutor {
    type ConfigSnapshot = GlobalConfigSnapshot;
    type ModelBinding = AcceptedModelBinding;
    type Prepared = PreparedModelExecution;
    type Staged = StagedModelExecution;

    fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRequestExecutionError> {
        self.global_config
            .read_snapshot(&self.catalog)
            .map_err(|error| {
                ModelRequestExecutionError::validation(
                    "internal_error",
                    format!("Global settings are unavailable: {error}"),
                )
            })
    }

    fn bind_model(
        &self,
        snapshot: &Self::ConfigSnapshot,
        model_id: &str,
    ) -> Result<(ModelKind, Self::ModelBinding), ModelRequestExecutionError> {
        let (model, schema) =
            resolve_model(&self.catalog, snapshot, model_id).map_err(|error| {
                ModelRequestExecutionError::validation("model_unavailable", error.message())
            })?;
        Ok((model.kind, AcceptedModelBinding { model, schema }))
    }

    fn validate_request(
        &self,
        binding: &Self::ModelBinding,
        request: &mut ModelRequest,
    ) -> Result<(), ModelRequestExecutionError> {
        materialize_argument_defaults(
            &binding.model.model_id,
            &binding.schema,
            &mut request.arguments,
        )
        .map_err(|error| {
            ModelRequestExecutionError::validation("invalid_input", error.message())
        })?;
        Ok(())
    }

    fn run(
        &self,
        binding: &Self::ModelBinding,
        invocation_cwd: &Path,
        request: &ModelRequest,
        timeout: Duration,
        cancellation: &ModelCancellation,
    ) -> Result<Self::Prepared, ModelRequestExecutionError> {
        let cancellation = ModelRequestCancellation::from_model(cancellation);
        cancellation
            .check()
            .map_err(|error| model_request_execution_error(&error))?;
        let deadline = ModelRequestDeadline::after(timeout)
            .map_err(|error| model_request_execution_error(&error))?;
        let context = ExecutionContext::new(
            &binding.model,
            &request.arguments,
            invocation_cwd,
            &cancellation,
            self.transport.as_ref(),
            deadline,
        )
        .map_err(|error| model_request_execution_error(&error))?;
        let execution = execute_model(binding.model.kind, context)
            .map_err(|error| {
                redact_model_request_error(&error, std::slice::from_ref(&binding.model.api_key))
            })
            .map_err(|error| model_request_execution_error(&error))?;
        cancellation
            .check()
            .map_err(|error| model_request_execution_error(&error))?;
        Ok(PreparedModelExecution { execution })
    }

    fn stage(
        &self,
        binding: &Self::ModelBinding,
        operation_id: &str,
        item_index: usize,
        request: &ModelRequest,
        replace: bool,
        prepared: Self::Prepared,
    ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRequestExecutionError> {
        stage_execution(
            operation_id,
            item_index,
            request,
            replace,
            prepared.execution,
            std::slice::from_ref(&binding.model.api_key),
        )
        .map_err(|error| model_request_execution_error(&error))
    }

    fn commit(
        &self,
        staged: Self::Staged,
    ) -> Result<ModelOperationCommitWarnings, ModelRequestExecutionError> {
        commit_staged_execution(staged, &self.provenance)
            .map_err(|error| model_request_execution_error(&error))
    }
}

fn model_request_execution_error(error: &ModelRequestError) -> ModelRequestExecutionError {
    if error.code() == "model_request_cancelled" {
        ModelRequestExecutionError::cancelled()
    } else {
        ModelRequestExecutionError::validation(error.code(), error.message())
    }
}

fn redact_model_request_error(error: &ModelRequestError, secrets: &[String]) -> ModelRequestError {
    let value = super::redaction::redact_model_request_value(
        &serde_json::Value::String(error.message().to_owned()),
        secrets.iter().cloned(),
    );
    ModelRequestError::new(
        error.code(),
        value.as_str().unwrap_or("Model request failed."),
    )
}

fn execute_model(
    kind: ModelKind,
    context: ExecutionContext<'_>,
) -> Result<ModelExecution, ModelRequestError> {
    match kind {
        ModelKind::Image => image::execute(context),
        ModelKind::Video => video::execute(context),
        ModelKind::Tts | ModelKind::Music | ModelKind::SoundEffect => audio::execute(context),
    }
}

fn resolve_model(
    catalog: &ModelCatalog,
    snapshot: &GlobalConfigSnapshot,
    model_id: &str,
) -> Result<(ResolvedModelRequestModel, serde_json::Value), ModelRequestError> {
    let (kind, base_url, request_model_id, schema) = if let Some(entry) = catalog
        .images()
        .iter()
        .find(|entry| entry.debrute_model_id == model_id)
    {
        (
            ModelKind::Image,
            entry.default_base_url.clone(),
            entry.default_request_model_id.clone(),
            entry.arguments_schema.clone(),
        )
    } else if let Some(entry) = catalog
        .videos()
        .iter()
        .find(|entry| entry.debrute_model_id == model_id)
    {
        (
            ModelKind::Video,
            entry.default_base_url.clone(),
            entry.default_request_model_id.clone(),
            entry.arguments_schema.clone(),
        )
    } else if let Some(entry) = catalog
        .audio()
        .iter()
        .find(|entry| entry.debrute_model_id == model_id)
    {
        let kind = match entry.kind {
            AudioModelKind::Tts => ModelKind::Tts,
            AudioModelKind::Music => ModelKind::Music,
            AudioModelKind::SoundEffect => ModelKind::SoundEffect,
        };
        (
            kind,
            entry.default_base_url.clone(),
            entry.default_request_model_id.clone(),
            entry.arguments_schema.clone(),
        )
    } else {
        return Err(ModelRequestError::new(
            "model_unavailable",
            format!("Model is unavailable: {model_id}"),
        ));
    };
    let configuration = snapshot
        .settings
        .models
        .iter()
        .find(|configuration| configuration.debrute_model_id == model_id);
    let base_url = configuration
        .and_then(|configuration| configuration.base_url_override.clone())
        .unwrap_or(base_url);
    let request_model_id = configuration
        .and_then(|configuration| configuration.request_model_id_override.clone())
        .unwrap_or(request_model_id);
    validate_model_endpoint(&base_url)?;
    if request_model_id.trim().is_empty() {
        return Err(ModelRequestError::new(
            "model_configuration_invalid",
            format!("Model request id is empty: {model_id}"),
        ));
    }
    let api_key = snapshot
        .secrets
        .model_api_keys
        .get(model_id)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_not_configured",
                format!("Model API key is missing: {model_id}"),
            )
        })?
        .clone();
    Ok((
        ResolvedModelRequestModel {
            kind,
            model_id: model_id.to_owned(),
            request_model_id,
            base_url,
            api_key,
        },
        schema,
    ))
}

fn validate_model_endpoint(value: &str) -> Result<(), ModelRequestError> {
    let url = url::Url::parse(value).map_err(|error| {
        ModelRequestError::new("model_configuration_invalid", error.to_string())
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ModelRequestError::new(
            "model_configuration_invalid",
            "Model base URL must be credential-free absolute HTTP(S).",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        path::{Path, PathBuf},
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::model_request::ModelArtifactProvenanceStore;
    use crate::{
        model_operation::{
            ExecutionShape, ModelOperationService, ModelOutput, OperationState,
            SubmitModelOperation,
        },
        model_request::{
            common::ModelRequestResourceLimits,
            types::{
                HttpMethod, ModelHttpRequest, ModelHttpResponse, PreparedHttpBody as HttpBody,
            },
        },
    };

    struct FixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
    }

    struct CancellingFixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
        cancel_on_request: usize,
        cancel_after_response: bool,
    }

    struct BlockingFixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
        first_started: (Mutex<bool>, Condvar),
        release_first: (Mutex<bool>, Condvar),
    }

    enum RemoteCleanupFixtureOutcome {
        Response(ModelHttpResponse),
        NetworkFailure,
        AwaitDeadline,
    }

    struct RemoteCleanupFixtureTransport {
        requests: Mutex<Vec<ModelHttpRequest>>,
        outcome: RemoteCleanupFixtureOutcome,
        cleanup_elapsed: Mutex<Option<Duration>>,
    }

    struct BatchRemoteCancellationTransport {
        requests: Mutex<Vec<ModelHttpRequest>>,
        submitted: AtomicUsize,
        polls_started: (Mutex<usize>, Condvar),
    }

    struct AcceptedBindingFixture {
        root: PathBuf,
        catalog: Arc<ModelCatalog>,
        global_config: Arc<GlobalConfigStore>,
        transport: Arc<BlockingFixtureTransport>,
        operations: Arc<ModelOperationService<ModelRequestExecutor>>,
        request: ModelRequest,
    }

    impl AcceptedBindingFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "debrute-accepted-model-binding-{}",
                uuid::Uuid::new_v4()
            ));
            let project = root.join("project");
            std::fs::create_dir_all(&project).unwrap();
            let catalog = Arc::new(ModelCatalog::bundled().unwrap());
            let global_config = Arc::new(GlobalConfigStore::new(root.join("home")));
            let transport = Arc::new(BlockingFixtureTransport {
                responses: Mutex::new(VecDeque::from([
                    fixture_json(&json!({
                        "data": [{"b64_json": "iVBORw0KGgo="}]
                    })),
                    fixture_json(&json!({
                        "data": [{"b64_json": "iVBORw0KGgo="}]
                    })),
                    fixture_json(&json!({
                        "data": [{"b64_json": "iVBORw0KGgo="}]
                    })),
                ])),
                requests: Mutex::new(Vec::new()),
                first_started: (Mutex::new(false), Condvar::new()),
                release_first: (Mutex::new(false), Condvar::new()),
            });
            let executor = Arc::new(ModelRequestExecutor {
                catalog: Arc::clone(&catalog),
                global_config: Arc::clone(&global_config),
                provenance: Arc::new(ModelArtifactProvenanceStore::new(&root.join("home"))),
                transport: transport.clone(),
            });
            let fixture = Self {
                root: root.clone(),
                catalog,
                global_config,
                transport,
                operations: Arc::new(ModelOperationService::new(executor)),
                request: ModelRequest {
                    model: "gpt-image-2".to_owned(),
                    arguments: Map::from_iter([("prompt".to_owned(), json!("poster"))]),
                    output: ModelOutput {
                        directory: root.join("project").to_string_lossy().into_owned(),
                        name: "artifact".to_owned(),
                    },
                },
            };
            fixture.set_model(
                "accepted.example.test",
                "accepted-request-model",
                "accepted-secret",
            );
            fixture
        }

        fn project(&self) -> PathBuf {
            self.root.join("project")
        }

        fn set_model(&self, host: &str, request_model_id: &str, api_key: &str) {
            self.global_config
                .patch(
                    &json!({
                        "modelSetting": {
                            "modelId": "gpt-image-2",
                            "setting": {
                                "baseUrlOverride": format!("https://{host}/v1"),
                                "requestModelIdOverride": request_model_id,
                                "apiKey": api_key
                            }
                        }
                    }),
                    &self.catalog,
                )
                .unwrap();
        }

        fn assert_request_binding(
            &self,
            index: usize,
            host: &str,
            request_model_id: &str,
            api_key: &str,
        ) {
            let requests = self.transport.requests.lock().expect("fixture requests");
            let request = &requests[index];
            assert_eq!(request.url, format!("https://{host}/v1/images/generations"));
            assert_eq!(
                request.headers.get("authorization").map(String::as_str),
                Some(api_key)
            );
            let HttpBody::Json(body) = &request.body else {
                panic!("expected JSON model request");
            };
            assert_eq!(body.get("model"), Some(&json!(request_model_id)));
        }

        fn request_count(&self) -> usize {
            self.transport
                .requests
                .lock()
                .expect("fixture requests")
                .len()
        }
    }

    impl Drop for AcceptedBindingFixture {
        fn drop(&mut self) {
            self.operations.shutdown();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    impl BlockingFixtureTransport {
        fn wait_for_first_request(&self) {
            let (started, changed) = &self.first_started;
            let started = started.lock().expect("first request state");
            let (started, _) = changed
                .wait_timeout_while(started, Duration::from_secs(2), |started| !*started)
                .expect("first request wait");
            assert!(*started, "first model request did not start");
        }

        fn release_first_request(&self) {
            let (released, changed) = &self.release_first;
            *released.lock().expect("first request release") = true;
            changed.notify_all();
        }
    }

    impl ModelHttpTransport for FixtureTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &ModelRequestCancellation,
            deadline: ModelRequestDeadline,
        ) -> Result<ModelHttpResponse, ModelRequestError> {
            deadline.remaining(cancellation)?;
            self.requests.lock().unwrap().push(request);
            self.responses.lock().unwrap().pop_front().ok_or_else(|| {
                ModelRequestError::new(
                    "fixture_exhausted",
                    "Model request fixture response queue is empty.",
                )
            })
        }
    }

    impl ModelHttpTransport for CancellingFixtureTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &ModelRequestCancellation,
            deadline: ModelRequestDeadline,
        ) -> Result<ModelHttpResponse, ModelRequestError> {
            deadline.remaining(cancellation)?;
            let request_number = {
                let mut requests = self.requests.lock().expect("fixture requests");
                requests.push(request);
                requests.len()
            };
            if request_number == self.cancel_on_request && !self.cancel_after_response {
                cancellation.cancel();
                return Err(deadline.remaining(cancellation).unwrap_err());
            }
            let response = self
                .responses
                .lock()
                .expect("fixture responses")
                .pop_front()
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "fixture_exhausted",
                        "Model request fixture response queue is empty.",
                    )
                })?;
            if request_number == self.cancel_on_request {
                cancellation.cancel();
            }
            Ok(response)
        }
    }

    impl ModelHttpTransport for BlockingFixtureTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &ModelRequestCancellation,
            deadline: ModelRequestDeadline,
        ) -> Result<ModelHttpResponse, ModelRequestError> {
            deadline.remaining(cancellation)?;
            let first = {
                let mut requests = self.requests.lock().expect("fixture requests");
                let first = requests.is_empty();
                requests.push(request);
                first
            };
            if first {
                let (started, changed) = &self.first_started;
                *started.lock().expect("first request state") = true;
                changed.notify_all();

                let (released, changed) = &self.release_first;
                let released = released.lock().expect("first request release");
                let _released = changed
                    .wait_while(released, |released| !*released)
                    .expect("first request release wait");
            }
            self.responses
                .lock()
                .expect("fixture responses")
                .pop_front()
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "fixture_exhausted",
                        "Model request fixture response queue is empty.",
                    )
                })
        }
    }

    impl ModelHttpTransport for RemoteCleanupFixtureTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &ModelRequestCancellation,
            deadline: ModelRequestDeadline,
        ) -> Result<ModelHttpResponse, ModelRequestError> {
            deadline.remaining(cancellation)?;
            let request_number = {
                let mut requests = self.requests.lock().expect("fixture requests");
                requests.push(request);
                requests.len()
            };
            match request_number {
                1 => Ok(fixture_json(&json!({"task_id": "cleanup-outcome-task"}))),
                2 => {
                    cancellation.cancel();
                    Err(deadline.remaining(cancellation).unwrap_err())
                }
                3 => {
                    let started = Instant::now();
                    let result = match &self.outcome {
                        RemoteCleanupFixtureOutcome::Response(response) => Ok(response.clone()),
                        RemoteCleanupFixtureOutcome::NetworkFailure => Err(ModelRequestError::new(
                            "fixture_network_failed",
                            "Fixture network failure.",
                        )),
                        RemoteCleanupFixtureOutcome::AwaitDeadline => loop {
                            match deadline.remaining(cancellation) {
                                Ok(remaining) => {
                                    std::thread::sleep(remaining.min(Duration::from_millis(25)));
                                }
                                Err(error) => break Err(error),
                            }
                        },
                    };
                    *self.cleanup_elapsed.lock().expect("cleanup elapsed") =
                        Some(started.elapsed());
                    result
                }
                _ => Err(ModelRequestError::new(
                    "fixture_unexpected_request",
                    "Remote cleanup fixture received an unexpected request.",
                )),
            }
        }
    }

    impl BatchRemoteCancellationTransport {
        fn wait_for_polls(&self, expected: usize) {
            let (polls_started, changed) = &self.polls_started;
            let polls_started = polls_started.lock().expect("poll start count");
            let (polls_started, _) = changed
                .wait_timeout_while(polls_started, Duration::from_secs(2), |count| {
                    *count < expected
                })
                .expect("poll start wait");
            assert_eq!(*polls_started, expected, "active polls did not start");
        }
    }

    impl ModelHttpTransport for BatchRemoteCancellationTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &ModelRequestCancellation,
            deadline: ModelRequestDeadline,
        ) -> Result<ModelHttpResponse, ModelRequestError> {
            deadline.remaining(cancellation)?;
            let method = request.method;
            self.requests
                .lock()
                .expect("fixture requests")
                .push(request);
            match method {
                HttpMethod::Post => {
                    let task = self.submitted.fetch_add(1, Ordering::AcqRel);
                    Ok(fixture_json(
                        &json!({"task_id": format!("batch-task-{task}")}),
                    ))
                }
                HttpMethod::Get => {
                    let (polls_started, changed) = &self.polls_started;
                    *polls_started.lock().expect("poll start count") += 1;
                    changed.notify_all();
                    loop {
                        let remaining = deadline.remaining(cancellation)?;
                        std::thread::sleep(remaining.min(Duration::from_millis(10)));
                    }
                }
                HttpMethod::Delete => Ok(ModelHttpResponse {
                    status: 204,
                    headers: std::collections::BTreeMap::new(),
                    body: Vec::new(),
                }),
                HttpMethod::Put => Err(ModelRequestError::new(
                    "fixture_unexpected_request",
                    "H3 Batch cleanup must use DELETE.",
                )),
            }
        }
    }

    fn fixture_json(value: &Value) -> ModelHttpResponse {
        ModelHttpResponse {
            status: 200,
            headers: std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                "application/json".to_owned(),
            )]),
            body: serde_json::to_vec(&value).unwrap(),
        }
    }

    fn fixture_media(mime: &str, bytes: &[u8]) -> ModelHttpResponse {
        ModelHttpResponse {
            status: 200,
            headers: std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                mime.to_owned(),
            )]),
            body: bytes.to_vec(),
        }
    }

    fn fixture_remote_error() -> ModelHttpResponse {
        ModelHttpResponse {
            status: 400,
            headers: std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                "application/json".to_owned(),
            )]),
            body: serde_json::to_vec(&json!({
                "error": {"message": "provider validation owns this request"}
            }))
            .unwrap(),
        }
    }

    fn execute_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        execute_fixture_with_limits(
            kind,
            model_id,
            arguments,
            responses,
            ModelRequestResourceLimits::default(),
        )
    }

    fn execute_fixture_with_limits(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        limits: ModelRequestResourceLimits,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        execute_fixture_with_invocation_cwd_and_limits(
            kind,
            model_id,
            arguments,
            responses,
            Path::new("."),
            limits,
        )
    }

    fn execute_fixture_with_invocation_cwd_and_limits(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        invocation_cwd: &Path,
        limits: ModelRequestResourceLimits,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        let catalog = ModelCatalog::bundled().unwrap();
        let request_model_id = match kind {
            ModelKind::Image => catalog
                .images()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
            ModelKind::Video => catalog
                .videos()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
            ModelKind::Tts | ModelKind::Music | ModelKind::SoundEffect => catalog
                .audio()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
        }
        .unwrap_or_else(|| model_id.to_owned());
        let model = ResolvedModelRequestModel {
            kind,
            model_id: model_id.to_owned(),
            request_model_id,
            base_url: "https://model.example/v1".to_owned(),
            api_key: "live-secret".to_owned(),
        };
        let transport = FixtureTransport {
            responses: Mutex::new(VecDeque::from(responses)),
            requests: Mutex::new(Vec::new()),
        };
        let cancellation = ModelRequestCancellation::default();
        let context = ExecutionContext::new_with_limits(
            &model,
            arguments,
            invocation_cwd,
            &cancellation,
            &transport,
            ModelRequestDeadline::after(Duration::from_secs(5)).unwrap(),
            limits,
        )
        .unwrap();
        let execution = execute_model(kind, context);
        let requests = transport.requests.into_inner().unwrap();
        let remaining = transport.responses.into_inner().unwrap().len();
        (execution, requests, remaining)
    }

    fn run_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
    ) -> (ModelExecution, Vec<ModelHttpRequest>) {
        let (execution, requests, remaining) =
            execute_fixture(kind, model_id, arguments, responses);
        assert_eq!(remaining, 0, "fixture responses must be consumed");
        (execution.unwrap(), requests)
    }

    fn execute_cancelling_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        cancel_on_request: usize,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        execute_cancellation_fixture(
            kind,
            model_id,
            arguments,
            responses,
            cancel_on_request,
            false,
        )
    }

    fn execute_cancelling_after_response_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        cancel_on_request: usize,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        execute_cancellation_fixture(
            kind,
            model_id,
            arguments,
            responses,
            cancel_on_request,
            true,
        )
    }

    fn execute_cancellation_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        cancel_on_request: usize,
        cancel_after_response: bool,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        let catalog = ModelCatalog::bundled().unwrap();
        let request_model_id = match kind {
            ModelKind::Image => catalog
                .images()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
            ModelKind::Video => catalog
                .videos()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
            ModelKind::Tts | ModelKind::Music | ModelKind::SoundEffect => catalog
                .audio()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.default_request_model_id.clone()),
        }
        .unwrap_or_else(|| model_id.to_owned());
        let model = ResolvedModelRequestModel {
            kind,
            model_id: model_id.to_owned(),
            request_model_id,
            base_url: "https://model.example/v1".to_owned(),
            api_key: "live-secret".to_owned(),
        };
        let transport = CancellingFixtureTransport {
            responses: Mutex::new(VecDeque::from(responses)),
            requests: Mutex::new(Vec::new()),
            cancel_on_request,
            cancel_after_response,
        };
        let cancellation = ModelRequestCancellation::default();
        let context = ExecutionContext::new(
            &model,
            arguments,
            Path::new("."),
            &cancellation,
            &transport,
            ModelRequestDeadline::after(Duration::from_secs(5)).unwrap(),
        )
        .unwrap();
        let execution = execute_model(kind, context);
        let requests = transport.requests.into_inner().unwrap();
        let remaining = transport.responses.into_inner().unwrap().len();
        (execution, requests, remaining)
    }

    fn execute_remote_cleanup_outcome_fixture(
        outcome: RemoteCleanupFixtureOutcome,
    ) -> (
        Result<ModelExecution, ModelRequestError>,
        Vec<ModelHttpRequest>,
        Duration,
    ) {
        let model = ResolvedModelRequestModel {
            kind: ModelKind::Video,
            model_id: "minimax-h3".to_owned(),
            request_model_id: "MiniMax-H3".to_owned(),
            base_url: "https://model.example/v1".to_owned(),
            api_key: "live-secret".to_owned(),
        };
        let transport = RemoteCleanupFixtureTransport {
            requests: Mutex::new(Vec::new()),
            outcome,
            cleanup_elapsed: Mutex::new(None),
        };
        let cancellation = ModelRequestCancellation::default();
        let arguments = Map::new();
        let context = ExecutionContext::new(
            &model,
            &arguments,
            Path::new("."),
            &cancellation,
            &transport,
            ModelRequestDeadline::after(Duration::from_secs(30)).unwrap(),
        )
        .unwrap();
        let execution = execute_model(ModelKind::Video, context);
        let requests = transport.requests.into_inner().unwrap();
        let cleanup_elapsed = transport
            .cleanup_elapsed
            .into_inner()
            .unwrap()
            .expect("cleanup request must execute");
        (execution, requests, cleanup_elapsed)
    }

    fn batch_remote_cancellation_fixture() -> (
        PathBuf,
        Arc<BatchRemoteCancellationTransport>,
        Arc<ModelOperationService<ModelRequestExecutor>>,
    ) {
        let root = std::env::temp_dir().join(format!(
            "debrute-model-request-batch-cancel-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let catalog = Arc::new(ModelCatalog::bundled().unwrap());
        let global_config = Arc::new(GlobalConfigStore::new(root.join("home")));
        global_config
            .patch(
                &json!({
                    "modelSetting": {
                        "modelId": "minimax-h3",
                        "setting": {
                            "baseUrlOverride": "https://model.example/v1",
                            "requestModelIdOverride": "MiniMax-H3",
                            "apiKey": "batch-secret"
                        }
                    }
                }),
                &catalog,
            )
            .unwrap();
        let transport = Arc::new(BatchRemoteCancellationTransport {
            requests: Mutex::new(Vec::new()),
            submitted: AtomicUsize::new(0),
            polls_started: (Mutex::new(0), Condvar::new()),
        });
        let executor = Arc::new(ModelRequestExecutor {
            catalog,
            global_config,
            provenance: Arc::new(ModelArtifactProvenanceStore::new(&root.join("home"))),
            transport: transport.clone(),
        });
        (
            root,
            transport,
            Arc::new(ModelOperationService::new(executor)),
        )
    }

    #[test]
    fn every_catalog_model_resolves_to_its_peer_kind_and_media_adapter() {
        let catalog = ModelCatalog::bundled().unwrap();
        let mut snapshot = GlobalConfigSnapshot::default();
        for entry in catalog.images() {
            snapshot
                .secrets
                .model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            let (model, _) = resolve_model(&catalog, &snapshot, &entry.debrute_model_id)
                .expect("catalog Image Model should resolve");
            assert_eq!(model.kind, ModelKind::Image);
            assert!(
                crate::model_request::image::has_adapter(&entry.debrute_model_id),
                "Catalog Image Model {} has no exact Runtime adapter",
                entry.debrute_model_id
            );
        }
        for entry in catalog.videos() {
            snapshot
                .secrets
                .model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            let (model, _) = resolve_model(&catalog, &snapshot, &entry.debrute_model_id)
                .expect("catalog Video Model should resolve");
            assert_eq!(model.kind, ModelKind::Video);
            assert!(
                crate::model_request::video::has_adapter(&entry.debrute_model_id),
                "Catalog Video Model {} has no exact Runtime adapter",
                entry.debrute_model_id
            );
        }
        for entry in catalog.audio() {
            snapshot
                .secrets
                .model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            let expected_kind = match entry.kind {
                AudioModelKind::Tts => ModelKind::Tts,
                AudioModelKind::Music => ModelKind::Music,
                AudioModelKind::SoundEffect => ModelKind::SoundEffect,
            };
            let (model, _) = resolve_model(&catalog, &snapshot, &entry.debrute_model_id)
                .expect("catalog Audio Model should resolve");
            assert_eq!(model.kind, expected_kind);
        }
    }

    #[test]
    fn new_model_catalog_defaults_materialize_exactly() {
        let catalog = ModelCatalog::bundled().unwrap();
        for (model_id, expected) in [
            (
                "doubao-seedream-5-0-pro-260628",
                json!({
                    "prompt": "make an image",
                    "output_format": "png",
                    "response_format": "url",
                    "watermark": false
                }),
            ),
            (
                "qwen-image-2.0-pro-2026-06-22",
                json!({"prompt": "make an image", "watermark": false}),
            ),
            (
                "qwen-image-2.0-2026-03-03",
                json!({"prompt": "make an image", "watermark": false}),
            ),
            (
                "doubao-seedance-2-0-260128",
                json!({
                    "prompt": "make a video",
                    "intent": "generate",
                    "watermark": false
                }),
            ),
            (
                "doubao-seedance-2-0-fast-260128",
                json!({
                    "prompt": "make a video",
                    "intent": "generate",
                    "watermark": false
                }),
            ),
            (
                "doubao-seedance-2-0-mini-260615",
                json!({
                    "prompt": "make a video",
                    "intent": "generate",
                    "watermark": false
                }),
            ),
        ] {
            let schema = catalog
                .images()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .map(|entry| entry.arguments_schema.clone())
                .or_else(|| {
                    catalog
                        .videos()
                        .iter()
                        .find(|entry| entry.debrute_model_id == model_id)
                        .map(|entry| entry.arguments_schema.clone())
                })
                .expect("new Model schema");
            let mut arguments =
                Map::from_iter([("prompt".to_owned(), expected.get("prompt").unwrap().clone())]);

            materialize_argument_defaults(model_id, &schema, &mut arguments).unwrap();
            assert_eq!(Value::Object(arguments), expected, "{model_id}");
        }
    }

    #[test]
    fn configured_model_api_key_is_used_as_an_opaque_secret() {
        let catalog = ModelCatalog::bundled().unwrap();
        let mut snapshot = GlobalConfigSnapshot::default();
        let exact_api_key = "  密钥🔑 \n";
        snapshot
            .secrets
            .model_api_keys
            .insert("gpt-image-2".to_owned(), exact_api_key.to_owned());

        let (model, _) = resolve_model(&catalog, &snapshot, "gpt-image-2")
            .expect("configured Model should resolve");

        assert_eq!(model.api_key, exact_api_key);
    }

    #[test]
    fn accepted_batch_uses_one_model_binding_after_settings_change() {
        let fixture = AcceptedBindingFixture::new();
        let accepted = fixture
            .operations
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project(),
                shape: ExecutionShape::Batch,
                requests: vec![fixture.request.clone(), fixture.request.clone()],
                concurrency: Some(1),
                timeout_seconds: Some(60),
                replace: false,
            })
            .unwrap();
        fixture.transport.wait_for_first_request();
        fixture.set_model("later.example.test", "later-request-model", "later-secret");
        fixture.transport.release_first_request();

        let terminal = fixture
            .operations
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, OperationState::Succeeded);
        let terminal_json = serde_json::to_string(&terminal).unwrap();
        assert!(!terminal_json.contains("accepted.example.test"));
        assert!(!terminal_json.contains("accepted-request-model"));
        assert!(!terminal_json.contains("accepted-secret"));
        assert_eq!(fixture.request_count(), 2);
        for index in 0..2 {
            fixture.assert_request_binding(
                index,
                "accepted.example.test",
                "accepted-request-model",
                "Bearer accepted-secret",
            );
        }

        let later = fixture
            .operations
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project(),
                shape: ExecutionShape::Single,
                requests: vec![fixture.request.clone()],
                concurrency: None,
                timeout_seconds: Some(60),
                replace: false,
            })
            .unwrap();
        let later_terminal = fixture
            .operations
            .wait(&later.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert!(later_terminal.state.is_terminal());
        assert_eq!(fixture.request_count(), 3);
        fixture.assert_request_binding(
            2,
            "later.example.test",
            "later-request-model",
            "Bearer later-secret",
        );

        fixture.set_model("later.example.test", "later-request-model", "");
        let rejected = fixture
            .operations
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project(),
                shape: ExecutionShape::Single,
                requests: vec![fixture.request.clone()],
                concurrency: None,
                timeout_seconds: Some(60),
                replace: false,
            })
            .expect_err("cleared key must affect later Operations");
        assert_eq!(rejected.code(), "model_unavailable");
        assert_eq!(fixture.request_count(), 3);
    }

    #[test]
    fn provider_schema_does_not_gate_operation_acceptance() {
        let mut fixture = AcceptedBindingFixture::new();
        fixture.request.arguments = Map::from_iter([
            ("n".to_owned(), Value::Null),
            (
                "future_parameter".to_owned(),
                json!({"nested": ["remote owns this"]}),
            ),
        ]);
        let accepted = fixture
            .operations
            .submit(SubmitModelOperation {
                invocation_cwd: fixture.project(),
                shape: ExecutionShape::Single,
                requests: vec![fixture.request.clone()],
                concurrency: None,
                timeout_seconds: Some(60),
                replace: false,
            })
            .expect("provider-required and typed fields must not gate acceptance");

        fixture.transport.wait_for_first_request();
        {
            let requests = fixture.transport.requests.lock().expect("fixture requests");
            let HttpBody::Json(body) = &requests[0].body else {
                panic!("expected JSON model request");
            };
            assert!(body.get("prompt").is_none());
            assert_eq!(body.get("n"), Some(&Value::Null));
            assert_eq!(
                body.get("future_parameter"),
                Some(&json!({"nested": ["remote owns this"]}))
            );
        }
        fixture.transport.release_first_request();

        let terminal = fixture
            .operations
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert!(terminal.state.is_terminal());
        assert_eq!(fixture.request_count(), 1);
    }

    #[test]
    fn provider_schema_keywords_are_descriptive_at_the_validation_boundary() {
        let fixture = AcceptedBindingFixture::new();
        let service = ModelRequestExecutor {
            catalog: Arc::clone(&fixture.catalog),
            global_config: Arc::clone(&fixture.global_config),
            provenance: Arc::new(ModelArtifactProvenanceStore::new(
                &fixture.root.join("home"),
            )),
            transport: fixture.transport.clone(),
        };
        let binding = AcceptedModelBinding {
            model: ResolvedModelRequestModel {
                kind: ModelKind::Image,
                model_id: "schema-fixture".to_owned(),
                request_model_id: "schema-fixture".to_owned(),
                base_url: "https://model.example/v1".to_owned(),
                api_key: "fixture-secret".to_owned(),
            },
            schema: json!({
                "type": "object",
                "required": ["required_value"],
                "properties": {
                    "typed": {"type": "string"},
                    "nested": {
                        "type": "object",
                        "required": ["child"],
                        "properties": {"child": {"type": "integer"}}
                    },
                    "any_value": {
                        "anyOf": [{"type": "string"}, {"type": "integer"}]
                    },
                    "one_value": {
                        "oneOf": [{"type": "string"}, {"type": "integer"}]
                    },
                    "defaulted": {"type": "string", "default": "convenience"}
                },
                "additionalProperties": false
            }),
        };

        for (name, arguments) in [
            ("top-level required", Map::new()),
            (
                "top-level type",
                Map::from_iter([("typed".to_owned(), json!({"provider": "shape"}))]),
            ),
            (
                "nested required",
                Map::from_iter([("nested".to_owned(), json!({}))]),
            ),
            (
                "nested type",
                Map::from_iter([("nested".to_owned(), json!({"child": "remote"}))]),
            ),
            (
                "anyOf",
                Map::from_iter([("any_value".to_owned(), json!(["remote"]))]),
            ),
            (
                "oneOf",
                Map::from_iter([("one_value".to_owned(), json!({"remote": true}))]),
            ),
        ] {
            let original = arguments.clone();
            let mut request = ModelRequest {
                model: "schema-fixture".to_owned(),
                arguments,
                output: ModelOutput {
                    directory: ".".to_owned(),
                    name: "artifact".to_owned(),
                },
            };
            service
                .validate_request(&binding, &mut request)
                .unwrap_or_else(|error| panic!("{name} must remain provider-owned: {error}"));
            assert_eq!(
                request.arguments.get("defaulted"),
                Some(&json!("convenience")),
                "{name} must still receive a missing Debrute default"
            );
            for (key, value) in original {
                assert_eq!(
                    request.arguments.get(&key),
                    Some(&value),
                    "{name} must remain unchanged"
                );
            }
        }
    }

    #[test]
    fn every_image_adapter_submits_provider_validation_inputs() {
        for (model_id, arguments) in [
            (
                "doubao-seedream-5-0-lite-260128",
                Map::from_iter([("response_format".to_owned(), json!("url"))]),
            ),
            (
                "doubao-seedream-5-0-pro-260628",
                Map::from_iter([("response_format".to_owned(), json!("url"))]),
            ),
            ("fal-ai/flux/dev", Map::new()),
            ("fal-ai/flux/dev/image-to-image", Map::new()),
            (
                "gemini-3.1-flash-image",
                Map::from_iter([("delivery".to_owned(), json!("inline"))]),
            ),
            (
                "gemini-3-pro-image",
                Map::from_iter([("delivery".to_owned(), json!("inline"))]),
            ),
            ("gpt-image-1", Map::new()),
            ("gpt-image-2", Map::new()),
            ("grok-imagine", Map::new()),
            (
                "image-01",
                Map::from_iter([("response_format".to_owned(), json!("url"))]),
            ),
            ("qwen-image-2.0-pro-2026-06-22", Map::new()),
            ("qwen-image-2.0-2026-03-03", Map::new()),
            ("wan2.7-image", Map::new()),
        ] {
            assert_first_request_reaches_provider(ModelKind::Image, model_id, &arguments);
        }
    }

    #[test]
    fn every_video_adapter_submits_provider_validation_inputs() {
        for (model_id, arguments) in [
            (
                "doubao-seedance-2-0-260128",
                Map::from_iter([("intent".to_owned(), json!("generate"))]),
            ),
            (
                "doubao-seedance-2-0-fast-260128",
                Map::from_iter([("intent".to_owned(), json!("generate"))]),
            ),
            (
                "doubao-seedance-2-0-mini-260615",
                Map::from_iter([("intent".to_owned(), json!("generate"))]),
            ),
            ("minimax-h3", Map::new()),
        ] {
            assert_first_request_reaches_provider(ModelKind::Video, model_id, &arguments);
        }
    }

    #[test]
    fn every_audio_adapter_submits_provider_validation_inputs() {
        for (kind, model_id, arguments) in [
            (ModelKind::Tts, "dashscope-qwen3-tts-flash", Map::new()),
            (ModelKind::Tts, "doubao-seed-tts-2-0", Map::new()),
            (
                ModelKind::Tts,
                "elevenlabs-multilingual-v2",
                Map::from_iter([("voice_id".to_owned(), json!("voice"))]),
            ),
            (ModelKind::Music, "elevenlabs-music", Map::new()),
            (
                ModelKind::SoundEffect,
                "elevenlabs-sound-effects",
                Map::new(),
            ),
            (
                ModelKind::Tts,
                "elevenlabs-v3-tts",
                Map::from_iter([("voice_id".to_owned(), json!("voice"))]),
            ),
            (
                ModelKind::SoundEffect,
                "fal-stable-audio-3-small-sfx",
                Map::new(),
            ),
            (
                ModelKind::Music,
                "fal-stable-audio-text-to-audio",
                Map::new(),
            ),
            (ModelKind::Tts, "gemini-3-1-flash-tts-preview", Map::new()),
            (ModelKind::Music, "google-lyria-3-clip-preview", Map::new()),
            (ModelKind::Music, "google-lyria-3-pro-preview", Map::new()),
            (ModelKind::Music, "minimax-music-3-0", Map::new()),
            (ModelKind::Tts, "minimax-speech-2-8-hd", Map::new()),
            (ModelKind::Tts, "openai-gpt-4o-mini-tts", Map::new()),
            (ModelKind::Tts, "openai-tts-1", Map::new()),
            (ModelKind::Tts, "openai-tts-1-hd", Map::new()),
        ] {
            assert_first_request_reaches_provider(kind, model_id, &arguments);
        }
    }

    fn assert_first_request_reaches_provider(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
    ) {
        let (result, requests, remaining) =
            execute_fixture(kind, model_id, arguments, vec![fixture_remote_error()]);
        let error = result.expect_err("provider fixture must reject the request");
        assert_ne!(error.code(), "model_request_argument_invalid", "{model_id}");
        assert_eq!(requests.len(), 1, "{model_id} did not reach the provider");
        assert_eq!(remaining, 0, "{model_id} did not consume the response");
    }

    #[test]
    fn all_five_peer_request_fixtures_use_exact_adapters() {
        let (image, image_requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-1",
            &Map::from_iter([("prompt".to_owned(), json!("poster"))]),
            vec![fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))],
        );
        assert_eq!(image.payloads[0].mime_type, "image/png");
        assert!(image_requests[0].url.ends_with("/images/generations"));

        let (video, video_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-260128",
            &Map::from_iter([
                ("prompt".to_owned(), json!("slow pan")),
                ("intent".to_owned(), json!("generate")),
            ]),
            vec![
                fixture_json(&json!({"id": "task-1"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {"video_url": "https://media.example/out.mp4"}
                })),
                fixture_media("video/mp4", b"video"),
            ],
        );
        assert_eq!(video.payloads[0].mime_type, "video/mp4");
        assert_eq!(video_requests.len(), 3);
        assert!(
            video_requests[1]
                .url
                .ends_with("/contents/generations/tasks/task-1")
        );

        let (tts, tts_requests) = run_fixture(
            ModelKind::Tts,
            "openai-tts-1",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("voice".to_owned(), json!("alloy")),
            ]),
            vec![fixture_media("audio/mpeg", b"tts")],
        );
        assert_eq!(tts.payloads[0].mime_type, "audio/mpeg");
        assert!(tts_requests[0].url.ends_with("/audio/speech"));

        let (music, music_requests) = run_fixture(
            ModelKind::Music,
            "elevenlabs-music",
            &Map::from_iter([("prompt".to_owned(), json!("ambient"))]),
            vec![fixture_media("audio/mpeg", b"music")],
        );
        assert_eq!(music.payloads[0].mime_type, "audio/mpeg");
        assert!(music_requests[0].url.ends_with("/music"));

        let (effect, effect_requests) = run_fixture(
            ModelKind::SoundEffect,
            "elevenlabs-sound-effects",
            &Map::from_iter([("text".to_owned(), json!("thunder"))]),
            vec![fixture_media("audio/mpeg", b"effect")],
        );
        assert_eq!(effect.payloads[0].mime_type, "audio/mpeg");
        assert!(effect_requests[0].url.ends_with("/sound-generation"));
    }

    #[test]
    fn doubao_tts_uses_continuous_frames_without_defaults_or_pcm_wrapping() {
        let (execution, requests) = run_fixture(
            ModelKind::Tts,
            "doubao-seed-tts-2-0",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("speaker".to_owned(), json!("speaker-v2")),
                (
                    "audio_params".to_owned(),
                    json!({"format": "pcm", "sample_rate": 22_050}),
                ),
            ]),
            vec![fixture_media(
                "application/json",
                br#"{"code":0,"data":"AAEC"}{"code":0,"data":"AwQ="}{"code":20000000}"#,
            )],
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Doubao TTS request must be JSON");
        };
        assert!(body.get("user").is_none());
        assert_eq!(
            body.pointer("/req_params/speaker"),
            Some(&json!("speaker-v2"))
        );
        assert_eq!(
            body.pointer("/req_params/audio_params/sample_rate"),
            Some(&json!(22_050))
        );
        assert_eq!(execution.payloads[0].bytes, &[0, 1, 2, 3, 4]);
        assert_eq!(execution.payloads[0].mime_type, "audio/pcm");
    }

    #[test]
    fn qwen_gemini_and_minimax_tts_use_exact_independent_contracts() {
        let (_, qwen_requests) = run_fixture(
            ModelKind::Tts,
            "dashscope-qwen3-tts-flash",
            &Map::from_iter([
                ("text".to_owned(), json!("你好")),
                ("voice".to_owned(), json!("Cherry")),
                ("language_type".to_owned(), json!("Auto")),
            ]),
            vec![
                fixture_json(&json!({
                    "output": {"audio": {"url": "https://media.example/qwen-audio"}}
                })),
                fixture_media("audio/wav", b"RIFFaudio"),
            ],
        );
        let HttpBody::Json(qwen_body) = &qwen_requests[0].body else {
            panic!("Qwen TTS request must be JSON");
        };
        assert_eq!(
            qwen_body.pointer("/input/language_type"),
            Some(&json!("Auto"))
        );

        let (gemini, gemini_requests) = run_fixture(
            ModelKind::Tts,
            "gemini-3-1-flash-tts-preview",
            &Map::from_iter([
                ("text".to_owned(), json!("Speaker A: Hello")),
                (
                    "speech_config".to_owned(),
                    json!([{"speaker": "Speaker A", "voice": "Kore"}]),
                ),
                ("language".to_owned(), json!("en-US")),
            ]),
            vec![fixture_json(&json!({
                "steps": [{"type": "model_output", "content": [
                    {"type": "audio", "mime_type": "audio/pcm;rate=24000;channels=1;bits=16", "data": "AAEC"}
                ]}]
            }))],
        );
        assert_eq!(gemini.payloads[0].bytes, &[0, 1, 2]);
        assert!(gemini.payloads[0].mime_type.starts_with("audio/pcm"));
        let HttpBody::Json(gemini_body) = &gemini_requests[0].body else {
            panic!("Gemini TTS request must be JSON");
        };
        assert_eq!(gemini_body.get("store"), Some(&json!(false)));
        assert_eq!(
            gemini_body.pointer("/generation_config/speech_config/0/speaker"),
            Some(&json!("Speaker A"))
        );

        let (minimax, minimax_requests) = run_fixture(
            ModelKind::Tts,
            "minimax-speech-2-8-hd",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                (
                    "voice_setting".to_owned(),
                    json!({"voice_id": "male-qn-qingse"}),
                ),
                ("output_format".to_owned(), json!("hex")),
            ]),
            vec![fixture_json(&json!({
                "base_resp": {"status_code": 0},
                "data": {"audio": "494433"},
                "extra_info": {"audio_format": "mp3"}
            }))],
        );
        assert_eq!(minimax.payloads[0].bytes, b"ID3");
        let HttpBody::Json(minimax_body) = &minimax_requests[0].body else {
            panic!("MiniMax TTS request must be JSON");
        };
        assert!(minimax_body.get("stream").is_none());
        assert!(minimax_body.get("audio_setting").is_none());
        assert_eq!(
            minimax_body.pointer("/voice_setting/voice_id"),
            Some(&json!("male-qn-qingse"))
        );
    }

    #[test]
    fn three_openai_tts_models_own_independent_exact_requests() {
        for (model, voice) in [
            ("openai-gpt-4o-mini-tts", json!({"id": "custom-voice"})),
            ("openai-tts-1", json!("alloy")),
            ("openai-tts-1-hd", json!("nova")),
        ] {
            let (execution, requests) = run_fixture(
                ModelKind::Tts,
                model,
                &Map::from_iter([
                    ("text".to_owned(), json!("hello")),
                    ("voice".to_owned(), voice.clone()),
                ]),
                vec![fixture_media("audio/mpeg", b"exact audio")],
            );
            assert_eq!(execution.payloads[0].bytes, b"exact audio");
            assert_eq!(requests.len(), 1);
            let HttpBody::Json(body) = &requests[0].body else {
                panic!("OpenAI TTS request must be JSON");
            };
            assert_eq!(
                body.get("model"),
                Some(&json!(model.trim_start_matches("openai-")))
            );
            assert_eq!(body.get("voice"), Some(&voice));
            assert!(body.get("response_format").is_none());
        }

        let (pcm, requests) = run_fixture(
            ModelKind::Tts,
            "openai-tts-1",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("voice".to_owned(), json!("alloy")),
                ("format".to_owned(), json!("pcm")),
            ]),
            vec![fixture_media("audio/pcm", &[0, 1, 2, 3])],
        );
        assert_eq!(pcm.payloads[0].bytes, &[0, 1, 2, 3]);
        assert_eq!(pcm.payloads[0].mime_type, "audio/pcm");
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("OpenAI TTS request must be JSON");
        };
        assert_eq!(body.get("response_format"), Some(&json!("pcm")));
    }

    #[test]
    fn elevenlabs_tts_models_own_independent_exact_requests() {
        let (_, v3_requests) = run_fixture(
            ModelKind::Tts,
            "elevenlabs-v3-tts",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("voice_id".to_owned(), json!("voice-v3")),
                (
                    "voice_settings".to_owned(),
                    json!({"stability": 0.4, "speed": 1.1}),
                ),
                ("seed".to_owned(), json!(7)),
            ]),
            vec![fixture_media("audio/mpeg", b"v3")],
        );
        assert!(v3_requests[0].url.contains("/text-to-speech/voice-v3"));
        assert!(!v3_requests[0].url.contains("output_format"));
        let HttpBody::Json(v3_body) = &v3_requests[0].body else {
            panic!("ElevenLabs v3 request must be JSON");
        };
        assert_eq!(v3_body.get("model_id"), Some(&json!("eleven_v3")));
        assert_eq!(
            v3_body.get("voice_settings"),
            Some(&json!({"stability": 0.4, "speed": 1.1}))
        );

        let (_, v2_requests) = run_fixture(
            ModelKind::Tts,
            "elevenlabs-multilingual-v2",
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("voice_id".to_owned(), json!("voice-v2")),
                ("output_format".to_owned(), json!("wav_44100")),
                ("previous_request_ids".to_owned(), json!(["request-1"])),
            ]),
            vec![fixture_media("audio/wav", b"RIFFaudio")],
        );
        assert!(v2_requests[0].url.contains("output_format=wav_44100"));
        let HttpBody::Json(v2_body) = &v2_requests[0].body else {
            panic!("ElevenLabs multilingual request must be JSON");
        };
        assert_eq!(
            v2_body.get("previous_request_ids"),
            Some(&json!(["request-1"]))
        );
        assert_eq!(
            v2_body.get("model_id"),
            Some(&json!("eleven_multilingual_v2"))
        );
    }

    #[test]
    fn elevenlabs_music_and_sound_effects_own_independent_exact_requests() {
        let mut music_response = fixture_media("audio/mpeg", b"music");
        music_response
            .headers
            .insert("song-id".to_owned(), "song-7".to_owned());
        let (music, music_requests) = run_fixture(
            ModelKind::Music,
            "elevenlabs-music",
            &Map::from_iter([(
                "composition_plan".to_owned(),
                json!({"sections": [{"name": "intro"}]}),
            )]),
            vec![music_response],
        );
        assert_eq!(music.payloads[0].model_output, json!({"songId": "song-7"}));
        assert!(music_requests[0].url.ends_with("/music"));
        assert!(!music_requests[0].url.contains("output_format"));
        let HttpBody::Json(music_body) = &music_requests[0].body else {
            panic!("ElevenLabs Music request must be JSON");
        };
        assert_eq!(music_body.get("model_id"), Some(&json!("music_v2")));
        assert!(music_body.get("prompt").is_none());
        assert_eq!(
            music_body.get("composition_plan"),
            Some(&json!({"sections": [{"name": "intro"}]}))
        );

        let (_, effect_requests) = run_fixture(
            ModelKind::SoundEffect,
            "elevenlabs-sound-effects",
            &Map::from_iter([
                ("text".to_owned(), json!("close thunder")),
                ("prompt_influence".to_owned(), json!(0.7)),
                ("output_format".to_owned(), json!("wav_44100")),
            ]),
            vec![fixture_media("audio/wav", b"RIFFeffect")],
        );
        assert!(effect_requests[0].url.contains("output_format=wav_44100"));
        let HttpBody::Json(effect_body) = &effect_requests[0].body else {
            panic!("ElevenLabs Sound Effects request must be JSON");
        };
        assert_eq!(
            effect_body.get("model_id"),
            Some(&json!("eleven_text_to_sound_v2"))
        );
        assert_eq!(effect_body.get("text"), Some(&json!("close thunder")));
        assert!(effect_body.get("prompt").is_none());
        assert!(effect_body.get("output_format").is_none());
    }

    #[test]
    fn lyria_models_own_independent_typed_input_and_output_contracts() {
        let (clip, clip_requests) = run_fixture(
            ModelKind::Music,
            "google-lyria-3-clip-preview",
            &Map::from_iter([
                ("prompt".to_owned(), json!("warm motif")),
                (
                    "image".to_owned(),
                    json!(["data:image/png;base64,iVBORw0KGgo="]),
                ),
            ]),
            vec![fixture_json(&json!({
                "steps": [{"type": "model_output", "content": [
                    {"type": "text", "text": "clip complete"},
                    {"type": "audio", "mime_type": "audio/mpeg", "data": "SUQz"}
                ]}]
            }))],
        );
        assert_eq!(clip.payloads[0].bytes, b"ID3");
        assert_eq!(
            clip.payloads[0].model_output,
            json!({"text": ["clip complete"]})
        );
        let HttpBody::Json(clip_body) = &clip_requests[0].body else {
            panic!("Lyria Clip request must be JSON");
        };
        assert_eq!(clip_body.get("store"), Some(&json!(false)));
        assert_eq!(clip_body.pointer("/input/0/type"), Some(&json!("text")));
        assert_eq!(clip_body.pointer("/input/1/type"), Some(&json!("image")));
        assert_eq!(
            clip_body.pointer("/input/1/mime_type"),
            Some(&json!("image/png"))
        );
        assert!(clip_body.get("response_format").is_none());

        let (pro, pro_requests) = run_fixture(
            ModelKind::Music,
            "google-lyria-3-pro-preview",
            &Map::from_iter([
                ("prompt".to_owned(), json!("full arrangement")),
                ("format".to_owned(), json!("wav")),
            ]),
            vec![fixture_json(&json!({
                "steps": [{"type": "model_output", "content": [
                    {"type": "audio", "mime_type": "audio/wav", "data": "UklGRg=="},
                    {"type": "text", "text": "pro complete"}
                ]}]
            }))],
        );
        assert_eq!(pro.payloads[0].bytes, b"RIFF");
        assert_eq!(
            pro.payloads[0].model_output,
            json!({"text": ["pro complete"]})
        );
        let HttpBody::Json(pro_body) = &pro_requests[0].body else {
            panic!("Lyria Pro request must be JSON");
        };
        assert_eq!(
            pro_body.get("response_format"),
            Some(&json!({"type": "audio"}))
        );
        assert!(pro_body.get("format").is_none());
    }

    #[test]
    fn minimax_music_three_owns_hex_and_url_contracts_without_added_defaults() {
        let (hex, hex_requests) = run_fixture(
            ModelKind::Music,
            "minimax-music-3-0",
            &Map::from_iter([
                ("prompt".to_owned(), json!("minimal piano")),
                ("output_format".to_owned(), json!("hex")),
            ]),
            vec![fixture_json(&json!({
                "base_resp": {"status_code": 0},
                "data": {"audio": "494433"},
                "extra_info": {"audio_format": "mp3"}
            }))],
        );
        assert_eq!(hex.payloads[0].bytes, b"ID3");
        let HttpBody::Json(hex_body) = &hex_requests[0].body else {
            panic!("MiniMax Music request must be JSON");
        };
        assert_eq!(hex_body.get("model"), Some(&json!("music-3.0")));
        assert_eq!(hex_body.get("output_format"), Some(&json!("hex")));
        assert!(hex_body.get("audio_setting").is_none());
        assert!(hex_body.get("is_instrumental").is_none());

        let (url, url_requests) = run_fixture(
            ModelKind::Music,
            "minimax-music-3-0",
            &Map::from_iter([
                ("lyrics".to_owned(), json!("one clear line")),
                ("output_format".to_owned(), json!("url")),
            ]),
            vec![
                fixture_json(&json!({
                    "base_resp": {"status_code": 0},
                    "data": {"audio": "https://media.example/minimax-music"}
                })),
                fixture_media("audio/flac", b"fLaC"),
            ],
        );
        assert_eq!(url.payloads[0].bytes, b"fLaC");
        assert_eq!(url_requests.len(), 2);
        let HttpBody::Json(url_body) = &url_requests[0].body else {
            panic!("MiniMax Music URL request must be JSON");
        };
        assert!(url_body.get("prompt").is_none());
        assert_eq!(url_body.get("lyrics"), Some(&json!("one clear line")));
    }

    #[test]
    fn fal_music_and_sfx_models_own_separate_no_retry_queue_contracts() {
        for (kind, model, arguments, endpoint) in [
            (
                ModelKind::Music,
                "fal-stable-audio-text-to-audio",
                Map::from_iter([
                    ("prompt".to_owned(), json!("slow texture")),
                    ("seconds_total".to_owned(), json!(12)),
                ]),
                "/fal-ai/stable-audio-25/text-to-audio",
            ),
            (
                ModelKind::SoundEffect,
                "fal-stable-audio-3-small-sfx",
                Map::from_iter([
                    ("prompt".to_owned(), json!("metal impact")),
                    ("duration".to_owned(), json!(2.5)),
                ]),
                "/fal-ai/stable-audio-3/small/sfx/text-to-audio",
            ),
        ] {
            let (execution, requests) = run_fixture(
                kind,
                model,
                &arguments,
                vec![
                    fixture_json(&json!({
                        "request_id": "request-7",
                        "status_url": "https://model.example/status/request-7"
                    })),
                    fixture_json(&json!({
                        "status": "COMPLETED",
                        "response_url": "https://model.example/result/request-7"
                    })),
                    fixture_json(&json!({
                        "audio": {"url": "https://media.example/fal-output"}
                    })),
                    fixture_media("audio/wav", b"RIFFfal"),
                ],
            );
            assert_eq!(execution.payloads[0].bytes, b"RIFFfal");
            assert_eq!(requests.len(), 4);
            assert!(requests[0].url.ends_with(endpoint));
            assert_eq!(
                requests[0]
                    .headers
                    .get("x-fal-no-retry")
                    .map(String::as_str),
                Some("1")
            );
            let HttpBody::Json(body) = &requests[0].body else {
                panic!("fal audio submit request must be JSON");
            };
            assert_eq!(body.as_object(), Some(&arguments));
        }
    }

    #[test]
    fn gpt_image_two_data_url_edits_use_multipart() {
        let (_, requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-2",
            &Map::from_iter([
                ("prompt".to_owned(), json!("edit")),
                (
                    "image".to_owned(),
                    json!(["data:image/png;base64,iVBORw0KGgo="]),
                ),
            ]),
            vec![fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))],
        );
        assert!(matches!(requests[0].body, HttpBody::Multipart { .. }));
    }

    #[test]
    fn default_model_request_resource_limits_are_128_and_256_mib() {
        let limits = ModelRequestResourceLimits::default();

        assert_eq!(limits.input_media_item_bytes, 128 * 1024 * 1024);
        assert_eq!(limits.model_request_bytes, 256 * 1024 * 1024);
    }

    #[test]
    fn input_media_item_limit_is_inclusive() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQIDBA=="]),
            ),
        ]);
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 4096,
            },
        );

        assert!(result.is_ok());
        assert_eq!(requests.len(), 1);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn input_media_item_limit_rejects_before_transport() {
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQIDBAU="]),
            ),
        ]);

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 1024,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn local_input_uses_the_same_media_item_limit_before_transport() {
        let invocation_cwd = std::env::temp_dir().join(format!(
            "debrute-model-request-input-limit-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&invocation_cwd).unwrap();
        std::fs::write(invocation_cwd.join("input.png"), b"12345").unwrap();
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!(["input.png"])),
        ]);

        let (result, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            &invocation_cwd,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 1024,
            },
        );
        std::fs::remove_dir_all(invocation_cwd).unwrap();

        assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn model_request_budget_rejects_later_media_before_transport() {
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!([
                    "data:image/png;base64,AQIDBA==",
                    "data:image/png;base64,AQIDBA==",
                    "data:image/png;base64,AQIDBA=="
                ]),
            ),
        ]);

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 38,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn known_inline_request_lower_bound_rejects_before_base64_decode() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!([format!("data:{};base64,!!!!", "x".repeat(64))]),
            ),
        ]);
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 32,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn downloaded_multipart_input_uses_the_input_item_limit() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
            ),
        ]);
        let responses = vec![
            fixture_media("image/png", b"12345"),
            fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            })),
        ];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 1024,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
        assert_eq!(
            requests.len(),
            1,
            "only the input download may reach transport"
        );
        assert_eq!(
            requests[0].method,
            crate::model_request::types::HttpMethod::Get
        );
        assert_eq!(remaining, 1);
    }

    #[test]
    fn downloaded_input_rejects_non_success_response_before_model_request() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
            ),
        ]);
        let responses = vec![
            ModelHttpResponse {
                status: 404,
                headers: std::collections::BTreeMap::from([(
                    "content-type".to_owned(),
                    "image/png".to_owned(),
                )]),
                body: b"\x89PNG\r\n\x1a\n".to_vec(),
            },
            fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            })),
        ];

        let (result, requests, remaining) =
            execute_fixture(ModelKind::Image, "gpt-image-2", &arguments, responses);

        assert_eq!(result.unwrap_err().code(), "input_media_download_failed");
        assert_eq!(requests.len(), 1, "only the failed input download may run");
        assert_eq!(
            remaining, 1,
            "the model request must not consume a response"
        );
    }

    #[test]
    fn downloaded_input_is_bounded_by_the_remaining_request_budget() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
            ),
        ]);
        let responses = vec![
            fixture_media("image/png", b"123"),
            fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            })),
        ];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 12,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].maximum_response_bytes, 2);
        assert_eq!(remaining, 1);
    }

    #[test]
    fn direct_public_url_contributes_its_text_to_the_request_budget() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!(["https://1.1.1.1/input.png"])),
        ]);
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 8,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn downloaded_input_does_not_temporarily_consume_the_direct_url_budget() {
        let long_url = format!("https://1.1.1.1/{}.png", "x".repeat(5000));
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,AQ==", long_url]),
            ),
        ]);
        let responses = vec![
            fixture_media("image/png", b"1"),
            fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            })),
        ];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 4096,
            },
        );

        assert!(result.is_ok());
        assert_eq!(requests.len(), 2);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn final_json_request_size_is_enforced_before_transport() {
        let arguments = Map::from_iter([("prompt".to_owned(), json!("x".repeat(64)))]);
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 32,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn final_multipart_request_size_is_enforced_before_transport() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!(["data:image/png;base64,AQ=="])),
        ]);
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];

        let (result, requests, remaining) = execute_fixture_with_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 16,
            },
        );

        assert_eq!(result.unwrap_err().code(), "model_request_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn gpt_image_edits_submit_empty_images_mask_only_and_generic_image_mime() {
        let response = || {
            fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))
        };

        let (_, empty_requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-2",
            &Map::from_iter([
                ("prompt".to_owned(), json!("edit")),
                ("image".to_owned(), json!([])),
            ]),
            vec![response()],
        );
        let HttpBody::Json(empty_body) = &empty_requests[0].body else {
            panic!("URL-only GPT edit must be JSON");
        };
        assert_eq!(empty_body.get("images"), Some(&json!([])));

        let (_, mask_requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-2",
            &Map::from_iter([
                ("prompt".to_owned(), json!("edit")),
                (
                    "mask".to_owned(),
                    json!("data:image/png;base64,iVBORw0KGgo="),
                ),
            ]),
            vec![response()],
        );
        assert!(matches!(mask_requests[0].body, HttpBody::Multipart { .. }));

        let (_, gif_requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-2",
            &Map::from_iter([
                ("prompt".to_owned(), json!("edit")),
                (
                    "image".to_owned(),
                    json!(["data:image/gif;base64,R0lGODlh"]),
                ),
            ]),
            vec![response()],
        );
        assert!(matches!(gif_requests[0].body, HttpBody::Multipart { .. }));
    }

    #[test]
    fn provider_side_media_urls_are_publicly_validated_before_submission() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!(["http://127.0.0.1/private.png"])),
        ]);
        let (result, requests, remaining) =
            execute_fixture(ModelKind::Image, "gpt-image-2", &arguments, Vec::new());
        assert_eq!(result.unwrap_err().code(), "remote_media_host_blocked");
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn image_response_cardinality_has_no_generic_sixteen_artifact_ceiling() {
        let images = (0..17)
            .map(|_| json!({"b64_json": "iVBORw0KGgo="}))
            .collect::<Vec<_>>();
        let arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Image,
            "gpt-image-1",
            &arguments,
            vec![fixture_json(&json!({"data": images}))],
        );
        assert_eq!(result.unwrap().payloads.len(), 17);
        assert_eq!(requests.len(), 1);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn gpt_image_response_requires_b64_json_for_every_item() {
        let arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Image,
            "gpt-image-1",
            &arguments,
            vec![fixture_json(&json!({
                "data": [
                    {"b64_json": "iVBORw0KGgo="},
                    {"url": "https://media.example/url-only.png"}
                ]
            }))],
        );
        assert_eq!(result.unwrap_err().code(), "model_response_invalid");
        assert_eq!(requests.len(), 1);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn gemini_flash_uses_interactions_inline_contract() {
        let (execution, requests) = run_fixture(
            ModelKind::Image,
            "gemini-3.1-flash-image",
            &Map::from_iter([
                ("prompt".to_owned(), json!("restyle")),
                (
                    "image".to_owned(),
                    json!(["data:image/png;base64,iVBORw0KGgo="]),
                ),
                ("aspect_ratio".to_owned(), json!("16:9")),
                ("image_size".to_owned(), json!("2K")),
                ("delivery".to_owned(), json!("inline")),
                ("future_parameter".to_owned(), json!("remote validates")),
            ]),
            vec![fixture_json(&json!({
                "steps": [{
                    "type": "model_output",
                    "content": [
                        {"type": "text", "text": "done"},
                        {"type": "image", "data": "iVBORw0KGgo="}
                    ]
                }]
            }))],
        );
        assert_eq!(execution.payloads.len(), 1);
        assert!(requests[0].url.ends_with("/v1/interactions"));
        assert_eq!(
            requests[0]
                .headers
                .get("x-goog-api-key")
                .map(String::as_str),
            Some("live-secret")
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Gemini Interactions request must be JSON");
        };
        assert_eq!(body.get("model"), Some(&json!("gemini-3.1-flash-image")));
        assert_eq!(body.get("store"), Some(&json!(false)));
        assert_eq!(
            body.get("future_parameter"),
            Some(&json!("remote validates"))
        );
        assert_eq!(
            body.pointer("/input/0"),
            Some(&json!({
                "type": "text",
                "text": "restyle"
            }))
        );
        assert_eq!(
            body.pointer("/input/1"),
            Some(&json!({
                "type": "image",
                "mime_type": "image/png",
                "data": "iVBORw0KGgo="
            }))
        );
        assert_eq!(
            body.get("response_format"),
            Some(&json!({
                "type": "image",
                "delivery": "inline",
                "aspect_ratio": "16:9",
                "image_size": "2K"
            }))
        );
    }

    #[test]
    fn gemini_pro_uses_its_independent_uri_response_contract() {
        let (execution, requests) = run_fixture(
            ModelKind::Image,
            "gemini-3-pro-image",
            &Map::from_iter([
                ("prompt".to_owned(), json!("render")),
                ("delivery".to_owned(), json!("uri")),
                ("future_parameter".to_owned(), json!(9)),
            ]),
            vec![
                fixture_json(&json!({
                    "steps": [{
                        "type": "model_output",
                        "content": [{
                            "type": "image",
                            "uri": "https://media.example/pro-output"
                        }]
                    }]
                })),
                fixture_media("application/octet-stream", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(execution.payloads.len(), 1);
        assert_eq!(requests.len(), 2);
        assert!(requests[0].url.ends_with("/v1/interactions"));
        assert_eq!(requests[1].url, "https://media.example/pro-output");
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Gemini Interactions request must be JSON");
        };
        assert_eq!(body.get("model"), Some(&json!("gemini-3-pro-image")));
        assert_eq!(body.get("future_parameter"), Some(&json!(9)));
        assert_eq!(
            body.get("response_format"),
            Some(&json!({
                "type": "image",
                "delivery": "uri"
            }))
        );
    }

    #[test]
    fn vydra_grok_imagine_uses_one_synchronous_image_response() {
        let (execution, requests) = run_fixture(
            ModelKind::Image,
            "grok-imagine",
            &Map::from_iter([
                ("prompt".to_owned(), json!("poster")),
                ("aspect_ratio".to_owned(), json!("16:9")),
            ]),
            vec![
                fixture_json(&json!({
                    "jobId": "ignored-job",
                    "status": "completed",
                    "imageUrl": "https://media.example/vydra-output",
                    "resultUrls": ["https://media.example/unused"]
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(execution.payloads.len(), 1);
        assert_eq!(requests.len(), 2);
        assert!(requests[0].url.ends_with("/v1/models/grok-imagine"));
        assert_eq!(requests[1].url, "https://media.example/vydra-output");
        assert!(
            !requests
                .iter()
                .any(|request| request.url.contains("/jobs/"))
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Vydra request must be JSON");
        };
        assert_eq!(body.get("model"), Some(&json!("text-to-image")));
    }

    #[test]
    fn wan_2_7_uses_one_synchronous_model_request() {
        let (execution, requests) = run_fixture(
            ModelKind::Image,
            "wan2.7-image",
            &Map::from_iter([
                ("prompt".to_owned(), json!("same cat in two seasons")),
                ("image".to_owned(), json!([])),
                ("watermark".to_owned(), json!(false)),
                ("future_parameter".to_owned(), json!("remote owns this")),
            ]),
            vec![
                fixture_json(&json!({
                    "output": {"choices": [{"message": {"content": [
                        {"image": "https://media.example/wan-one"},
                        {"image": "https://media.example/wan-two"}
                    ]}}]}
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
                fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
            ],
        );
        assert_eq!(execution.payloads.len(), 2);
        assert_eq!(requests.len(), 3);
        assert!(
            requests[0]
                .url
                .ends_with("/services/aigc/multimodal-generation/generation")
        );
        assert!(!requests[0].headers.contains_key("x-dashscope-async"));
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Wan request must be JSON");
        };
        assert_eq!(
            body.pointer("/parameters/future_parameter"),
            Some(&json!("remote owns this"))
        );
    }

    #[test]
    fn seedream_url_and_base64_contracts_are_exact() {
        let (_, url_requests) = run_fixture(
            ModelKind::Image,
            "doubao-seedream-5-0-lite-260128",
            &Map::from_iter([
                ("prompt".to_owned(), json!("poster")),
                ("image".to_owned(), json!([])),
                ("response_format".to_owned(), json!("url")),
                ("output_format".to_owned(), json!("png")),
                ("watermark".to_owned(), json!(false)),
            ]),
            vec![
                fixture_json(&json!({
                    "data": [{"url": "https://media.example/seedream"}]
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(url_requests.len(), 2);
        let HttpBody::Json(url_body) = &url_requests[0].body else {
            panic!("Seedream request must be JSON");
        };
        assert_eq!(url_body.get("image"), Some(&json!([])));

        let (base64_execution, base64_requests) = run_fixture(
            ModelKind::Image,
            "doubao-seedream-5-0-lite-260128",
            &Map::from_iter([
                ("prompt".to_owned(), json!("poster")),
                ("response_format".to_owned(), json!("b64_json")),
            ]),
            vec![fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))],
        );
        assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
        assert_eq!(base64_requests.len(), 1);
    }

    #[test]
    fn seedream_5_pro_owns_ordered_editing_and_both_response_transports() {
        let (url_execution, url_requests) = run_fixture(
            ModelKind::Image,
            "doubao-seedream-5-0-pro-260628",
            &Map::from_iter([
                (
                    "prompt".to_owned(),
                    json!("turn both references into a poster"),
                ),
                (
                    "image".to_owned(),
                    json!([
                        "data:image/png;base64,iVBORw0KGgo=",
                        "data:image/jpeg;base64,/9j/"
                    ]),
                ),
                ("output_format".to_owned(), json!("png")),
                ("response_format".to_owned(), json!("url")),
                ("watermark".to_owned(), json!(false)),
                ("future_parameter".to_owned(), json!("remote owns this")),
            ]),
            vec![
                fixture_json(&json!({
                    "data": [
                        {"url": "https://media.example/pro-one.png"},
                        {"url": "https://media.example/pro-two.png"}
                    ]
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\nsecond"),
            ],
        );
        assert_eq!(url_execution.payloads.len(), 2);
        assert_eq!(url_requests.len(), 3);
        assert_eq!(url_requests[0].method, HttpMethod::Post);
        assert_eq!(
            url_requests[0].url,
            "https://model.example/v1/images/generations"
        );
        assert_eq!(url_requests[1].url, "https://media.example/pro-one.png");
        assert_eq!(url_requests[2].url, "https://media.example/pro-two.png");
        let HttpBody::Json(url_body) = &url_requests[0].body else {
            panic!("Seedream 5.0 Pro request must be JSON");
        };
        assert_eq!(
            url_body.get("model"),
            Some(&json!("doubao-seedream-5-0-pro-260628"))
        );
        assert_eq!(
            url_body.get("image"),
            Some(&json!([
                "data:image/png;base64,iVBORw0KGgo=",
                "data:image/jpeg;base64,/9j/"
            ]))
        );
        assert_eq!(
            url_body.get("future_parameter"),
            Some(&json!("remote owns this"))
        );

        let (base64_execution, base64_requests) = run_fixture(
            ModelKind::Image,
            "doubao-seedream-5-0-pro-260628",
            &Map::from_iter([
                ("prompt".to_owned(), json!("make a transparent icon")),
                ("response_format".to_owned(), json!("b64_json")),
            ]),
            vec![fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))],
        );
        assert_eq!(base64_execution.payloads.len(), 1);
        assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
        assert_eq!(base64_requests.len(), 1);
    }

    #[test]
    fn qwen_image_2_snapshots_own_independent_ordered_synchronous_contracts() {
        let (pro, pro_requests) = run_fixture(
            ModelKind::Image,
            "qwen-image-2.0-pro-2026-06-22",
            &Map::from_iter([
                ("prompt".to_owned(), json!("combine Image 1 and Image 2")),
                (
                    "image".to_owned(),
                    json!([
                        "data:image/png;base64,iVBORw0KGgo=",
                        "data:image/jpeg;base64,/9j/"
                    ]),
                ),
                ("n".to_owned(), json!(2)),
                ("watermark".to_owned(), json!(false)),
                ("future_parameter".to_owned(), json!(7)),
            ]),
            vec![
                fixture_json(&json!({
                    "output": {"choices": [
                        {"message": {"content": [
                            {"image": "https://media.example/qwen-pro-one.png"}
                        ]}},
                        {"message": {"content": [
                            {"image": "https://media.example/qwen-pro-two.png"}
                        ]}}
                    ]}
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\nsecond"),
            ],
        );
        assert_eq!(pro.payloads.len(), 2);
        assert_eq!(pro_requests.len(), 3);
        assert_eq!(pro_requests[0].method, HttpMethod::Post);
        assert_eq!(
            pro_requests[0].url,
            "https://model.example/v1/services/aigc/multimodal-generation/generation"
        );
        assert_eq!(
            pro_requests[1].url,
            "https://media.example/qwen-pro-one.png"
        );
        assert_eq!(
            pro_requests[2].url,
            "https://media.example/qwen-pro-two.png"
        );
        assert!(!pro_requests[0].headers.contains_key("x-dashscope-async"));
        let HttpBody::Json(pro_body) = &pro_requests[0].body else {
            panic!("Qwen Image 2.0 Pro request must be JSON");
        };
        assert_eq!(
            pro_body.get("model"),
            Some(&json!("qwen-image-2.0-pro-2026-06-22"))
        );
        assert_eq!(
            pro_body.pointer("/input/messages/0/content"),
            Some(&json!([
                {"image": "data:image/png;base64,iVBORw0KGgo="},
                {"image": "data:image/jpeg;base64,/9j/"},
                {"text": "combine Image 1 and Image 2"}
            ]))
        );
        assert_eq!(pro_body.pointer("/parameters/n"), Some(&json!(2)));
        assert_eq!(
            pro_body.pointer("/parameters/future_parameter"),
            Some(&json!(7))
        );

        let (fast, fast_requests) = run_fixture(
            ModelKind::Image,
            "qwen-image-2.0-2026-03-03",
            &Map::from_iter([
                ("prompt".to_owned(), json!("fast concept frame")),
                ("watermark".to_owned(), json!(false)),
            ]),
            vec![
                fixture_json(&json!({
                    "output": {"choices": [{"message": {"content": [
                        {"image": "https://media.example/qwen-fast.png"}
                    ]}}]}
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(fast.payloads.len(), 1);
        assert_eq!(fast_requests[0].method, HttpMethod::Post);
        assert_eq!(
            fast_requests[0].url,
            "https://model.example/v1/services/aigc/multimodal-generation/generation"
        );
        let HttpBody::Json(fast_body) = &fast_requests[0].body else {
            panic!("Qwen Image 2.0 request must be JSON");
        };
        assert_eq!(
            fast_body.get("model"),
            Some(&json!("qwen-image-2.0-2026-03-03"))
        );
        assert_eq!(
            fast_body.pointer("/input/messages/0/content"),
            Some(&json!([{"text": "fast concept frame"}]))
        );
    }

    #[test]
    fn minimax_image_01_owns_both_formats_and_string_subject_references() {
        let (base64_execution, base64_requests) = run_fixture(
            ModelKind::Image,
            "image-01",
            &Map::from_iter([
                ("prompt".to_owned(), json!("character poster")),
                ("subject_reference".to_owned(), json!([])),
                ("response_format".to_owned(), json!("base64")),
            ]),
            vec![fixture_json(&json!({
                "base_resp": {"status_code": 0},
                "data": {"image_base64": ["iVBORw0KGgo="]}
            }))],
        );
        assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
        let HttpBody::Json(base64_body) = &base64_requests[0].body else {
            panic!("MiniMax request must be JSON");
        };
        assert_eq!(base64_body.get("subject_reference"), Some(&json!([])));

        let (url_execution, url_requests) = run_fixture(
            ModelKind::Image,
            "image-01",
            &Map::from_iter([
                ("prompt".to_owned(), json!("character poster")),
                (
                    "subject_reference".to_owned(),
                    json!(["data:image/png;base64,iVBORw0KGgo="]),
                ),
                ("response_format".to_owned(), json!("url")),
            ]),
            vec![
                fixture_json(&json!({
                    "base_resp": {"status_code": 0},
                    "data": {"image_urls": ["https://media.example/minimax"]}
                })),
                fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
            ],
        );
        assert_eq!(url_execution.payloads[0].mime_type, "image/jpeg");
        assert_eq!(url_requests.len(), 2);
        let HttpBody::Json(url_body) = &url_requests[0].body else {
            panic!("MiniMax request must be JSON");
        };
        assert_eq!(
            url_body.pointer("/subject_reference/0/type"),
            Some(&json!("character"))
        );
        assert_eq!(
            url_body.pointer("/subject_reference/0/image_file"),
            Some(&json!("data:image/png;base64,iVBORw0KGgo="))
        );
    }

    #[test]
    fn fal_flux_models_use_independent_exact_requests() {
        let (_, text_requests) = run_fixture(
            ModelKind::Image,
            "fal-ai/flux/dev",
            &Map::from_iter([
                ("prompt".to_owned(), json!("product")),
                ("future_parameter".to_owned(), json!(7)),
            ]),
            vec![
                fixture_json(&json!({
                    "images": [{"url": "https://media.example/flux-text"}]
                })),
                fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
            ],
        );
        assert!(text_requests[0].url.ends_with("/fal-ai/flux/dev"));
        let HttpBody::Json(text_body) = &text_requests[0].body else {
            panic!("Fal text request must be JSON");
        };
        assert_eq!(text_body.get("future_parameter"), Some(&json!(7)));

        let (_, edit_requests) = run_fixture(
            ModelKind::Image,
            "fal-ai/flux/dev/image-to-image",
            &Map::from_iter([
                ("prompt".to_owned(), json!("restyle")),
                (
                    "image_url".to_owned(),
                    json!("data:image/png;base64,iVBORw0KGgo="),
                ),
            ]),
            vec![
                fixture_json(&json!({
                    "images": [{"url": "https://media.example/flux-edit"}]
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert!(
            edit_requests[0]
                .url
                .ends_with("/fal-ai/flux/dev/image-to-image")
        );
        let HttpBody::Json(edit_body) = &edit_requests[0].body else {
            panic!("Fal edit request must be JSON");
        };
        assert_eq!(
            edit_body.get("image_url"),
            Some(&json!("data:image/png;base64,iVBORw0KGgo="))
        );

        let (_, provider_shape_requests) = run_fixture(
            ModelKind::Image,
            "fal-ai/flux/dev/image-to-image",
            &Map::from_iter([(
                "image_url".to_owned(),
                json!({"future_provider_reference": true}),
            )]),
            vec![
                fixture_json(&json!({
                    "images": [{"url": "https://media.example/flux-provider-shape"}]
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        let HttpBody::Json(provider_shape_body) = &provider_shape_requests[0].body else {
            panic!("Fal provider-shape request must be JSON");
        };
        assert_eq!(
            provider_shape_body.get("image_url"),
            Some(&json!({"future_provider_reference": true}))
        );
    }

    #[test]
    fn seedance_standard_and_fast_own_independent_exact_contracts() {
        let (standard, standard_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-260128",
            &Map::from_iter([
                ("prompt".to_owned(), json!("slow pan")),
                ("intent".to_owned(), json!("generate")),
                (
                    "references".to_owned(),
                    json!([{
                        "source": "data:image/png;base64,iVBORw0KGgo=",
                        "media_type": "image"
                    }]),
                ),
                ("watermark".to_owned(), json!(false)),
            ]),
            vec![
                fixture_json(&json!({"id": "standard-task"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {"video_url": "https://media.example/standard.mp4"}
                })),
                fixture_media("video/mp4", b"standard-video"),
            ],
        );
        assert_eq!(standard.payloads.len(), 1);
        let HttpBody::Json(standard_body) = &standard_requests[0].body else {
            panic!("Seedance standard request must be JSON");
        };
        assert_eq!(
            standard_body.get("model"),
            Some(&json!("doubao-seedance-2-0-260128"))
        );
        assert_eq!(standard_body.get("watermark"), Some(&json!(false)));
        assert_eq!(
            standard_body.pointer("/content/1/role"),
            Some(&json!("first_frame"))
        );

        let (fast, fast_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-fast-260128",
            &Map::from_iter([
                ("prompt".to_owned(), json!("move to the beat")),
                ("intent".to_owned(), json!("audio_driven")),
                (
                    "references".to_owned(),
                    json!([{
                        "source": "data:audio/mpeg;base64,AQID",
                        "media_type": "audio"
                    }]),
                ),
                ("watermark".to_owned(), json!(false)),
                ("return_last_frame".to_owned(), json!(true)),
            ]),
            vec![
                fixture_json(&json!({"id": "fast-task"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {
                        "video_url": "https://media.example/fast.mp4",
                        "last_frame_url": "https://media.example/last.png"
                    }
                })),
                fixture_media("video/mp4", b"fast-video"),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(fast.payloads.len(), 2);
        assert!(fast.payloads[1].mime_type.starts_with("image/"));
        let HttpBody::Json(fast_body) = &fast_requests[0].body else {
            panic!("Seedance Fast request must be JSON");
        };
        assert_eq!(
            fast_body.get("model"),
            Some(&json!("doubao-seedance-2-0-fast-260128"))
        );
        assert_eq!(
            fast_body.pointer("/content/1/role"),
            Some(&json!("driver_audio"))
        );
        assert!(fast_body.get("intent").is_none());
        assert!(fast_body.get("references").is_none());
    }

    #[test]
    fn minimax_h3_uses_the_native_v2_contract_and_one_video_artifact() {
        let (execution, requests) = run_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::from_iter([
                (
                    "content".to_owned(),
                    json!([{
                        "type": "text",
                        "text": "A quiet coastal basketball scene",
                        "future_child": true
                    }]),
                ),
                ("resolution".to_owned(), json!("2K")),
                ("duration".to_owned(), json!(5)),
                ("ratio".to_owned(), json!("16:9")),
                (
                    "callback_url".to_owned(),
                    json!("https://callback.example/h3"),
                ),
                ("aigc_watermark".to_owned(), json!(true)),
            ]),
            vec![
                fixture_json(&json!({"task_id": "h3/task?segment"})),
                fixture_json(&json!({
                    "request_id": "h3-query-request",
                    "task": {
                        "id": "h3/task?segment",
                        "status": "succeeded",
                        "content": {"url": "https://media.example/h3.mp4"}
                    }
                })),
                fixture_media("video/mp4", b"h3-video"),
            ],
        );

        assert_eq!(execution.payloads.len(), 1);
        assert_eq!(execution.payloads[0].mime_type, "video/mp4");
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(
            requests[0].url,
            "https://model.example/v1/v2/video_generation"
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("MiniMax H3 create request must be JSON");
        };
        assert_eq!(body.get("model"), Some(&json!("MiniMax-H3")));
        assert_eq!(body.get("aigc_watermark"), Some(&json!(true)));
        assert_eq!(body.pointer("/content/0/future_child"), Some(&json!(true)));
        assert_eq!(
            requests[1].url,
            "https://model.example/v1/v2/query/video_generation/h3%2Ftask%3Fsegment"
        );
        assert_eq!(requests[2].url, "https://media.example/h3.mp4");
    }

    #[test]
    fn minimax_h3_transforms_local_media_and_preserves_native_references() {
        let invocation_cwd = std::env::temp_dir().join(format!(
            "debrute-minimax-h3-project-media-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&invocation_cwd).unwrap();
        std::fs::write(
            invocation_cwd.join("reference.png"),
            b"\x89PNG\r\n\x1a\nlocal-image",
        )
        .unwrap();

        let (execution, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
            ModelKind::Video,
            "minimax-h3",
            &Map::from_iter([(
                "content".to_owned(),
                json!([
                    {"type": "image_url", "image_url": {"url": "reference.png"}},
                    {"type": "video_url", "video_url": {"url": "https://media.example/input.mp4"}},
                    {"type": "audio_url", "audio_url": {"url": "data:audio/mpeg;base64,AQID"}},
                    {"type": "image_url", "image_url": {"url": "mm_file://official-reference"}}
                ]),
            )]),
            vec![
                fixture_json(&json!({"task_id": "h3-project-task"})),
                fixture_json(&json!({
                    "task": {
                        "status": "succeeded",
                        "content": {"url": "https://media.example/h3-project.mp4"}
                    }
                })),
                fixture_media("video/mp4", b"h3-project-video"),
            ],
            &invocation_cwd,
            ModelRequestResourceLimits::default(),
        );

        std::fs::remove_dir_all(&invocation_cwd).unwrap();
        assert!(execution.is_ok());
        assert_eq!(remaining, 0);
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("MiniMax H3 local media request must be JSON");
        };
        assert!(
            body.pointer("/content/0/image_url/url")
                .and_then(Value::as_str)
                .is_some_and(|value| value.starts_with("data:image/png;base64,"))
        );
        assert_eq!(
            body.pointer("/content/1/video_url/url"),
            Some(&json!("https://media.example/input.mp4"))
        );
        assert_eq!(
            body.pointer("/content/2/audio_url/url"),
            Some(&json!("data:audio/mpeg;base64,AQID"))
        );
        assert_eq!(
            body.pointer("/content/3/image_url/url"),
            Some(&json!("mm_file://official-reference"))
        );
    }

    #[test]
    fn minimax_h3_treats_every_other_media_string_as_a_local_path() {
        let invocation_cwd = std::env::temp_dir().join(format!(
            "debrute-minimax-h3-local-path-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&invocation_cwd).unwrap();

        let (execution, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
            ModelKind::Video,
            "minimax-h3",
            &Map::from_iter([(
                "content".to_owned(),
                json!([{
                    "type": "video_url",
                    "video_url": {"url": "provider-owned-reference"}
                }]),
            )]),
            Vec::new(),
            &invocation_cwd,
            ModelRequestResourceLimits::default(),
        );

        std::fs::remove_dir_all(&invocation_cwd).unwrap();
        assert_eq!(execution.unwrap_err().code(), "model_request_input_invalid");
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn minimax_h3_uses_an_explicit_china_base_url_without_changing_its_contract() {
        let model = ResolvedModelRequestModel {
            kind: ModelKind::Video,
            model_id: "minimax-h3".to_owned(),
            request_model_id: "MiniMax-H3".to_owned(),
            base_url: "https://api.minimaxi.com".to_owned(),
            api_key: "china-secret".to_owned(),
        };
        let transport = FixtureTransport {
            responses: Mutex::new(VecDeque::from([
                fixture_json(&json!({"task_id": "china-task"})),
                fixture_json(&json!({
                    "task": {
                        "status": "succeeded",
                        "content": {"url": "https://media.example/china-h3.mp4"}
                    }
                })),
                fixture_media("video/mp4", b"china-h3-video"),
            ])),
            requests: Mutex::new(Vec::new()),
        };
        let cancellation = ModelRequestCancellation::default();
        let arguments = Map::from_iter([
            ("content".to_owned(), Value::Null),
            ("resolution".to_owned(), json!(42)),
            ("duration".to_owned(), json!("provider-decides")),
            ("ratio".to_owned(), json!(["invalid-shape"])),
            ("callback_url".to_owned(), json!(false)),
            ("aigc_watermark".to_owned(), json!(true)),
        ]);
        let context = ExecutionContext::new(
            &model,
            &arguments,
            Path::new("."),
            &cancellation,
            &transport,
            ModelRequestDeadline::after(Duration::from_secs(5)).unwrap(),
        )
        .unwrap();

        let execution = execute_model(ModelKind::Video, context).unwrap();
        let requests = transport.requests.into_inner().unwrap();
        assert_eq!(execution.payloads.len(), 1);
        assert_eq!(
            requests[0].url,
            "https://api.minimaxi.com/v2/video_generation"
        );
        assert_eq!(
            requests[1].url,
            "https://api.minimaxi.com/v2/query/video_generation/china-task"
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("MiniMax H3 China request must be JSON");
        };
        assert_eq!(body.get("model"), Some(&json!("MiniMax-H3")));
        assert_eq!(body.get("content"), Some(&Value::Null));
        assert_eq!(body.get("resolution"), Some(&json!(42)));
        assert_eq!(body.get("duration"), Some(&json!("provider-decides")));
        assert_eq!(body.get("ratio"), Some(&json!(["invalid-shape"])));
        assert_eq!(body.get("callback_url"), Some(&json!(false)));
        assert_eq!(body.get("aigc_watermark"), Some(&json!(true)));
    }

    #[test]
    fn minimax_h3_preserves_remote_task_failure_details_and_rejects_unknown_states() {
        let (failed, failed_requests, failed_remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![
                fixture_json(&json!({"task_id": "failed-task"})),
                fixture_json(&json!({
                    "request_id": "request-42",
                    "task": {
                        "status": "failed",
                        "error": {"code": "1026", "message": "sensitive content"}
                    }
                })),
            ],
        );
        let failed = failed.unwrap_err();
        assert_eq!(failed.code(), "model_request_task_failed");
        assert!(failed.message().contains("1026"));
        assert!(failed.message().contains("sensitive content"));
        assert!(failed.message().contains("request-42"));
        assert_eq!(failed_requests.len(), 2);
        assert_eq!(failed_remaining, 0);

        for (poll, expected_code) in [
            (
                json!({"task": {"status": "cancelled"}}),
                "model_request_task_failed",
            ),
            (
                json!({"task": {"status": "future-state"}}),
                "model_response_invalid",
            ),
            (
                json!({"task": {"status": "succeeded"}}),
                "model_response_invalid",
            ),
            (json!({"task": {}}), "model_response_invalid"),
        ] {
            let (result, requests, remaining) = execute_fixture(
                ModelKind::Video,
                "minimax-h3",
                &Map::new(),
                vec![
                    fixture_json(&json!({"task_id": "terminal-task"})),
                    fixture_json(&poll),
                ],
            );
            assert_eq!(result.unwrap_err().code(), expected_code);
            assert_eq!(requests.len(), 2);
            assert_eq!(remaining, 0);
        }

        let (missing_id, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![fixture_json(&json!({}))],
        );
        assert_eq!(missing_id.unwrap_err().code(), "model_response_invalid");
        assert_eq!(requests.len(), 1);
        assert_eq!(remaining, 0);

        let (collision, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::from_iter([("model".to_owned(), json!("caller-model"))]),
            Vec::new(),
        );
        assert_eq!(
            collision.unwrap_err().code(),
            "model_request_argument_collision"
        );
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn minimax_h3_preserves_query_and_download_transport_failures() {
        let (query, query_requests, query_remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![
                fixture_json(&json!({"task_id": "query-error-task"})),
                fixture_remote_error(),
            ],
        );
        assert!(query.is_err());
        assert_eq!(query_requests.len(), 2);
        assert_eq!(query_remaining, 0);

        let (download, download_requests, download_remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![
                fixture_json(&json!({"task_id": "download-error-task"})),
                fixture_json(&json!({
                    "task": {
                        "status": "succeeded",
                        "content": {"url": "https://media.example/download-error.mp4"}
                    }
                })),
                fixture_remote_error(),
            ],
        );
        assert!(download.is_err());
        assert_eq!(download_requests.len(), 3);
        assert_eq!(download_remaining, 0);
    }

    #[test]
    fn exact_adapters_forward_provider_validation_inputs_instead_of_requiring_them_locally() {
        let (_, audio_requests) = run_fixture(
            ModelKind::Tts,
            "openai-tts-1",
            &Map::from_iter([
                ("voice".to_owned(), json!({"id": "provider-voice"})),
                ("future_audio_field".to_owned(), Value::Null),
            ]),
            vec![fixture_media("audio/mpeg", b"ID3")],
        );
        let HttpBody::Json(audio_body) = &audio_requests[0].body else {
            panic!("OpenAI TTS request must be JSON");
        };
        assert!(audio_body.get("input").is_none());
        assert_eq!(
            audio_body.get("voice"),
            Some(&json!({"id": "provider-voice"}))
        );
        assert_eq!(audio_body.get("future_audio_field"), Some(&Value::Null));

        let (_, image_requests) = run_fixture(
            ModelKind::Image,
            "qwen-image-2.0-2026-03-03",
            &Map::from_iter([("future_image_field".to_owned(), Value::Null)]),
            vec![
                fixture_json(&json!({
                    "output": {"choices": [{"message": {"content": [
                        {"image": "https://media.example/qwen-forwarding.png"}
                    ]}}]}
                })),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        let HttpBody::Json(image_body) = &image_requests[0].body else {
            panic!("Qwen image request must be JSON");
        };
        assert_eq!(
            image_body.pointer("/input/messages/0/content"),
            Some(&json!([]))
        );
        assert_eq!(
            image_body.pointer("/parameters/future_image_field"),
            Some(&Value::Null)
        );

        let (_, video_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-260128",
            &Map::from_iter([
                ("intent".to_owned(), json!("generate")),
                ("future_video_field".to_owned(), Value::Null),
            ]),
            vec![
                fixture_json(&json!({"id": "forwarding-task"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {"video_url": "https://media.example/forwarding.mp4"}
                })),
                fixture_media("video/mp4", b"forwarding-video"),
            ],
        );
        let HttpBody::Json(video_body) = &video_requests[0].body else {
            panic!("Seedance request must be JSON");
        };
        assert_eq!(video_body.get("content"), Some(&json!([])));
        assert_eq!(video_body.get("future_video_field"), Some(&Value::Null));
    }

    #[test]
    fn unrecognized_optional_media_shapes_remain_at_their_upstream_location() {
        let provider_shape = json!({"provider_owned": true});
        for model_id in [
            "doubao-seedream-5-0-lite-260128",
            "doubao-seedream-5-0-pro-260628",
        ] {
            let body = first_rejected_json_body(
                ModelKind::Image,
                model_id,
                &Map::from_iter([
                    ("response_format".to_owned(), json!("url")),
                    ("image".to_owned(), provider_shape.clone()),
                ]),
            );
            assert_eq!(body.get("image"), Some(&provider_shape), "{model_id}");
        }
        for model_id in [
            "qwen-image-2.0-pro-2026-06-22",
            "qwen-image-2.0-2026-03-03",
            "wan2.7-image",
        ] {
            let body = first_rejected_json_body(
                ModelKind::Image,
                model_id,
                &Map::from_iter([("image".to_owned(), provider_shape.clone())]),
            );
            assert_eq!(
                body.pointer("/parameters/image"),
                Some(&provider_shape),
                "{model_id}"
            );
        }
        for model_id in ["gemini-3.1-flash-image", "gemini-3-pro-image"] {
            let body = first_rejected_json_body(
                ModelKind::Image,
                model_id,
                &Map::from_iter([
                    ("delivery".to_owned(), json!("inline")),
                    ("image".to_owned(), provider_shape.clone()),
                ]),
            );
            assert_eq!(body.get("image"), Some(&provider_shape), "{model_id}");
        }
        let minimax = first_rejected_json_body(
            ModelKind::Image,
            "image-01",
            &Map::from_iter([
                ("response_format".to_owned(), json!("url")),
                ("subject_reference".to_owned(), provider_shape.clone()),
            ]),
        );
        assert_eq!(minimax.get("subject_reference"), Some(&provider_shape));
        for model_id in ["google-lyria-3-clip-preview", "google-lyria-3-pro-preview"] {
            let body = first_rejected_json_body(
                ModelKind::Music,
                model_id,
                &Map::from_iter([("image".to_owned(), provider_shape.clone())]),
            );
            assert_eq!(body.get("image"), Some(&provider_shape), "{model_id}");
        }
    }

    fn first_rejected_json_body(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
    ) -> Value {
        let (_, requests, _) =
            execute_fixture(kind, model_id, arguments, vec![fixture_remote_error()]);
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("{model_id} request must be JSON");
        };
        Value::clone(body)
    }

    #[test]
    fn cancellable_exact_models_keep_local_cancellation_authoritative_and_try_remote_cleanup() {
        let ignored_cleanup_response = ModelHttpResponse {
            status: 503,
            headers: std::collections::BTreeMap::new(),
            body: b"remote cleanup failed".to_vec(),
        };

        let (h3, h3_requests, h3_remaining) = execute_cancelling_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::from_iter([("content".to_owned(), json!([]))]),
            vec![
                fixture_json(&json!({"task_id": "h3-cancel-task"})),
                ignored_cleanup_response.clone(),
            ],
            2,
        );
        assert_eq!(h3.unwrap_err().code(), "model_request_cancelled");
        assert_eq!(h3_remaining, 0);
        assert_eq!(
            h3_requests
                .iter()
                .map(|request| request.method)
                .collect::<Vec<_>>(),
            vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Delete]
        );
        assert!(
            h3_requests[2]
                .url
                .ends_with("/v2/video_generation/h3-cancel-task")
        );

        for model_id in [
            "doubao-seedance-2-0-260128",
            "doubao-seedance-2-0-fast-260128",
            "doubao-seedance-2-0-mini-260615",
        ] {
            let (result, requests, remaining) = execute_cancelling_fixture(
                ModelKind::Video,
                model_id,
                &Map::from_iter([("intent".to_owned(), json!("generate"))]),
                vec![
                    fixture_json(&json!({"id": "seedance-cancel-task"})),
                    ignored_cleanup_response.clone(),
                ],
                2,
            );
            assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
            assert_eq!(remaining, 0);
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.method)
                    .collect::<Vec<_>>(),
                vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Delete],
                "{model_id} must preserve local cancellation while attempting DELETE"
            );
            assert!(
                requests[2]
                    .url
                    .ends_with("/contents/generations/tasks/seedance-cancel-task")
            );
        }

        for (kind, model_id) in [
            (ModelKind::Music, "fal-stable-audio-text-to-audio"),
            (ModelKind::SoundEffect, "fal-stable-audio-3-small-sfx"),
        ] {
            let (result, requests, remaining) = execute_cancelling_fixture(
                kind,
                model_id,
                &Map::new(),
                vec![
                    fixture_json(&json!({
                        "request_id": "fal-cancel-task",
                        "status_url": "https://model.example/v1/status/fal-cancel-task",
                        "cancel_url": "https://model.example/v1/cancel/fal-cancel-task"
                    })),
                    ignored_cleanup_response.clone(),
                ],
                2,
            );
            assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
            assert_eq!(remaining, 0);
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.method)
                    .collect::<Vec<_>>(),
                vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Put],
                "{model_id} must preserve local cancellation while attempting PUT"
            );
            assert_eq!(
                requests[2].url,
                "https://model.example/v1/cancel/fal-cancel-task"
            );
        }
    }

    #[test]
    fn remote_cleanup_outcomes_never_override_local_cancellation() {
        for (name, outcome) in [
            (
                "success",
                RemoteCleanupFixtureOutcome::Response(ModelHttpResponse {
                    status: 204,
                    headers: std::collections::BTreeMap::new(),
                    body: Vec::new(),
                }),
            ),
            (
                "client error",
                RemoteCleanupFixtureOutcome::Response(ModelHttpResponse {
                    status: 400,
                    headers: std::collections::BTreeMap::new(),
                    body: b"not-json".to_vec(),
                }),
            ),
            (
                "server error",
                RemoteCleanupFixtureOutcome::Response(ModelHttpResponse {
                    status: 503,
                    headers: std::collections::BTreeMap::new(),
                    body: b"not-json".to_vec(),
                }),
            ),
            (
                "network failure",
                RemoteCleanupFixtureOutcome::NetworkFailure,
            ),
        ] {
            let (result, requests, elapsed) = execute_remote_cleanup_outcome_fixture(outcome);
            assert_eq!(
                result.unwrap_err().code(),
                "model_request_cancelled",
                "{name}"
            );
            assert_eq!(
                requests
                    .iter()
                    .map(|request| request.method)
                    .collect::<Vec<_>>(),
                vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Delete],
                "{name}"
            );
            assert!(
                elapsed < Duration::from_secs(1),
                "{name} unexpectedly delayed local cancellation"
            );
        }
    }

    #[test]
    fn remote_cleanup_uses_an_independent_fixed_five_second_deadline() {
        let (result, requests, elapsed) =
            execute_remote_cleanup_outcome_fixture(RemoteCleanupFixtureOutcome::AwaitDeadline);
        assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
        assert_eq!(
            requests
                .iter()
                .map(|request| request.method)
                .collect::<Vec<_>>(),
            vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Delete]
        );
        assert!(
            elapsed >= Duration::from_millis(4_900),
            "cleanup deadline elapsed too early: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(6),
            "cleanup deadline exceeded its fixed bound: {elapsed:?}"
        );
    }

    #[test]
    fn batch_cancellation_stops_new_items_and_cleans_each_active_remote_task_once() {
        let (root, transport, operations) = batch_remote_cancellation_fixture();
        let request = ModelRequest {
            model: "minimax-h3".to_owned(),
            arguments: Map::new(),
            output: ModelOutput {
                directory: root.join("project").to_string_lossy().into_owned(),
                name: "artifact".to_owned(),
            },
        };
        let accepted = operations
            .submit(SubmitModelOperation {
                invocation_cwd: root.join("project"),
                shape: ExecutionShape::Batch,
                requests: vec![request.clone(), request.clone(), request],
                concurrency: Some(2),
                timeout_seconds: Some(60),
                replace: false,
            })
            .unwrap();

        transport.wait_for_polls(2);
        assert_eq!(
            operations.cancel(&accepted.id).unwrap().state,
            OperationState::Cancelling
        );
        let terminal = operations
            .wait(&accepted.id, || true, |_| true, |_| true)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.state, OperationState::Cancelled);

        let requests = transport.requests.lock().expect("fixture requests");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == HttpMethod::Post)
                .count(),
            2,
            "the third Batch Item must never be submitted"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == HttpMethod::Get)
                .count(),
            2
        );
        let mut cleanup_urls = requests
            .iter()
            .filter(|request| request.method == HttpMethod::Delete)
            .map(|request| request.url.clone())
            .collect::<Vec<_>>();
        cleanup_urls.sort();
        assert_eq!(cleanup_urls.len(), 2);
        cleanup_urls.dedup();
        assert_eq!(
            cleanup_urls.len(),
            2,
            "each active remote task must receive at most one cleanup attempt"
        );
        drop(requests);

        operations.shutdown();
        drop(operations);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_cancellation_is_not_guessed_without_a_trusted_handle() {
        let (h3, h3_requests, h3_remaining) = execute_cancelling_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![fixture_json(&json!({"task_id": "unseen-task"}))],
            1,
        );
        assert_eq!(h3.unwrap_err().code(), "model_request_cancelled");
        assert_eq!(h3_requests.len(), 1);
        assert_eq!(h3_requests[0].method, HttpMethod::Post);
        assert_eq!(h3_remaining, 1);

        let (fal, fal_requests, fal_remaining) = execute_cancelling_fixture(
            ModelKind::Music,
            "fal-stable-audio-text-to-audio",
            &Map::new(),
            vec![fixture_json(&json!({
                "request_id": "fal-untrusted-cancel",
                "status_url": "https://model.example/v1/status/fal-untrusted-cancel",
                "cancel_url": "https://untrusted.example/cancel/fal-untrusted-cancel"
            }))],
            2,
        );
        assert_eq!(fal.unwrap_err().code(), "model_request_cancelled");
        assert_eq!(
            fal_requests
                .iter()
                .map(|request| request.method)
                .collect::<Vec<_>>(),
            vec![HttpMethod::Post, HttpMethod::Get]
        );
        assert_eq!(fal_remaining, 0);
    }

    #[test]
    fn remote_cancellation_respects_the_last_observed_provider_state() {
        for model_id in [
            "minimax-h3",
            "doubao-seedance-2-0-260128",
            "doubao-seedance-2-0-fast-260128",
            "doubao-seedance-2-0-mini-260615",
        ] {
            let arguments = if model_id == "minimax-h3" {
                Map::new()
            } else {
                Map::from_iter([("intent".to_owned(), json!("generate"))])
            };
            let create = if model_id == "minimax-h3" {
                json!({"task_id": "state-task"})
            } else {
                json!({"id": "state-task"})
            };
            for (status, should_delete) in [("queued", true), ("running", false)] {
                let poll = if model_id == "minimax-h3" {
                    json!({"task": {"status": status}})
                } else {
                    json!({"status": status})
                };
                let (result, requests, remaining) = execute_cancelling_after_response_fixture(
                    ModelKind::Video,
                    model_id,
                    &arguments,
                    vec![fixture_json(&create), fixture_json(&poll)],
                    2,
                );
                assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
                assert_eq!(remaining, 0);
                assert_eq!(
                    requests
                        .iter()
                        .filter(|request| request.method == HttpMethod::Delete)
                        .count(),
                    usize::from(should_delete),
                    "{model_id} must use DELETE only before running is observed"
                );
            }
        }

        for (kind, model_id) in [
            (ModelKind::Music, "fal-stable-audio-text-to-audio"),
            (ModelKind::SoundEffect, "fal-stable-audio-3-small-sfx"),
        ] {
            for status in ["IN_QUEUE", "IN_PROGRESS"] {
                let (result, requests, remaining) = execute_cancelling_after_response_fixture(
                    kind,
                    model_id,
                    &Map::new(),
                    vec![
                        fixture_json(&json!({
                            "request_id": "fal-state-task",
                            "status_url": "https://model.example/v1/status/fal-state-task",
                            "cancel_url": "https://model.example/v1/cancel/fal-state-task"
                        })),
                        fixture_json(&json!({"status": status})),
                    ],
                    2,
                );
                assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
                assert_eq!(remaining, 0);
                assert_eq!(
                    requests
                        .iter()
                        .map(|request| request.method)
                        .collect::<Vec<_>>(),
                    vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Put],
                    "{model_id} must signal cancellation from {status}"
                );
            }
        }
    }

    #[test]
    fn seedance_adapters_require_the_materialized_intent() {
        for model_id in [
            "doubao-seedance-2-0-260128",
            "doubao-seedance-2-0-fast-260128",
            "doubao-seedance-2-0-mini-260615",
        ] {
            let (result, requests, remaining) = execute_fixture(
                ModelKind::Video,
                model_id,
                &Map::from_iter([("prompt".to_owned(), json!("slow pan"))]),
                Vec::new(),
            );

            assert_eq!(result.unwrap_err().code(), "model_request_argument_invalid");
            assert!(requests.is_empty(), "{model_id} submitted without intent");
            assert_eq!(remaining, 0);
        }
    }

    #[test]
    fn seedance_polling_rejects_incomplete_or_unknown_remote_states() {
        for model_id in [
            "doubao-seedance-2-0-260128",
            "doubao-seedance-2-0-fast-260128",
            "doubao-seedance-2-0-mini-260615",
        ] {
            for (poll, expected_code) in [
                (
                    json!({
                        "status": "failed",
                        "error": {"code": "OutputVideoSensitiveContentDetected"}
                    }),
                    "model_response_invalid",
                ),
                (json!({"status": "unexpected"}), "model_response_invalid"),
                (json!({}), "model_response_invalid"),
                (json!({"status": "cancelled"}), "model_request_task_failed"),
            ] {
                let (result, requests, remaining) = execute_fixture(
                    ModelKind::Video,
                    model_id,
                    &Map::from_iter([
                        ("prompt".to_owned(), json!("slow pan")),
                        ("intent".to_owned(), json!("generate")),
                    ]),
                    vec![
                        fixture_json(&json!({"id": "poll-contract-task"})),
                        fixture_json(&poll),
                    ],
                );

                assert_eq!(result.unwrap_err().code(), expected_code);
                assert_eq!(requests.len(), 2);
                assert_eq!(remaining, 0);
            }
        }
    }

    #[test]
    fn seedance_mini_owns_current_roles_passthrough_and_optional_last_frame() {
        let (generate, generate_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-mini-260615",
            &Map::from_iter([
                ("prompt".to_owned(), json!("animate both keyframes")),
                ("intent".to_owned(), json!("generate")),
                (
                    "references".to_owned(),
                    json!([
                        {
                            "source": "data:image/png;base64,iVBORw0KGgo=",
                            "media_type": "image"
                        },
                        {
                            "source": "data:image/jpeg;base64,/9j/",
                            "media_type": "image"
                        }
                    ]),
                ),
                ("tools".to_owned(), json!([{"type": "web_search"}])),
                ("return_last_frame".to_owned(), json!(true)),
                ("resolution".to_owned(), json!("720p")),
                ("watermark".to_owned(), json!(false)),
                ("future_parameter".to_owned(), json!("remote owns this")),
            ]),
            vec![
                fixture_json(&json!({"id": "mini-generate-task"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {
                        "video_url": "https://media.example/mini.mp4",
                        "last_frame_url": "https://media.example/mini-last.png"
                    }
                })),
                fixture_media("video/mp4", b"mini-video"),
                fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            ],
        );
        assert_eq!(generate.payloads.len(), 2);
        assert_eq!(generate_requests[0].method, HttpMethod::Post);
        assert_eq!(
            generate_requests[0].url,
            "https://model.example/v1/contents/generations/tasks"
        );
        assert_eq!(generate_requests[1].method, HttpMethod::Get);
        assert_eq!(
            generate_requests[1].url,
            "https://model.example/v1/contents/generations/tasks/mini-generate-task"
        );
        assert_eq!(generate.payloads[0].mime_type, "video/mp4");
        assert!(generate.payloads[1].mime_type.starts_with("image/"));
        let HttpBody::Json(generate_body) = &generate_requests[0].body else {
            panic!("Seedance Mini request must be JSON");
        };
        assert_eq!(
            generate_body.get("model"),
            Some(&json!("doubao-seedance-2-0-mini-260615"))
        );
        assert_eq!(
            generate_body.pointer("/content/1/role"),
            Some(&json!("first_frame"))
        );
        assert_eq!(
            generate_body.pointer("/content/2/role"),
            Some(&json!("last_frame"))
        );
        assert_eq!(
            generate_body.get("tools"),
            Some(&json!([{"type": "web_search"}]))
        );
        assert_eq!(
            generate_body.get("future_parameter"),
            Some(&json!("remote owns this"))
        );
        assert!(generate_body.get("intent").is_none());
        assert!(generate_body.get("references").is_none());
    }

    #[test]
    fn seedance_mini_accepts_inline_audio_and_model_reachable_video() {
        let (_, audio_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-mini-260615",
            &Map::from_iter([
                ("prompt".to_owned(), json!("follow the supplied narration")),
                ("intent".to_owned(), json!("audio_driven")),
                (
                    "references".to_owned(),
                    json!([
                        {
                            "source": "data:audio/mpeg;base64,AQID",
                            "media_type": "audio"
                        },
                        {
                            "source": "asset://source-video",
                            "media_type": "video"
                        }
                    ]),
                ),
            ]),
            vec![
                fixture_json(&json!({"id": "mini-audio-task"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {"video_url": "https://media.example/audio-driven.mp4"}
                })),
                fixture_media("video/mp4", b"audio-driven-video"),
            ],
        );
        let HttpBody::Json(audio_body) = &audio_requests[0].body else {
            panic!("Seedance Mini audio-driven request must be JSON");
        };
        assert_eq!(
            audio_body.pointer("/content/1/role"),
            Some(&json!("reference_audio"))
        );
        assert_eq!(
            audio_body.pointer("/content/2/role"),
            Some(&json!("reference_video"))
        );
    }

    #[test]
    fn seedance_mini_submits_web_search_with_references_and_preserves_remote_failure() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("")),
            ("intent".to_owned(), json!("generate")),
            (
                "references".to_owned(),
                json!([{
                    "source": "",
                    "media_type": "audio"
                }]),
            ),
            ("tools".to_owned(), json!([{"type": "web_search"}])),
        ]);
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-mini-260615",
            &arguments,
            vec![
                fixture_json(&json!({"id": "mini-rejected-task"})),
                fixture_json(&json!({
                    "status": "failed",
                    "error": {
                        "code": "InvalidParameter",
                        "message": "web_search requires a pure-text request"
                    }
                })),
            ],
        );

        assert_eq!(remaining, 0);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(
            requests[0].url,
            "https://model.example/v1/contents/generations/tasks"
        );
        assert_eq!(requests[1].method, HttpMethod::Get);
        assert_eq!(
            requests[1].url,
            "https://model.example/v1/contents/generations/tasks/mini-rejected-task"
        );
        let HttpBody::Json(body) = &requests[0].body else {
            panic!("Seedance Mini rejected request must be JSON");
        };
        assert_eq!(body.get("tools"), Some(&json!([{"type": "web_search"}])));
        assert_eq!(body.pointer("/content/0/text"), Some(&json!("")));
        assert_eq!(body.pointer("/content/1/audio_url/url"), Some(&json!("")));
        assert_eq!(
            body.pointer("/content/1/role"),
            Some(&json!("reference_audio"))
        );
        let error = result.expect_err("remote Mini rejection must remain an error");
        assert_eq!(error.code(), "model_request_task_failed");
        assert!(error.message().contains("InvalidParameter"));
        assert!(
            error
                .message()
                .contains("web_search requires a pure-text request")
        );
    }

    #[test]
    fn seedance_mini_rejects_unreachable_local_video_and_unknown_reference_children() {
        for (arguments, expected_code) in [
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("extend this clip")),
                    ("intent".to_owned(), json!("extend")),
                    (
                        "references".to_owned(),
                        json!([{"source": "local/source.mp4", "media_type": "video"}]),
                    ),
                ]),
                "video_reference_upload_unavailable",
            ),
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("animate this image")),
                    ("intent".to_owned(), json!("generate")),
                    (
                        "references".to_owned(),
                        json!([{
                            "source": "data:image/png;base64,iVBORw0KGgo=",
                            "media_type": "image",
                            "label": "unsupported child"
                        }]),
                    ),
                ]),
                "model_request_argument_invalid",
            ),
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("animate")),
                    ("intent".to_owned(), json!("unknown-intent")),
                ]),
                "model_request_argument_invalid",
            ),
        ] {
            let (result, requests, remaining) = execute_fixture(
                ModelKind::Video,
                "doubao-seedance-2-0-mini-260615",
                &arguments,
                Vec::new(),
            );
            assert_eq!(result.unwrap_err().code(), expected_code);
            assert!(requests.is_empty());
            assert_eq!(remaining, 0);
        }
    }

    #[test]
    fn video_data_references_must_match_their_declared_media_type() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("animate")),
            ("intent".to_owned(), json!("generate")),
            (
                "references".to_owned(),
                json!([{
                    "source": "data:audio/mpeg;base64,AQID",
                    "media_type": "image"
                }]),
            ),
        ]);
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-260128",
            &arguments,
            Vec::new(),
        );
        assert_eq!(result.unwrap_err().code(), "model_request_argument_invalid");
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn terminal_errors_are_redacted_with_the_model_secret() {
        let error = ModelRequestError::new(
            "model_request_failed",
            "request to https://example.test/out?token=live-secret failed with live-secret",
        );
        let redacted = redact_model_request_error(&error, &["live-secret".to_owned()]);
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("live-secret"));
    }
}
