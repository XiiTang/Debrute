use std::{path::Path, sync::Arc, time::Duration};

use crate::{
    global::{GlobalConfigSnapshot, GlobalConfigStore},
    model_operation::{
        ArtifactPointer, ModelCancellation, ModelKind, ModelOperationCommitWarnings,
        ModelOperationExecutor, ModelRequest, ModelRequestExecutionError,
    },
    models::ModelCatalog,
};

use super::{
    common::{
        ExecutionContext, ModelExecutor, StagedModelExecution, commit_staged_execution,
        execute_model, materialize_argument_defaults, stage_execution,
    },
    http::NativeModelHttpTransport,
    provenance::ModelArtifactProvenanceStore,
    types::{
        ModelExecution, ModelHttpTransport, ModelRequestCancellation, ModelRequestDeadline,
        ModelRequestError, ResolvedModelRequestModel,
    },
};

/// Runtime-owned exact Model execution and output commit authority.
pub struct ModelRequestExecutor {
    catalog: Arc<ModelCatalog>,
    global_config: Arc<GlobalConfigStore>,
    provenance: Arc<ModelArtifactProvenanceStore>,
    transport: Arc<dyn ModelHttpTransport>,
}

pub struct AcceptedModelBinding {
    model: ResolvedModelRequestModel,
    schema: serde_json::Value,
    executor: ModelExecutor,
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
    type Prepared = ModelExecution;
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
        resolve_model(&self.catalog, snapshot, model_id).map_err(|error| {
            ModelRequestExecutionError::validation("model_unavailable", error.message())
        })
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
        let execution = execute_model(binding.executor, context)
            .map_err(|error| {
                redact_model_request_error(&error, std::slice::from_ref(&binding.model.api_key))
            })
            .map_err(|error| model_request_execution_error(&error))?;
        cancellation
            .check()
            .map_err(|error| model_request_execution_error(&error))?;
        Ok(execution)
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
            prepared,
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

fn resolve_model(
    catalog: &ModelCatalog,
    snapshot: &GlobalConfigSnapshot,
    model_id: &str,
) -> Result<(ModelKind, AcceptedModelBinding), ModelRequestError> {
    let definition = catalog.find(model_id).ok_or_else(|| {
        ModelRequestError::new(
            "model_unavailable",
            format!("Model is unavailable: {model_id}"),
        )
    })?;
    let configuration = snapshot
        .settings
        .models
        .iter()
        .find(|configuration| configuration.debrute_model_id == model_id);
    let base_url = configuration
        .and_then(|configuration| configuration.base_url_override.clone())
        .unwrap_or_else(|| definition.default_base_url().to_owned());
    let request_model_id = configuration
        .and_then(|configuration| configuration.request_model_id_override.clone())
        .unwrap_or_else(|| definition.default_request_model_id().to_owned());
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
        definition.kind(),
        AcceptedModelBinding {
            model: ResolvedModelRequestModel {
                model_id: model_id.to_owned(),
                request_model_id,
                base_url,
                api_key,
            },
            schema: definition.arguments_schema().clone(),
            executor: definition.executor(),
        },
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
        path::PathBuf,
        sync::{Arc, Condvar, Mutex},
        time::Duration,
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
            types::{ModelHttpRequest, ModelHttpResponse, PreparedHttpBody as HttpBody},
        },
        models::testing::{
            FIXTURE_MODEL_ID, fixture_json, fixture_model_catalog, fixture_model_executor_fn,
        },
    };

    struct BlockingFixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
        first_started: (Mutex<bool>, Condvar),
        release_first: (Mutex<bool>, Condvar),
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
            let catalog = Arc::new(fixture_model_catalog());
            let global_config = Arc::new(GlobalConfigStore::new(root.join("home")));
            let transport = Arc::new(BlockingFixtureTransport {
                responses: Mutex::new(VecDeque::from([
                    fixture_json(&json!({"accepted": 1})),
                    fixture_json(&json!({"accepted": 2})),
                    fixture_json(&json!({"accepted": 3})),
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
                    model: FIXTURE_MODEL_ID.to_owned(),
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
                .mutate(
                    &serde_json::from_value(json!({
                        "operation": "save-model-setting",
                        "modelId": FIXTURE_MODEL_ID,
                        "setting": {
                            "baseUrlOverride": format!("https://{host}/v1"),
                            "requestModelIdOverride": request_model_id,
                            "apiKey": api_key
                        }
                    }))
                    .expect("fixture should contain a valid Global Settings intent"),
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
            assert_eq!(request.url, format!("https://{host}/v1/execute"));
            assert_eq!(
                request.headers.get("authorization").map(String::as_str),
                Some(api_key)
            );
            let HttpBody::Json(body) = &request.body else {
                panic!("expected JSON model request");
            };
            assert_eq!(
                body.get("fixture_request_model_id"),
                Some(&json!(request_model_id))
            );
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

    #[test]
    fn configured_model_api_key_is_used_as_an_opaque_secret() {
        let catalog = ModelCatalog::bundled();
        let model_id = catalog.all().first().expect("bundled Model").id();
        let mut snapshot = GlobalConfigSnapshot::default();
        let exact_api_key = "  密钥🔑 \n";
        snapshot
            .secrets
            .model_api_keys
            .insert(model_id.to_owned(), exact_api_key.to_owned());

        let (_, binding) =
            resolve_model(&catalog, &snapshot, model_id).expect("configured Model should resolve");

        assert_eq!(binding.model.api_key, exact_api_key);
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
                "accepted-secret",
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
            "later-secret",
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
            executor: fixture_model_executor_fn(),
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
    fn default_model_request_resource_limits_are_128_and_256_mib() {
        let limits = ModelRequestResourceLimits::default();

        assert_eq!(limits.input_media_item_bytes, 128 * 1024 * 1024);
        assert_eq!(limits.model_request_bytes, 256 * 1024 * 1024);
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
