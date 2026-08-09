use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    global::{AudioModelKind, GlobalRuntimeService, ModelCatalog},
    model_operation::{
        BatchItemOutcome, ExecutionShape, ModelKind, ModelOperationExecution,
        ModelOperationListQuery, ModelOperationService, ModelOperationSnapshot, OperationListState,
        SubmitModelOperation, parse_model_requests,
    },
    model_request::{
        ModelArtifactProvenanceLookup, ModelArtifactProvenanceStore, ModelRequestExecutor,
    },
    project::{
        ProjectCommand, ProjectCommandResult, ProjectDiagnostic, ProjectDiagnosticSeverity,
        ProjectError, ProjectSessionRegistry, ProjectSnapshot, ProjectUseKind,
    },
    workbench::{RuntimeCliHttpService, RuntimeCliRecordStream, RuntimeHttpServiceError},
};

use super::records::{CliFields, CliProgress, CliRecord, CliResult, CliStreamEvent};

#[derive(Clone)]
pub struct RuntimeCliService {
    models: Arc<ModelCatalog>,
    global: Arc<GlobalRuntimeService>,
    projects: ProjectSessionRegistry,
    provenance: Arc<ModelArtifactProvenanceStore>,
    model_operations: Arc<ModelOperationService<ModelRequestExecutor>>,
    active_product: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CliCommandRequest {
    pub(super) command: String,
    pub(super) positional: Vec<String>,
    pub(super) options: BTreeMap<String, String>,
    pub(super) root: Option<PathBuf>,
    pub(super) cwd: PathBuf,
}

#[derive(Debug)]
pub(super) struct CliFailure {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) fields: CliFields,
}

impl CliFailure {
    pub(super) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            fields: CliFields::default(),
        }
    }

    pub(super) fn with_field(
        mut self,
        key: impl Into<String>,
        value: impl Into<super::records::CliPrimitive>,
    ) -> Self {
        self.fields.insert(key, value.into());
        self
    }
}

impl RuntimeCliService {
    #[must_use]
    pub fn new(
        models: Arc<ModelCatalog>,
        global: Arc<GlobalRuntimeService>,
        projects: ProjectSessionRegistry,
        provenance: Arc<ModelArtifactProvenanceStore>,
        model_operations: Arc<ModelOperationService<ModelRequestExecutor>>,
        active_product: Option<PathBuf>,
    ) -> Self {
        Self {
            models,
            global,
            projects,
            provenance,
            model_operations,
            active_product,
        }
    }

    fn run_command(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        match request.command.as_str() {
            "runtime.status" => self.runtime_status(request),
            "runtime.doctor" => self.runtime_doctor(request),
            "skills.status" => self.skills_status(request),
            "models.image.list" => self.list_image_models(request),
            "models.video.list" => self.list_video_models(request),
            "models.tts.list" => self.list_audio_models(request, AudioModelKind::Tts),
            "models.music.list" => self.list_audio_models(request, AudioModelKind::Music),
            "models.sfx.list" => self.list_audio_models(request, AudioModelKind::SoundEffect),
            "models.image.describe" => self.describe_image_model(request),
            "models.video.describe" => self.describe_video_model(request),
            "models.tts.describe" => self.describe_audio_model(request, AudioModelKind::Tts),
            "models.music.describe" => self.describe_audio_model(request, AudioModelKind::Music),
            "models.sfx.describe" => {
                self.describe_audio_model(request, AudioModelKind::SoundEffect)
            }
            "project.status" | "project.validate" => self.project_command(request),
            "model-artifact.lookup" => self.model_artifact_lookup(request),
            "operation.list" => self.operation_list(request),
            "operation.inspect" => self.operation_inspect(request),
            "operation.cancel" => self.operation_cancel(request),
            "operation.wait" => Err(CliFailure::new(
                "invalid_command",
                "operation.wait requires the streaming CLI route.",
            )),
            _ => Err(CliFailure::new(
                "invalid_command",
                format!("Unsupported Runtime CLI command: {}", request.command),
            )),
        }
    }

