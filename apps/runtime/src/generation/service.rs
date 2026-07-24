use std::{
    path::Path,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use uuid::Uuid;

use crate::{
    global::{AudioModelKind, GlobalConfigSnapshot, GlobalConfigStore, ModelCatalog},
    project::GeneratedAssetMetadataService,
};

use super::{
    common::{
        DEFAULT_GENERATION_TIMEOUT, ExecutionContext, GenerationControl, store_execution,
        validate_arguments,
    },
    http::NativeModelHttpTransport,
    image, music, sound_effect, tts,
    types::{
        GenerationCancellation, GenerationDeadline, GenerationError, GenerationKind,
        GenerationRequest, GenerationSuccess, ModelExecution, ModelHttpTransport,
        ResolvedGenerationModel,
    },
    video,
};

const MAX_ACTIVE_GENERATIONS: usize = 4;
const MAX_GENERATION_WAITERS: usize = 32;
const ADMISSION_POLL: Duration = Duration::from_millis(50);

/// Runtime-owned synchronous generation authority.
pub struct GenerationService {
    catalog: Arc<ModelCatalog>,
    global_config: Arc<GlobalConfigStore>,
    metadata: Arc<GeneratedAssetMetadataService>,
    transport: Arc<dyn ModelHttpTransport>,
    admission: GenerationAdmission,
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
            admission: GenerationAdmission::new(MAX_ACTIVE_GENERATIONS),
        }
    }

    /// Executes one accepted generation request without retry or replay.
    ///
    /// # Errors
    /// Returns one terminal validation, configuration, timeout, cancellation,
    /// model, download, Project-write, or metadata error.
    pub fn execute(
        &self,
        project_root: &Path,
        kind: GenerationKind,
        request: &GenerationRequest,
        cancellation: &GenerationCancellation,
    ) -> Result<GenerationSuccess, GenerationError> {
        cancellation.check()?;
        let timeout = request
            .timeout_ms
            .map_or(DEFAULT_GENERATION_TIMEOUT, Duration::from_millis);
        if timeout.is_zero() {
            return Err(GenerationError::new(
                "generation_timeout_invalid",
                "Generation timeout must be a positive integer of milliseconds.",
            ));
        }
        let deadline = GenerationDeadline::after(timeout)?;
        let _permit = self.admission.acquire(cancellation, deadline.instant())?;
        deadline.remaining(cancellation)?;
        let snapshot = self.global_config.read_snapshot().map_err(|error| {
            GenerationError::new("global_settings_unavailable", error.to_string())
        })?;
        deadline.remaining(cancellation)?;
        let (model, schema) = resolve_model(&self.catalog, &snapshot, kind, &request.model)?;
        validate_arguments(&model.model_id, &schema, &request.arguments)?;
        deadline.remaining(cancellation)?;
        let context = ExecutionContext::new(
            &model,
            &request.arguments,
            project_root,
            cancellation,
            self.transport.as_ref(),
            deadline,
        )?;
        let execution = execute_model(kind, context).map_err(|error| {
            redact_generation_error(&error, std::slice::from_ref(&model.api_key))
        })?;
        cancellation.check()?;
        let control = GenerationControl::new(cancellation, deadline);
        let (artifacts, logs) = store_execution(
            project_root,
            &Uuid::new_v4().to_string(),
            &request.arguments,
            execution,
            &self.metadata,
            std::slice::from_ref(&model.api_key),
            &control,
        )?;
        Ok(GenerationSuccess {
            kind,
            model: model.model_id,
            content: format!("Generated {} artifact(s).", artifacts.len()),
            artifacts,
            logs,
        })
    }

    #[must_use]
    pub fn generated_assets(&self) -> &Arc<GeneratedAssetMetadataService> {
        &self.metadata
    }
}

fn redact_generation_error(error: &GenerationError, secrets: &[String]) -> GenerationError {
    let value = super::redaction::redact_model_run_value(
        &serde_json::json!({
            "message": error.message(),
            "details": error.details(),
            "logs": error.logs(),
        }),
        secrets.iter().cloned(),
    );
    let mut redacted = GenerationError::new(
        error.code(),
        value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Generation failed."),
    );
    if let Some(details) = value.get("details").filter(|value| !value.is_null()) {
        redacted = redacted.with_details(details.clone());
    }
    if let Some(logs) = value.get("logs").and_then(serde_json::Value::as_array) {
        redacted = redacted.with_logs(logs.clone());
    }
    redacted
}

