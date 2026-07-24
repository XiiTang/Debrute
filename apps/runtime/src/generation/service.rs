use std::{path::Path, sync::Arc, time::Duration};

use crate::{
    global::{AudioModelKind, GlobalConfigSnapshot, GlobalConfigStore, ModelCatalog},
    model_operation::{
        ArtifactPointer, ModelCancellation, ModelKind, ModelOperationExecutor, ModelRequest,
        ModelRunError,
    },
    project::GeneratedAssetMetadataService,
};

use super::{
    audio,
    common::{
        ExecutionContext, StagedModelExecution, commit_staged_execution,
        materialize_argument_defaults, stage_execution, validate_arguments,
    },
    http::NativeModelHttpTransport,
    image,
    types::{
        GenerationCancellation, GenerationDeadline, GenerationError, ModelExecution,
        ModelHttpTransport, ResolvedGenerationModel,
    },
    video,
};

/// Runtime-owned Model Adapter execution and output commit authority.
pub struct GenerationService {
    catalog: Arc<ModelCatalog>,
    global_config: Arc<GlobalConfigStore>,
    metadata: Arc<GeneratedAssetMetadataService>,
    transport: Arc<dyn ModelHttpTransport>,
}

pub struct PreparedModelExecution {
    execution: ModelExecution,
}

pub struct AcceptedModelBinding {
    model: ResolvedGenerationModel,
    schema: serde_json::Value,
}

impl GenerationService {
    #[must_use]
    pub fn new(
        catalog: Arc<ModelCatalog>,
        global_config: Arc<GlobalConfigStore>,
        metadata: Arc<GeneratedAssetMetadataService>,
    ) -> Self {
        Self {
            catalog,
            global_config,
            metadata,
            transport: Arc::new(NativeModelHttpTransport),
        }
    }
}

impl ModelOperationExecutor for GenerationService {
    type ConfigSnapshot = GlobalConfigSnapshot;
    type ModelBinding = AcceptedModelBinding;
    type Prepared = PreparedModelExecution;
    type Staged = StagedModelExecution;

    fn read_config_snapshot(&self) -> Result<Self::ConfigSnapshot, ModelRunError> {
        self.global_config
            .read_snapshot(&self.catalog)
            .map_err(|error| {
                ModelRunError::validation(
                    "internal_error",
                    format!("Global settings are unavailable: {error}"),
                )
            })
    }

    fn bind_model(
        &self,
        snapshot: &Self::ConfigSnapshot,
        model_id: &str,
    ) -> Result<(ModelKind, Self::ModelBinding), ModelRunError> {
        let (model, schema) = resolve_model(&self.catalog, snapshot, model_id)
            .map_err(|error| ModelRunError::validation("model_unavailable", error.message()))?;
        Ok((model.kind, AcceptedModelBinding { model, schema }))
    }

    fn validate_request(
        &self,
        binding: &Self::ModelBinding,
        request: &mut ModelRequest,
    ) -> Result<(), ModelRunError> {
        materialize_argument_defaults(
            &binding.model.model_id,
            &binding.schema,
            &mut request.arguments,
        )
        .map_err(|error| ModelRunError::validation("invalid_input", error.message()))?;
        validate_arguments(&binding.model.model_id, &binding.schema, &request.arguments)
            .map_err(|error| ModelRunError::validation("invalid_input", error.message()))?;
        Ok(())
    }

    fn run(
        &self,
        binding: &Self::ModelBinding,
        project_root: &Path,
        request: &ModelRequest,
        timeout: Duration,
        cancellation: &ModelCancellation,
    ) -> Result<Self::Prepared, ModelRunError> {
        let cancellation = GenerationCancellation::from_model(cancellation);
        cancellation
            .check()
            .map_err(|error| generation_run_error(&error))?;
        let deadline =
            GenerationDeadline::after(timeout).map_err(|error| generation_run_error(&error))?;
        let context = ExecutionContext::new(
            &binding.model,
            &request.arguments,
            project_root,
            &cancellation,
            self.transport.as_ref(),
            deadline,
        )
        .map_err(|error| generation_run_error(&error))?;
        let execution = execute_model(binding.model.kind, context)
            .map_err(|error| {
                redact_generation_error(&error, std::slice::from_ref(&binding.model.api_key))
            })
            .map_err(|error| generation_run_error(&error))?;
        cancellation
            .check()
            .map_err(|error| generation_run_error(&error))?;
        Ok(PreparedModelExecution { execution })
    }