    fn runtime_status(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        require_no_arguments(request)?;
        let settings = self
            .global
            .settings_get()
            .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))?;
        let models = &self.models;
        let available_image = settings
            .models
            .image
            .iter()
            .filter(|model| model.api_key_set)
            .count();
        let available_video = settings
            .models
            .video
            .iter()
            .filter(|model| model.api_key_set)
            .count();
        let available_audio = settings
            .models
            .audio
            .iter()
            .filter(|model| model.api_key_set)
            .count();
        Ok(ok(
            &request.command,
            json!({
                "ok": true,
                "runtime_state": "ready",
                "native_tray": "active",
                "image_models": models.images().len(),
                "available_image_models": available_image,
                "video_models": models.videos().len(),
                "available_video_models": available_video,
                "audio_models": models.audio().len(),
                "available_audio_models": available_audio,
                "diagnostics": 0
            }),
        ))
    }

    fn runtime_doctor(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let status = self.runtime_status(request)?;
        let fields = status.fields();
        let mut records = Vec::new();
        for (field, code, message) in [
            (
                "available_image_models",
                "image_model_not_configured",
                "No available image model is configured.",
            ),
            (
                "available_video_models",
                "video_model_not_configured",
                "No available video model is configured.",
            ),
            (
                "available_audio_models",
                "audio_model_not_configured",
                "No available audio model is configured.",
            ),
        ] {
            if fields
                .get(field)
                .and_then(super::records::CliPrimitive::as_u64)
                == Some(0)
            {
                records.push(json!({"name": "diagnostic", "fields": {
                    "code": code, "severity": "warning", "message": message
                }}));
            }
        }
        if records.is_empty() {
            records.push(json!({"name": "diagnostic", "fields": {
                "code": "runtime_ok", "severity": "info",
                "message": "Debrute runtime configuration is usable."
            }}));
        }
        let count = records.len();
        Ok(ok_records(
            &request.command,
            records,
            json!({
                "runtime_state": "ready",
                "native_tray": "active",
                "diagnostics": count
            }),
        ))
    }

    fn skills_status(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        require_no_arguments(request)?;
        let product = self.active_product.clone();
        let Some(product) = product else {
            return Err(CliFailure::new(
                "skills_bundle_unavailable",
                "The active Product Skills bundle is unavailable.",
            ));
        };
        let skills = product.join("skills");
        if !skills.is_dir() {
            return Err(CliFailure::new(
                "skills_bundle_unavailable",
                "The active Product Skills directory is unavailable.",
            )
            .with_field("path", skills.to_string_lossy().into_owned()));
        }
        Ok(ok(
            &request.command,
            json!({
                "skills_status": "ready",
                "skills_version": env!("CARGO_PKG_VERSION"),
                "skills_root": skills.to_string_lossy()
            }),
        ))
    }

    fn list_image_models(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let configured = settings
            .models
            .image
            .iter()
            .filter(|model| model.api_key_set);
        let records = configured
            .filter_map(|setting| {
                self.models.images().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id)
            })
            .map(|entry| json!({"name": "model", "fields": {
                "id": entry.debrute_model_id,
                "parameters": serde_json::to_string(&entry.list_parameters).expect("model parameters serialize")
            }}))
            .collect::<Vec<_>>();
        Ok(ok_records(
            &request.command,
            records.clone(),
            json!({"count": records.len()}),
        ))
    }

    fn list_video_models(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let records = settings.models.video.iter()
            .filter(|model| model.api_key_set)
            .filter_map(|setting| self.models.videos().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id))
            .map(|entry| json!({"name": "model", "fields": {
                "id": entry.debrute_model_id,
                "parameters": serde_json::to_string(&entry.list_parameters).expect("model parameters serialize")
            }}))
            .collect::<Vec<_>>();
        Ok(ok_records(
            &request.command,
            records.clone(),
            json!({"count": records.len()}),
        ))
    }

    fn list_audio_models(
        &self,
        request: &CliCommandRequest,
        kind: AudioModelKind,
    ) -> Result<CliResult, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let records = settings.models.audio.iter()
            .filter(|model| model.api_key_set && model.kind == kind)
            .filter_map(|setting| self.models.audio().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id && entry.kind == kind))
            .map(|entry| json!({"name": "model", "fields": {
                "id": entry.debrute_model_id,
                "kind": audio_kind_name(entry.kind),
                "parameters": serde_json::to_string(&entry.list_parameters).expect("model parameters serialize")
            }}))
            .collect::<Vec<_>>();
        Ok(ok_records(
            &request.command,
            records.clone(),
            json!({"count": records.len()}),
        ))
    }

    fn describe_image_model(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .models
            .images()
            .iter()
            .find(|entry| entry.debrute_model_id == model_id)
            .ok_or_else(|| unavailable("Image", model_id))?;
        let documentation =
            super::model_docs::describe_model(model_id, &request.command, &entry.request_example)?;
        Ok(model_detail(
            &request.command,
            &entry.debrute_model_id,
            None,
            &entry.summary,
            &entry.capabilities,
            &entry.arguments_schema,
            &documentation,
        ))
    }

    fn describe_video_model(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .models
            .videos()
            .iter()
            .find(|entry| entry.debrute_model_id == model_id)
            .ok_or_else(|| unavailable("Video", model_id))?;
        let documentation =
            super::model_docs::describe_model(model_id, &request.command, &entry.request_example)?;
        Ok(model_detail(
            &request.command,
            &entry.debrute_model_id,
            None,
            &entry.summary,
            &entry.capabilities,
            &entry.arguments_schema,
            &documentation,
        ))
    }

    fn describe_audio_model(
        &self,
        request: &CliCommandRequest,
        kind: AudioModelKind,
    ) -> Result<CliResult, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .models
            .audio()
            .iter()
            .find(|entry| entry.debrute_model_id == model_id)
            .ok_or_else(|| audio_unavailable(model_id))?;
        if entry.kind != kind {
            return Err(CliFailure::new(
                "audio_model_kind_mismatch",
                format!("Audio model kind does not match command: {model_id}"),
            )
            .with_field("model", model_id.to_owned()));
        }
        let documentation =
            super::model_docs::describe_model(model_id, &request.command, &entry.request_example)?;
        Ok(model_detail(
            &request.command,
            &entry.debrute_model_id,
            Some(audio_kind_name(entry.kind)),
            &entry.summary,
            &entry.capabilities,
            &entry.arguments_schema,
            &documentation,
        ))
    }

    fn project_command(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let root = required_root(request)?;
        validate_project_root(root)?;
        let opened = self.open_project(root)?;
        let snapshot = if request.command == "project.validate" {
            let refreshed = opened
                .session
                .execute(ProjectCommand::Validate)
                .map_err(project_failure)?;
            let ProjectCommandResult::Snapshot(snapshot) = refreshed.value else {
                unreachable!("Project validation must return its complete snapshot")
            };
            snapshot
        } else {
            opened
                .session
                .sync_snapshot()
                .map_err(project_failure)?
                .snapshot
        };
        if request.command == "project.validate" && snapshot.health.diagnostic_counts.errors > 0 {
            return Ok(error_records(
                &request.command,
                "project_validation_failed",
                Some("Project validation failed."),
                diagnostic_records(&snapshot),
                Value::Object(diagnostic_count_map(&snapshot)),
            ));
        }
        let records = if request.command == "project.validate" {
            diagnostic_records(&snapshot)
        } else {
            Vec::new()
        };
        Ok(ok_records(
            &request.command,
            records,
            project_snapshot_fields(&snapshot),
        ))
    }

    fn model_artifact_lookup(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let path = request
            .options
            .get("path")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| CliFailure::new("missing_argument", "--path is required."))?;
        let lookup = self
            .provenance
            .lookup(Path::new(path))
            .map_err(|error| CliFailure::new("model_artifact_unavailable", error.to_string()))?;
        Ok(ok(&request.command, model_artifact_fields(&lookup)))
    }

    fn operation_list(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let query = ModelOperationListQuery {
            state: request
                .options
                .get("state")
                .map(|value| parse_operation_state(value))
                .transpose()?,
            model_kind: request
                .options
                .get("model-kind")
                .map(|value| parse_model_kind(value))
                .transpose()?,
            limit: request
                .options
                .get("limit")
                .map_or(Ok(25), |value| bounded_usize(value, "--limit", 100))?,
            cursor: request.options.get("cursor").cloned(),
        };
        let list = self
            .model_operations
            .list(&query)
            .map_err(operation_failure)?;
        let mut records = Vec::new();
        for snapshot in &list.operations {
            records.extend(operation_records(snapshot));
        }
        Ok(ok_records(
            &request.command,
            records,
            json!({"next_cursor": list.next_cursor}),
        ))
    }

    fn operation_inspect(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        let snapshot = self
            .model_operations
            .inspect(one_positional(request)?)
            .map_err(operation_failure)?;
        Ok(ok_records(
            &request.command,
            operation_records(&snapshot),
            json!({}),
        ))
    }

    fn operation_cancel(&self, request: &CliCommandRequest) -> Result<CliResult, CliFailure> {
        match self.model_operations.cancel(one_positional(request)?) {
            Ok(snapshot) => Ok(ok_records(
                &request.command,
                operation_records(&snapshot),
                json!({}),
            )),
            Err(error) => {
                let records = error.snapshot().map(operation_records).unwrap_or_default();
                Ok(error_records(
                    &request.command,
                    error.code(),
                    None,
                    records,
                    json!({}),
                ))
            }
        }
    }

    fn settings(&self) -> Result<crate::global::DebruteGlobalSettingsView, CliFailure> {
        self.global
            .settings_get()
            .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))
    }

    fn open_project(&self, root: &Path) -> Result<crate::project::OpenProjectSession, CliFailure> {
        self.projects
            .open_project(root, ProjectUseKind::Request)
            .map_err(project_failure)
    }
}