fn execute_model(
    kind: GenerationKind,
    context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    match kind {
        GenerationKind::Image => image::execute(context),
        GenerationKind::Video => video::execute(context),
        GenerationKind::Tts => tts::execute(context),
        GenerationKind::Music => music::execute(context),
        GenerationKind::SoundEffect => sound_effect::execute(context),
    }
}

fn resolve_model(
    catalog: &ModelCatalog,
    snapshot: &GlobalConfigSnapshot,
    kind: GenerationKind,
    model_id: &str,
) -> Result<(ResolvedGenerationModel, serde_json::Value), GenerationError> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err(GenerationError::new(
            "model_unavailable",
            "Generation model must be non-empty.",
        ));
    }
    let (base_url, request_model_id, schema, configurations, secrets) = match kind {
        GenerationKind::Image => {
            let entry = catalog
                .images()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .ok_or_else(|| unavailable(kind, model_id))?;
            (
                entry.default_base_url.clone(),
                entry.default_request_model_id.clone(),
                entry.arguments_schema.clone(),
                &snapshot.settings.models.image.image_models,
                &snapshot.secrets.image_model_api_keys,
            )
        }
        GenerationKind::Video => {
            let entry = catalog
                .videos()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id)
                .ok_or_else(|| unavailable(kind, model_id))?;
            (
                entry.default_base_url.clone(),
                entry.default_request_model_id.clone(),
                entry.arguments_schema.clone(),
                &snapshot.settings.models.video.video_models,
                &snapshot.secrets.video_model_api_keys,
            )
        }
        GenerationKind::Tts | GenerationKind::Music | GenerationKind::SoundEffect => {
            let expected = match kind {
                GenerationKind::Tts => AudioModelKind::Tts,
                GenerationKind::Music => AudioModelKind::Music,
                GenerationKind::SoundEffect => AudioModelKind::SoundEffect,
                _ => unreachable!("audio generation kind"),
            };
            let entry = catalog
                .audio()
                .iter()
                .find(|entry| entry.debrute_model_id == model_id && entry.kind == expected)
                .ok_or_else(|| unavailable(kind, model_id))?;
            (
                entry.default_base_url.clone(),
                entry.default_request_model_id.clone(),
                entry.arguments_schema.clone(),
                &snapshot.settings.models.audio.audio_models,
                &snapshot.secrets.audio_model_api_keys,
            )
        }
    };
    let configuration = configurations
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
    let api_key = secrets
        .get(model_id)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_not_configured",
                format!("Model API key is missing: {model_id}"),
            )
        })?
        .to_owned();
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

fn unavailable(kind: GenerationKind, model_id: &str) -> GenerationError {
    GenerationError::new(
        "model_unavailable",
        format!("{kind:?} model is unavailable: {model_id}"),
    )
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

struct GenerationAdmission {
    capacity: usize,
    state: Mutex<AdmissionState>,
    available: Condvar,
}

struct AdmissionState {
    active: usize,
    waiters: usize,
}

impl GenerationAdmission {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(AdmissionState {
                active: 0,
                waiters: 0,
            }),
            available: Condvar::new(),
        }
    }

    fn acquire(
        &self,
        cancellation: &GenerationCancellation,
        deadline: Instant,
    ) -> Result<GenerationPermit<'_>, GenerationError> {
        cancellation.check()?;
        let mut state = self.lock()?;
        if state.active >= self.capacity {
            if state.waiters >= MAX_GENERATION_WAITERS {
                return Err(GenerationError::new(
                    "generation_backpressure",
                    "Generation admission queue is full.",
                ));
            }
            state.waiters += 1;
            while state.active >= self.capacity {
                if let Err(error) = cancellation.check() {
                    state.waiters = state.waiters.saturating_sub(1);
                    return Err(error);
                }
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    state.waiters = state.waiters.saturating_sub(1);
                    return Err(GenerationError::new(
                        "generation_timeout",
                        "Generation timed out while waiting for admission.",
                    ));
                };
                state = self
                    .available
                    .wait_timeout(state, remaining.min(ADMISSION_POLL))
                    .map_err(|_| {
                        GenerationError::new(
                            "generation_state_poisoned",
                            "Generation admission state is poisoned.",
                        )
                    })?
                    .0;
            }
            state.waiters = state.waiters.saturating_sub(1);
        }
        cancellation.check()?;
        state.active += 1;
        Ok(GenerationPermit { admission: self })
    }

    fn lock(&self) -> Result<MutexGuard<'_, AdmissionState>, GenerationError> {
        self.state.lock().map_err(|_| {
            GenerationError::new(
                "generation_state_poisoned",
                "Generation admission state is poisoned.",
            )
        })
    }
}