    fn stage(
        &self,
        binding: &Self::ModelBinding,
        project_capability: &crate::project::ProjectCapabilityFs,
        operation_id: &str,
        request: &ModelRequest,
        replace: bool,
        prepared: Self::Prepared,
    ) -> Result<(Self::Staged, Vec<ArtifactPointer>), ModelRunError> {
        stage_execution(
            project_capability,
            operation_id,
            request,
            replace,
            prepared.execution,
            std::slice::from_ref(&binding.model.api_key),
        )
        .map_err(|error| generation_run_error(&error))
    }

    fn commit(&self, project_root: &Path, staged: Self::Staged) -> Result<(), ModelRunError> {
        commit_staged_execution(project_root, staged, &self.metadata)
            .map_err(|error| generation_run_error(&error))
    }
}

fn generation_run_error(error: &GenerationError) -> ModelRunError {
    if error.code() == "generation_cancelled" {
        ModelRunError::cancelled()
    } else {
        ModelRunError::validation(error.code(), error.message())
    }
}

fn redact_generation_error(error: &GenerationError, secrets: &[String]) -> GenerationError {
    let value = super::redaction::redact_model_run_value(
        &serde_json::Value::String(error.message().to_owned()),
        secrets.iter().cloned(),
    );
    GenerationError::new(error.code(), value.as_str().unwrap_or("Generation failed."))
}