impl RuntimeCliHttpService for RuntimeCliService {
    fn run(&self, request: &Value) -> Result<CliResult, RuntimeHttpServiceError> {
        let request = parse_request(request)?;
        Ok(match self.run_command(&request) {
            Ok(result) => result,
            Err(failure) => failure_value(&request.command, failure),
        })
    }

    fn submit(&self, request: &Value, input: &[u8]) -> Result<CliResult, RuntimeHttpServiceError> {
        let request = parse_request(request)?;
        let shape = match request.command.as_str() {
            "request.single" => ExecutionShape::Single,
            "request.batch" => ExecutionShape::Batch,
            _ => {
                return Err(RuntimeHttpServiceError::new(
                    StatusCode::BAD_REQUEST,
                    "cli_submit_command_invalid",
                    "Only request.single and request.batch use the submission route.",
                ));
            }
        };
        let result = (|| {
            let requests = parse_model_requests(input, shape).map_err(operation_failure)?;
            let concurrency = request
                .options
                .get("concurrency")
                .map(|value| bounded_usize(value, "--concurrency", usize::MAX))
                .transpose()?;
            let timeout_seconds = request
                .options
                .get("timeout")
                .map(|value| parse_timeout_seconds(value))
                .transpose()?;
            let snapshot = self
                .model_operations
                .submit(SubmitModelOperation {
                    invocation_cwd: request.cwd.clone(),
                    shape,
                    requests,
                    concurrency,
                    timeout_seconds,
                    replace: request
                        .options
                        .get("replace")
                        .is_some_and(|value| value == "true"),
                })
                .map_err(operation_failure)?;
            Ok(ok_records(
                &request.command,
                operation_records(&snapshot),
                json!({}),
            ))
        })();
        Ok(match result {
            Ok(result) => result,
            Err(failure) => failure_value(&request.command, failure),
        })
    }