struct GenerationPermit<'a> {
    admission: &'a GenerationAdmission,
}

impl Drop for GenerationPermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .admission
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active = state.active.saturating_sub(1);
        self.admission.available.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, path::Path};

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::generation::types::{HttpBody, ModelHttpRequest, ModelHttpResponse};
    use crate::project::GeneratedArtifactRole;

    struct FixtureTransport {
        responses: Mutex<VecDeque<ModelHttpResponse>>,
        requests: Mutex<Vec<ModelHttpRequest>>,
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
        kind: GenerationKind,
        model_id: &str,
        arguments: &Map<String, Value>,
        responses: Vec<ModelHttpResponse>,
    ) -> (
        Result<ModelExecution, GenerationError>,
        Vec<ModelHttpRequest>,
        usize,
    ) {
        let model = ResolvedGenerationModel {
            kind,
            model_id: model_id.to_owned(),
            request_model_id: model_id.to_owned(),
            base_url: "https://model.example/v1".to_owned(),
            api_key: "live-secret".to_owned(),
        };
        let transport = FixtureTransport {
            responses: Mutex::new(VecDeque::from(responses)),
            requests: Mutex::new(Vec::new()),
        };
        let cancellation = GenerationCancellation::default();
        let context = ExecutionContext::new(
            &model,
            arguments,
            Path::new("."),
            &cancellation,
            &transport,
            GenerationDeadline::after(Duration::from_secs(5)).unwrap(),
        )
        .unwrap();
        let execution = execute_model(kind, context);
        let requests = transport.requests.into_inner().unwrap();
        let remaining = transport.responses.into_inner().unwrap().len();
        (execution, requests, remaining)
    }

    fn run_fixture(
        kind: GenerationKind,
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
    fn every_catalog_model_resolves_only_in_its_peer_kind() {
        let catalog = ModelCatalog::bundled().unwrap();
        let mut snapshot = GlobalConfigSnapshot::default();
        for entry in catalog.images() {
            snapshot
                .secrets
                .image_model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            assert!(
                resolve_model(
                    &catalog,
                    &snapshot,
                    GenerationKind::Image,
                    &entry.debrute_model_id
                )
                .is_ok()
            );
        }
        for entry in catalog.videos() {
            snapshot
                .secrets
                .video_model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            assert!(
                resolve_model(
                    &catalog,
                    &snapshot,
                    GenerationKind::Video,
                    &entry.debrute_model_id
                )
                .is_ok()
            );
        }
        for entry in catalog.audio() {
            snapshot
                .secrets
                .audio_model_api_keys
                .insert(entry.debrute_model_id.clone(), "secret".to_owned());
            let kind = match entry.kind {
                AudioModelKind::Tts => GenerationKind::Tts,
                AudioModelKind::Music => GenerationKind::Music,
                AudioModelKind::SoundEffect => GenerationKind::SoundEffect,
            };
            assert!(resolve_model(&catalog, &snapshot, kind, &entry.debrute_model_id).is_ok());
        }
    }

    #[test]
    fn admission_is_cancellation_aware() {
        let admission = GenerationAdmission::new(1);
        let cancellation = GenerationCancellation::default();
        let permit = admission
            .acquire(&cancellation, Instant::now() + Duration::from_secs(1))
            .unwrap();
        cancellation.cancel();
        assert!(
            admission
                .acquire(&cancellation, Instant::now() + Duration::from_secs(1))
                .is_err()
        );
        drop(permit);
    }

    #[test]
    fn all_five_peer_generation_fixtures_use_exact_adapters() {
        let (image, image_requests) = run_fixture(
            GenerationKind::Image,
            "gpt-image-1",
            &Map::from_iter([("prompt".to_owned(), json!("poster"))]),
            vec![fixture_json(&json!({"data": [{"b64_json": "AQID"}]}))],
        );
        assert_eq!(image.payloads[0].role, GeneratedArtifactRole::PrimaryImage);
        assert!(image_requests[0].url.ends_with("/images/generations"));

        let (video, video_requests) = run_fixture(
            GenerationKind::Video,
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
            GenerationKind::Tts,
            "openai-tts-1",
            &Map::from_iter([("text".to_owned(), json!("hello"))]),
            vec![fixture_media("audio/mpeg", b"tts")],
        );
        assert_eq!(tts.payloads[0].role, GeneratedArtifactRole::TtsAudio);
        assert!(tts_requests[0].url.ends_with("/audio/speech"));

        let (music, music_requests) = run_fixture(
            GenerationKind::Music,
            "elevenlabs-music",
            &Map::from_iter([("prompt".to_owned(), json!("ambient"))]),
            vec![fixture_media("audio/mpeg", b"music")],
        );
        assert_eq!(music.payloads[0].role, GeneratedArtifactRole::MusicAudio);
        assert!(music_requests[0].url.contains("/music?"));

        let (effect, effect_requests) = run_fixture(
            GenerationKind::SoundEffect,
            "elevenlabs-sound-effects",
            &Map::from_iter([("prompt".to_owned(), json!("thunder"))]),
            vec![fixture_media("audio/mpeg", b"effect")],
        );
        assert_eq!(
            effect.payloads[0].role,
            GeneratedArtifactRole::SoundEffectAudio
        );
        assert!(effect_requests[0].url.contains("/sound-generation?"));
    }

    #[test]
    fn gpt_image_two_data_url_edits_use_multipart() {
        let (_, requests) = run_fixture(
            GenerationKind::Image,
            "gpt-image-2",
            &Map::from_iter([
                ("prompt".to_owned(), json!("edit")),
                (
                    "image".to_owned(),
                    json!(["data:image/png;base64,iVBORw0KGgo="]),
                ),
            ]),
            vec![fixture_json(&json!({"data": [{"b64_json": "AQID"}]}))],
        );
        assert!(matches!(requests[0].body, HttpBody::Multipart { .. }));
    }

    #[test]
    fn image_inputs_reject_empty_arrays_masks_without_images_and_unregistered_mime_types() {
        for (arguments, expected_code) in [
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("edit")),
                    ("image".to_owned(), json!([])),
                ]),
                "generation_argument_invalid",
            ),
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("edit")),
                    (
                        "mask".to_owned(),
                        json!("data:image/png;base64,iVBORw0KGgo="),
                    ),
                ]),
                "generation_argument_invalid",
            ),
            (
                Map::from_iter([
                    ("prompt".to_owned(), json!("edit")),
                    ("image".to_owned(), json!("data:image/gif;base64,AQID")),
                ]),
                "generation_input_invalid",
            ),
        ] {
            let (result, requests, remaining) =
                execute_fixture(GenerationKind::Image, "gpt-image-2", &arguments, Vec::new());
            assert_eq!(result.unwrap_err().code(), expected_code);
            assert!(requests.is_empty());
            assert_eq!(remaining, 0);
        }
    }

    #[test]
    fn provider_side_media_urls_are_publicly_validated_before_submission() {
        let arguments = Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!("http://127.0.0.1/private.png")),
        ]);
        let (result, requests, remaining) =
            execute_fixture(GenerationKind::Image, "gpt-image-2", &arguments, Vec::new());
        assert_eq!(result.unwrap_err().code(), "remote_media_host_blocked");
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }

    #[test]
    fn image_response_cardinality_is_rejected_before_artifact_downloads() {
        let urls = (0..17)
            .map(|index| json!({"url": format!("https://media.example/{index}.png")}))
            .collect::<Vec<_>>();
        let arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
        let (result, requests, remaining) = execute_fixture(
            GenerationKind::Image,
            "gpt-image-1",
            &arguments,
            vec![fixture_json(&json!({"data": urls}))],
        );
        assert_eq!(result.unwrap_err().code(), "model_response_too_large");
        assert_eq!(requests.len(), 1, "no artifact download may start");
        assert_eq!(remaining, 0);
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
            GenerationKind::Video,
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
        )
        .with_details(json!({"cookie": "live-secret"}));
        let redacted = redact_generation_error(&error, &["live-secret".to_owned()]);
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("live-secret"));
    }
}