fn execute_model(
    kind: ModelKind,
    context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
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
) -> Result<(ResolvedGenerationModel, serde_json::Value), GenerationError> {
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
        return Err(GenerationError::new(
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
        return Err(GenerationError::new(
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
            GenerationError::new(
                "model_not_configured",
                format!("Model API key is missing: {model_id}"),
            )
        })?
        .clone();
    Ok((
        ResolvedGenerationModel {
            kind,
            model_id: model_id.to_owned(),
            request_model_id,
            base_url,
            api_key,
        },
        schema,
    ))
}

fn validate_model_endpoint(value: &str) -> Result<(), GenerationError> {
    let url = url::Url::parse(value)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(GenerationError::new(
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
        sync::{Arc, Condvar, Mutex},
        time::Duration,
    };

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::project::GeneratedArtifactRole;
    use crate::{
        generation::{
            common::ModelRequestResourceLimits,
            types::{
                HttpMethod, ModelHttpRequest, ModelHttpResponse, PreparedHttpBody as HttpBody,
            },
        },
        model_operation::{
            ExecutionShape, ModelOperationService, OperationState, SubmitModelOperation,
        },
        project::GeneratedAssetMetadataService,
    };

    struct FixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
    }

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
        operations: Arc<ModelOperationService<GenerationService>>,
        request: ModelRequest,
    }

    impl AcceptedBindingFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "debrute-accepted-model-binding-{}",
                uuid::Uuid::new_v4()
            ));
            let project = root.join("project");
            std::fs::create_dir_all(project.join(".debrute")).unwrap();
            std::fs::write(
                project.join(".debrute/project.json"),
                serde_json::to_vec(&json!({
                    "project": {
                        "id": uuid::Uuid::new_v4().to_string(),
                        "name": "Fixture",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }
                }))
                .unwrap(),
            )
            .unwrap();
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
            let executor = Arc::new(GenerationService {
                catalog: Arc::clone(&catalog),
                global_config: Arc::clone(&global_config),
                metadata: Arc::new(GeneratedAssetMetadataService::new()),
                transport: transport.clone(),
            });
            let fixture = Self {
                root,
                catalog,
                global_config,
                transport,
                operations: Arc::new(ModelOperationService::new(executor)),
                request: ModelRequest {
                    model: "gpt-image-2".to_owned(),
                    arguments: Map::from_iter([("prompt".to_owned(), json!("poster"))]),
                    output: None,
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
            cancellation: &GenerationCancellation,
            deadline: GenerationDeadline,
        ) -> Result<ModelHttpResponse, GenerationError> {
            deadline.remaining(cancellation)?;
            self.requests.lock().unwrap().push(request);
            self.responses.lock().unwrap().pop_front().ok_or_else(|| {
                GenerationError::new(
                    "fixture_exhausted",
                    "Generation fixture response queue is empty.",
                )
            })
        }
    }

    impl ModelHttpTransport for BlockingFixtureTransport {
        fn execute(
            &self,
            request: ModelHttpRequest,
            cancellation: &GenerationCancellation,
            deadline: GenerationDeadline,
        ) -> Result<ModelHttpResponse, GenerationError> {
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
                    GenerationError::new(
                        "fixture_exhausted",
                        "Generation fixture response queue is empty.",
                    )
                })
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

    fn execute_fixture(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
    ) -> (
        Result<ModelExecution, GenerationError>,
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
        Result<ModelExecution, GenerationError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        execute_fixture_with_project_root_and_limits(
            kind,
            model_id,
            arguments,
            responses,
            Path::new("."),
            limits,
        )
    }

    fn execute_fixture_with_project_root_and_limits(
        kind: ModelKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
        project_root: &Path,
        limits: ModelRequestResourceLimits,
    ) -> (
        Result<ModelExecution, GenerationError>,
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
        let model = ResolvedGenerationModel {
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
        let cancellation = GenerationCancellation::default();
        let context = ExecutionContext::new_with_limits(
            &model,
            arguments,
            project_root,
            &cancellation,
            &transport,
            GenerationDeadline::after(Duration::from_secs(5)).unwrap(),
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
                crate::generation::image::has_adapter(&entry.debrute_model_id),
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
                crate::generation::video::has_adapter(&entry.debrute_model_id),
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
            validate_arguments(model_id, &schema, &arguments).unwrap();

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
                project_root: fixture.project(),
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
                project_root: fixture.project(),
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
                project_root: fixture.project(),
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
    fn all_five_peer_generation_fixtures_use_exact_adapters() {
        let (image, image_requests) = run_fixture(
            ModelKind::Image,
            "gpt-image-1",
            &Map::from_iter([("prompt".to_owned(), json!("poster"))]),
            vec![fixture_json(&json!({
                "data": [{"b64_json": "iVBORw0KGgo="}]
            }))],
        );
        assert_eq!(image.payloads[0].role, GeneratedArtifactRole::PrimaryImage);
        assert!(image_requests[0].url.ends_with("/images/generations"));

        let (video, video_requests) = run_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-260128",
            &Map::from_iter([("prompt".to_owned(), json!("slow pan"))]),
            vec![
                fixture_json(&json!({"id": "task-1"})),
                fixture_json(&json!({
                    "status": "succeeded",
                    "content": {"video_url": "https://media.example/out.mp4"}
                })),
                fixture_media("video/mp4", b"video"),
            ],
        );
        assert_eq!(video.payloads[0].role, GeneratedArtifactRole::PrimaryVideo);
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
        assert_eq!(tts.payloads[0].role, GeneratedArtifactRole::TtsAudio);
        assert!(tts_requests[0].url.ends_with("/audio/speech"));

        let (music, music_requests) = run_fixture(
            ModelKind::Music,
            "elevenlabs-music",
            &Map::from_iter([("prompt".to_owned(), json!("ambient"))]),
            vec![fixture_media("audio/mpeg", b"music")],
        );
        assert_eq!(music.payloads[0].role, GeneratedArtifactRole::MusicAudio);
        assert!(music_requests[0].url.ends_with("/music"));

        let (effect, effect_requests) = run_fixture(
            ModelKind::SoundEffect,
            "elevenlabs-sound-effects",
            &Map::from_iter([("text".to_owned(), json!("thunder"))]),
            vec![fixture_media("audio/mpeg", b"effect")],
        );
        assert_eq!(
            effect.payloads[0].role,
            GeneratedArtifactRole::SoundEffectAudio
        );
        assert!(effect_requests[0].url.ends_with("/sound-generation"));
    }

    #[test]
    fn doubao_tts_nested_audio_schema_checks_type_not_provider_values() {
        let catalog = ModelCatalog::bundled().unwrap();
        let schema = &catalog
            .audio()
            .iter()
            .find(|entry| entry.debrute_model_id == "doubao-seed-tts-2-0")
            .unwrap()
            .arguments_schema;
        validate_arguments(
            "doubao-seed-tts-2-0",
            schema,
            &Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("speaker".to_owned(), json!("speaker")),
            ]),
        )
        .unwrap();
        for sample_rate in [json!(-1), json!(12_345), json!(96_000)] {
            let arguments = Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("speaker".to_owned(), json!("speaker")),
                (
                    "audio_params".to_owned(),
                    json!({"sample_rate": sample_rate}),
                ),
            ]);
            validate_arguments("doubao-seed-tts-2-0", schema, &arguments).unwrap();
        }
        for sample_rate in [json!(22_050.5), json!("24000"), Value::Null] {
            let arguments = Map::from_iter([
                ("text".to_owned(), json!("hello")),
                ("speaker".to_owned(), json!("speaker")),
                (
                    "audio_params".to_owned(),
                    json!({"sample_rate": sample_rate}),
                ),
            ]);
            assert!(validate_arguments("doubao-seed-tts-2-0", schema, &arguments).is_err());
        }
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

        assert_eq!(result.unwrap_err().code(), "generation_input_too_large");
        assert!(requests.is_empty());
        assert_eq!(remaining, 1);
    }

    #[test]
    fn project_input_uses_the_same_media_item_limit_before_transport() {
        let project_root = std::env::temp_dir().join(format!(
            "debrute-generation-input-limit-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&project_root).unwrap();
        std::fs::write(project_root.join("input.png"), b"12345").unwrap();
        let responses = vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))];
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!(["input.png"])),
        ]);

        let (result, requests, remaining) = execute_fixture_with_project_root_and_limits(
            ModelKind::Image,
            "gpt-image-2",
            &arguments,
            responses,
            &project_root,
            ModelRequestResourceLimits {
                input_media_item_bytes: 4,
                model_request_bytes: 1024,
            },
        );
        std::fs::remove_dir_all(project_root).unwrap();

        assert_eq!(result.unwrap_err().code(), "generation_input_too_large");
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

        assert_eq!(result.unwrap_err().code(), "generation_input_too_large");
        assert_eq!(
            requests.len(),
            1,
            "only the input download may reach transport"
        );
        assert_eq!(
            requests[0].method,
            crate::generation::types::HttpMethod::Get
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
                    {"url": "https://media.example/old-fallback.png"}
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
    fn wan_2_7_uses_one_synchronous_generation_request() {
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
        assert_eq!(fast.payloads[1].role, GeneratedArtifactRole::LastFrame);
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
        assert_eq!(
            generate.payloads[0].role,
            GeneratedArtifactRole::PrimaryVideo
        );
        assert_eq!(generate.payloads[1].role, GeneratedArtifactRole::LastFrame);
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
        assert_eq!(error.code(), "generation_task_failed");
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
                "generation_argument_invalid",
            ),
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("animate")),
                    ("intent".to_owned(), json!("unknown-intent")),
                ]),
                "generation_argument_invalid",
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
        assert_eq!(result.unwrap_err().code(), "generation_argument_invalid");
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn terminal_errors_are_redacted_with_the_model_secret() {
        let error = GenerationError::new(
            "model_request_failed",
            "request to https://example.test/out?token=live-secret failed with live-secret",
        );
        let redacted = redact_generation_error(&error, &["live-secret".to_owned()]);
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("live-secret"));
    }
}