    fn run_stream(
        &self,
        request: &Value,
        observer_is_alive: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<RuntimeCliRecordStream, RuntimeHttpServiceError> {
        let request = parse_request(request)?;
        if request.command != "operation.wait" {
            return Err(RuntimeHttpServiceError::new(
                StatusCode::BAD_REQUEST,
                "cli_stream_command_invalid",
                "Only operation.wait uses the Runtime CLI stream.",
            ));
        }
        let (sender, stream) = RuntimeCliRecordStream::bounded(64);
        let operations = Arc::clone(&self.model_operations);
        std::thread::Builder::new()
            .name("debrute-cli-operation-wait".to_owned())
            .spawn(move || {
                let operation_id = request.positional[0].clone();
                let result = match operations.wait(
                    &operation_id,
                    || !sender.is_closed() && observer_is_alive(),
                    |snapshot| {
                        sender
                            .blocking_send(CliStreamEvent::Progress {
                                fields: CliProgress {
                                    event: "operation.observed".to_owned(),
                                    records: typed_records(operation_records(snapshot)),
                                },
                            })
                            .is_ok()
                    },
                    |outcome| {
                        sender
                            .blocking_send(CliStreamEvent::Progress {
                                fields: batch_outcome_progress(outcome),
                            })
                            .is_ok()
                    },
                ) {
                    Ok(Some(snapshot)) => terminal_operation_result(&request.command, &snapshot),
                    Ok(None) => return,
                    Err(error) => failure_value(&request.command, operation_failure(error)),
                };
                let _ = sender.blocking_send(CliStreamEvent::Result { result });
            })
            .map_err(|error| {
                RuntimeHttpServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cli_stream_unavailable",
                    error.to_string(),
                )
            })?;
        Ok(stream)
    }
}

fn parse_request(request: &Value) -> Result<CliCommandRequest, RuntimeHttpServiceError> {
    serde_json::from_value(request.clone()).map_err(|error| {
        RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "cli_request_invalid",
            error.to_string(),
        )
    })
}

fn require_no_arguments(request: &CliCommandRequest) -> Result<(), CliFailure> {
    if request.positional.is_empty() && request.options.is_empty() {
        Ok(())
    } else {
        Err(CliFailure::new(
            "invalid_argument",
            format!("{} does not accept arguments.", request.command),
        ))
    }
}

fn one_positional(request: &CliCommandRequest) -> Result<&str, CliFailure> {
    if request.positional.len() == 1 && request.options.is_empty() {
        Ok(&request.positional[0])
    } else if request.positional.is_empty() {
        Err(CliFailure::new(
            "missing_argument",
            format!("{} requires one model id.", request.command),
        ))
    } else {
        Err(CliFailure::new(
            "invalid_argument",
            format!("{} accepts exactly one model id.", request.command),
        ))
    }
}

fn required_root(request: &CliCommandRequest) -> Result<&Path, CliFailure> {
    request.root.as_deref().ok_or_else(|| {
        CliFailure::new(
            "missing_argument",
            format!("{} requires root.", request.command),
        )
    })
}

fn model_detail(
    command: &str,
    model_id: &str,
    kind: Option<&str>,
    summary: &str,
    capabilities: &Value,
    arguments_schema: &Value,
    documentation: &super::model_docs::ModelDocumentation,
) -> CliResult {
    let mut model_fields = Map::new();
    model_fields.insert("id".to_owned(), Value::String(model_id.to_owned()));
    if let Some(kind) = kind {
        model_fields.insert("kind".to_owned(), Value::String(kind.to_owned()));
    }
    ok_records(
        command,
        vec![
            Value::Object(Map::from_iter([
                ("name".to_owned(), Value::String("model".to_owned())),
                ("fields".to_owned(), Value::Object(model_fields)),
            ])),
            json!({"name": "official_doc", "fields": {
                "urls": serde_json::to_string(documentation.source_urls).expect("URLs serialize"),
                "snapshot": documentation.snapshot_path,
                "captured_at": documentation.captured_at
            }}),
        ],
        json!({
            "summary": summary,
            "capabilities": serde_json::to_string(capabilities).expect("capabilities serialize"),
            "arguments_schema": serde_json::to_string(arguments_schema).expect("schema serializes"),
        "description_markdown": documentation.description_markdown
        }),
    )
}

fn unavailable(kind: &str, model_id: &str) -> CliFailure {
    CliFailure::new(
        "model_unavailable",
        format!("{kind} model is unknown: {model_id}"),
    )
    .with_field("model", model_id.to_owned())
}

fn audio_unavailable(model_id: &str) -> CliFailure {
    CliFailure::new(
        "audio_model_unavailable",
        format!("Audio model is unknown: {model_id}"),
    )
    .with_field("model", model_id.to_owned())
}

fn project_snapshot_fields(snapshot: &ProjectSnapshot) -> Value {
    let mut fields = diagnostic_count_map(snapshot);
    fields.insert(
        "project_root".to_owned(),
        Value::String(snapshot.canonical_root.clone()),
    );
    fields.insert(
        "project_name".to_owned(),
        Value::String(snapshot.health.project_name.clone()),
    );
    match &snapshot.canvas_workspace {
        crate::project::CanvasWorkspaceSnapshot::Available { .. } => {
            fields.insert(
                "canvas_workspace".to_owned(),
                Value::String("available".to_owned()),
            );
        }
        crate::project::CanvasWorkspaceSnapshot::Unavailable { code, message } => {
            fields.insert(
                "canvas_workspace".to_owned(),
                Value::String("unavailable".to_owned()),
            );
            fields.insert(
                "canvas_workspace_error_code".to_owned(),
                Value::String(code.as_str().to_owned()),
            );
            fields.insert(
                "canvas_workspace_error_message".to_owned(),
                Value::String(message.clone()),
            );
        }
    }
    Value::Object(fields)
}

fn diagnostic_count_map(snapshot: &ProjectSnapshot) -> Map<String, Value> {
    Map::from_iter([
        (
            "errors".to_owned(),
            Value::from(snapshot.health.diagnostic_counts.errors),
        ),
        (
            "warnings".to_owned(),
            Value::from(snapshot.health.diagnostic_counts.warnings),
        ),
    ])
}

fn diagnostic_records(snapshot: &ProjectSnapshot) -> Vec<Value> {
    snapshot.diagnostics.iter().map(diagnostic_record).collect()
}

fn diagnostic_record(diagnostic: &ProjectDiagnostic) -> Value {
    let severity = match diagnostic.severity {
        ProjectDiagnosticSeverity::Error => "error",
        ProjectDiagnosticSeverity::Warning => "warning",
    };
    json!({"name": "diagnostic", "fields": {
        "id": diagnostic.id,
        "severity": severity,
        "code": diagnostic.code,
        "message": diagnostic.message,
        "path": diagnostic.file_path
    }})
}

fn model_artifact_fields(lookup: &ModelArtifactProvenanceLookup) -> Value {
    json!({
        "status": if lookup.record.is_some() { "matched" } else { "unmatched" },
        "hash": lookup.sha256,
        "metadata": serde_json::to_string(lookup).expect("lookup serializes")
    })
}

fn audio_kind_name(kind: AudioModelKind) -> &'static str {
    match kind {
        AudioModelKind::Tts => "tts",
        AudioModelKind::Music => "music",
        AudioModelKind::SoundEffect => "sound-effect",
    }
}

fn operation_records(snapshot: &ModelOperationSnapshot) -> Vec<Value> {
    let mut fields = Map::from_iter([
        ("id".to_owned(), Value::String(snapshot.id.clone())),
        (
            "model_kind".to_owned(),
            Value::String(model_kind_name(snapshot.model_kind).to_owned()),
        ),
        (
            "state".to_owned(),
            Value::String(operation_state_name(snapshot.state).to_owned()),
        ),
        (
            "accepted_at".to_owned(),
            Value::String(snapshot.accepted_at.clone()),
        ),
    ]);
    match &snapshot.execution {
        ModelOperationExecution::Single {
            model,
            timeout_seconds,
            ..
        } => {
            fields.insert("shape".to_owned(), Value::String("single".to_owned()));
            fields.insert("model".to_owned(), Value::String(model.clone()));
            fields.insert("timeout_seconds".to_owned(), Value::from(*timeout_seconds));
        }
        ModelOperationExecution::Batch {
            item_count,
            concurrency,
            timeout_seconds,
            active,
            succeeded,
            failed,
        } => {
            fields.insert("shape".to_owned(), Value::String("batch".to_owned()));
            for (key, value) in [
                ("item_count", *item_count),
                ("concurrency", *concurrency),
                ("active", *active),
                ("succeeded", *succeeded),
                ("failed", *failed),
            ] {
                fields.insert(key.to_owned(), Value::from(value));
            }
            fields.insert("timeout_seconds".to_owned(), Value::from(*timeout_seconds));
        }
    }
    if let Some(log) = &snapshot.log {
        fields.insert("log".to_owned(), Value::String(log.clone()));
    }
    let mut records = vec![json!({"name": "operation", "fields": fields})];
    for artifact in snapshot.execution.single_artifacts() {
        records.push(artifact_record(artifact));
    }
    records.extend(snapshot.diagnostics.iter().map(|diagnostic| {
        json!({
            "name": "diagnostic",
            "fields": {
                "severity": "warning",
                "code": diagnostic.code,
                "message": diagnostic.message,
                "item_index": diagnostic.item_index,
            }
        })
    }));
    records
}

fn terminal_operation_result(command: &str, snapshot: &ModelOperationSnapshot) -> CliResult {
    let records = operation_records(snapshot);
    match snapshot.state {
        crate::model_operation::OperationState::Succeeded => {
            ok_records(command, records, json!({}))
        }
        crate::model_operation::OperationState::Failed => {
            error_records(command, "operation_failed", None, records, json!({}))
        }
        crate::model_operation::OperationState::Cancelled => {
            error_records(command, "operation_cancelled", None, records, json!({}))
        }
        _ => error_records(
            command,
            "internal_error",
            Some("Model Operation wait ended before a terminal state."),
            records,
            json!({}),
        ),
    }
}

fn batch_outcome_progress(outcome: &BatchItemOutcome) -> CliProgress {
    let mut records = vec![json!({
        "name": "batch_item",
        "fields": {
            "item_index": outcome.item_index,
            "model": outcome.model,
            "status": match outcome.status() {
                crate::model_operation::BatchItemStatus::Succeeded => "succeeded",
                crate::model_operation::BatchItemStatus::Failed => "failed",
            },
            "log": outcome.log,
        }
    })];
    records.extend(outcome.artifacts.iter().map(artifact_record));
    CliProgress {
        event: "batch_item.settled".to_owned(),
        records: typed_records(records),
    }
}

fn artifact_record(artifact: &crate::model_operation::ArtifactPointer) -> Value {
    json!({
        "name": "artifact",
        "fields": {
            "artifact_index": artifact.artifact_index,
            "output_path": artifact.output_path,
            "mime_type": artifact.mime_type,
            "width": artifact.width,
            "height": artifact.height,
        }
    })
}

fn parse_operation_state(value: &str) -> Result<OperationListState, CliFailure> {
    match value {
        "active" => Ok(OperationListState::Active),
        "terminal" => Ok(OperationListState::Terminal),
        "queued" => Ok(OperationListState::Queued),
        "running" => Ok(OperationListState::Running),
        "cancelling" => Ok(OperationListState::Cancelling),
        "succeeded" => Ok(OperationListState::Succeeded),
        "failed" => Ok(OperationListState::Failed),
        "cancelled" => Ok(OperationListState::Cancelled),
        _ => Err(CliFailure::new(
            "invalid_input",
            "--state is not a Model Operation state filter.",
        )),
    }
}

fn parse_model_kind(value: &str) -> Result<ModelKind, CliFailure> {
    match value {
        "image" => Ok(ModelKind::Image),
        "video" => Ok(ModelKind::Video),
        "tts" => Ok(ModelKind::Tts),
        "music" => Ok(ModelKind::Music),
        "sound-effect" => Ok(ModelKind::SoundEffect),
        _ => Err(CliFailure::new(
            "invalid_input",
            "--model-kind must be image, video, tts, music, or sound-effect.",
        )),
    }
}

fn model_kind_name(kind: ModelKind) -> &'static str {
    match kind {
        ModelKind::Image => "image",
        ModelKind::Video => "video",
        ModelKind::Tts => "tts",
        ModelKind::Music => "music",
        ModelKind::SoundEffect => "sound-effect",
    }
}

fn operation_state_name(state: crate::model_operation::OperationState) -> &'static str {
    match state {
        crate::model_operation::OperationState::Queued => "queued",
        crate::model_operation::OperationState::Running => "running",
        crate::model_operation::OperationState::Cancelling => "cancelling",
        crate::model_operation::OperationState::Succeeded => "succeeded",
        crate::model_operation::OperationState::Failed => "failed",
        crate::model_operation::OperationState::Cancelled => "cancelled",
    }
}

fn parse_timeout_seconds(value: &str) -> Result<u64, CliFailure> {
    let (digits, multiplier) = value
        .strip_suffix('s')
        .map(|digits| (digits, 1))
        .or_else(|| value.strip_suffix('m').map(|digits| (digits, 60)))
        .or_else(|| value.strip_suffix('h').map(|digits| (digits, 60 * 60)))
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                "--timeout must be a positive integer followed by s, m, or h.",
            )
        })?;
    let value = digits
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .and_then(|value| value.checked_mul(multiplier))
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                "--timeout must be a representable positive duration.",
            )
        })?;
    Ok(value)
}

fn bounded_usize(raw: &str, label: &str, maximum: usize) -> Result<usize, CliFailure> {
    raw.parse::<usize>()
        .ok()
        .filter(|value| *value > 0 && *value <= maximum)
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                format!("{label} must be an integer from 1 through {maximum}."),
            )
        })
}

fn operation_failure(error: crate::model_operation::ModelOperationError) -> CliFailure {
    CliFailure::new(
        error.code(),
        error.log().unwrap_or("Model Operation failed."),
    )
}

pub(super) fn project_failure(error: ProjectError) -> CliFailure {
    let code = error.code();
    let mut failure = CliFailure::new(code, error.to_string());
    for key in ["path", "project_relative_path"] {
        if let Some(value) = error.field(key) {
            failure.fields.insert(key.to_owned(), value.into());
        }
    }
    failure
}

pub(super) fn validate_project_root(root: &Path) -> Result<(), CliFailure> {
    let canonical = root.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CliFailure::new(
                "project_not_found",
                format!("Debrute Project root does not exist: {}", root.display()),
            )
        } else {
            CliFailure::new("project_invalid", error.to_string())
        }
        .with_field("path", root.to_string_lossy().into_owned())
    })?;
    if canonical.is_dir() {
        Ok(())
    } else {
        Err(CliFailure::new(
            "project_invalid",
            "Debrute Project root must be a directory.",
        )
        .with_field("path", root.to_string_lossy().into_owned()))
    }
}

pub(super) fn ok(command: &str, fields: Value) -> CliResult {
    CliResult::Ok {
        command: command.to_owned(),
        records: Vec::new(),
        fields: typed_fields(fields),
    }
}

fn ok_records(command: &str, records: Vec<Value>, fields: Value) -> CliResult {
    CliResult::Ok {
        command: command.to_owned(),
        records: typed_records(records),
        fields: typed_fields(fields),
    }
}

fn error_records(
    command: &str,
    code: &str,
    log: Option<&str>,
    records: Vec<Value>,
    fields: Value,
) -> CliResult {
    CliResult::Error {
        command: command.to_owned(),
        code: code.to_owned(),
        log: log.map(str::to_owned),
        records: typed_records(records),
        fields: typed_fields(fields),
    }
}

pub(super) fn failure_value(command: &str, failure: CliFailure) -> CliResult {
    CliResult::Error {
        command: command.to_owned(),
        code: failure.code,
        log: Some(failure.message),
        records: Vec::new(),
        fields: failure.fields,
    }
}

fn typed_fields(value: Value) -> CliFields {
    CliFields::try_from_value(&value).expect("CLI result fields must be primitive")
}

fn typed_records(records: Vec<Value>) -> Vec<CliRecord> {
    records
        .into_iter()
        .map(|record| {
            CliRecord::try_from_value(record).expect("CLI record must have the closed shape")
        })
        .collect()
}

#[cfg(test)]
mod operation_record_tests {
    use super::*;
    use crate::cli::agent_record;
    use crate::model_operation::{
        ModelOperationDiagnostic, ModelOperationExecution, OperationState,
    };

    fn snapshot(
        state: OperationState,
        execution: ModelOperationExecution,
    ) -> ModelOperationSnapshot {
        ModelOperationSnapshot {
            id: "operation-1".to_owned(),
            model_kind: ModelKind::Image,
            state,
            accepted_at: "2026-07-20T00:00:00Z".to_owned(),
            execution,
            log: (state == OperationState::Failed).then(|| "upstream failed".to_owned()),
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn terminal_result_uses_operation_state_not_batch_item_failures() {
        let batch = terminal_operation_result(
            "request.batch",
            &snapshot(
                OperationState::Succeeded,
                ModelOperationExecution::Batch {
                    item_count: 2,
                    concurrency: 1,
                    timeout_seconds: 600,
                    active: 0,
                    succeeded: 1,
                    failed: 1,
                },
            ),
        );
        let batch = serde_json::to_value(batch).unwrap();
        assert_eq!(batch["status"], "ok");

        let single = terminal_operation_result(
            "request.single",
            &snapshot(
                OperationState::Failed,
                ModelOperationExecution::Single {
                    model: "image-model".to_owned(),
                    timeout_seconds: 600,
                    artifacts: Vec::new(),
                },
            ),
        );
        let single = serde_json::to_value(single).unwrap();
        assert_eq!(single["status"], "error");
        assert_eq!(single["code"], "operation_failed");
        assert!(single.get("log").is_none());
        assert_eq!(single["records"][0]["fields"]["log"], "upstream failed");

        let cancelled = terminal_operation_result(
            "request.single",
            &snapshot(
                OperationState::Cancelled,
                ModelOperationExecution::Single {
                    model: "image-model".to_owned(),
                    timeout_seconds: 600,
                    artifacts: Vec::new(),
                },
            ),
        );
        let cancelled = serde_json::to_value(cancelled).unwrap();
        assert_eq!(cancelled["status"], "error");
        assert_eq!(cancelled["code"], "operation_cancelled");
        assert!(cancelled.get("log").is_none());
    }

    #[test]
    fn operation_records_expose_artifacts_and_provenance_warnings() {
        let mut snapshot = snapshot(
            OperationState::Succeeded,
            ModelOperationExecution::Single {
                model: "image-model".to_owned(),
                timeout_seconds: 600,
                artifacts: vec![crate::model_operation::ArtifactPointer {
                    artifact_index: 0,
                    output_path: "/project/generated/cover.jpg".to_owned(),
                    mime_type: "image/jpeg".to_owned(),
                    width: Some(1024),
                    height: Some(1024),
                }],
            },
        );
        snapshot.diagnostics.push(ModelOperationDiagnostic {
            code: "model_artifact_provenance_persistence_failed".to_owned(),
            message: "Model output was committed, but provenance could not be stored.".to_owned(),
            item_index: None,
        });

        let rendered = agent_record(&terminal_operation_result("request.single", &snapshot));
        assert!(rendered.contains(
            "diagnostic severity=warning code=model_artifact_provenance_persistence_failed"
        ));
        assert!(rendered.contains("output_path=/project/generated/cover.jpg"));
    }

    #[test]
    fn project_diagnostic_record_has_only_current_contract_fields() {
        let record = diagnostic_record(&ProjectDiagnostic {
            id: "diagnostic-1".to_owned(),
            severity: ProjectDiagnosticSeverity::Warning,
            code: "missing_asset".to_owned(),
            message: "Missing asset".to_owned(),
            file_path: Some("briefs/scene.md".to_owned()),
            line: None,
            column: None,
            entity_id: None,
        });

        assert_eq!(
            record,
            json!({"name": "diagnostic", "fields": {
                "id": "diagnostic-1",
                "severity": "warning",
                "code": "missing_asset",
                "message": "Missing asset",
                "path": "briefs/scene.md"
            }})
        );
    }
}
