#![allow(
    clippy::needless_pass_by_value,
    clippy::too_many_lines,
    clippy::unused_self
)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    generation::{GenerationCancellation, GenerationKind, GenerationRequest},
    global::AudioModelKind,
    project::{
        CanvasMapPathRuleSet, Diagnostic, DiagnosticSeverity, GeneratedAssetMetadataLookup,
        PROJECT_FILE, ProjectCommand, ProjectCommandResult, ProjectError, ProjectSnapshot,
        ProjectUseKind, open_no_symlink_existing_project_file,
    },
    workbench::{
        RuntimeCliHttpService, RuntimeCliRecordStream, RuntimeHttpServiceError,
        WorkbenchRuntimeServices,
    },
};

#[derive(Clone)]
pub struct RuntimeCliService {
    services: Arc<WorkbenchRuntimeServices>,
    active_product: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CliCommandRequest {
    pub(super) command: String,
    #[serde(default)]
    pub(super) positional: Vec<String>,
    #[serde(default)]
    pub(super) options: BTreeMap<String, String>,
    pub(super) project_root: Option<PathBuf>,
}

#[derive(Debug)]
pub(super) struct CliFailure {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) fields: Map<String, Value>,
}

impl CliFailure {
    pub(super) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            fields: Map::new(),
        }
    }

    pub(super) fn with_field(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.fields.insert(key.into(), value.into());
        self
    }
}

impl RuntimeCliService {
    #[must_use]
    pub fn new(services: Arc<WorkbenchRuntimeServices>) -> Self {
        Self {
            services,
            active_product: std::env::var_os("DEBRUTE_ACTIVE_PRODUCT_DIR").map(PathBuf::from),
        }
    }

    #[must_use]
    pub fn with_active_product(
        services: Arc<WorkbenchRuntimeServices>,
        active_product: Option<PathBuf>,
    ) -> Self {
        Self {
            services,
            active_product,
        }
    }

    fn run_command(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        match request.command.as_str() {
            "update" => self.update(request),
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
            "project.init" | "project.status" | "project.validate" => self.project_command(request),
            "canvas-map.push"
            | "canvas.create"
            | "canvas.rename"
            | "canvas.delete"
            | "canvas.reorder"
            | "canvas.repair-index"
            | "canvas.reset-layout" => self.canvas_command(request),
            "generated-asset.lookup" => self.generated_asset_lookup(request),
            "generate.image" => self.generate(request, GenerationKind::Image),
            "generate.video" => self.generate(request, GenerationKind::Video),
            "generate.tts" => self.generate(request, GenerationKind::Tts),
            "generate.music" => self.generate(request, GenerationKind::Music),
            "generate.sfx" => self.generate(request, GenerationKind::SoundEffect),
            "generate.image-batch" => Err(CliFailure::new(
                "invalid_command",
                "generate.image-batch requires the streaming CLI route.",
            )),
            _ => Err(CliFailure::new(
                "invalid_command",
                format!("Unsupported Runtime CLI command: {}", request.command),
            )),
        }
    }

    fn update(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        require_no_arguments(request)?;
        let result = self
            .services
            .product()
            .and_then(|service| {
                service.apply(&json!({}), crate::workbench::ProductUpdateInitiator::Cli)
            })
            .map_err(|error| CliFailure::new("product_update_failed", error.message))?;
        Ok(ok(
            &request.command,
            result.get("fields").cloned().unwrap_or(result),
        ))
    }

    fn runtime_status(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        require_no_arguments(request)?;
        let settings = self
            .services
            .global()
            .settings_get()
            .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))?;
        let models = self.services.models();
        let available_image = settings
            .models
            .image
            .models
            .iter()
            .filter(|model| model.api_key_set)
            .count();
        let available_video = settings
            .models
            .video
            .models
            .iter()
            .filter(|model| model.api_key_set)
            .count();
        let available_audio = settings
            .models
            .audio
            .models
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

    fn runtime_doctor(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let status = self.runtime_status(request)?;
        let fields = status
            .get("fields")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                CliFailure::new("internal_error", "Runtime status fields are unavailable.")
            })?;
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
            if fields.get(field).and_then(Value::as_u64) == Some(0) {
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

    fn skills_status(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
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

    fn list_image_models(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let configured = settings
            .models
            .image
            .models
            .iter()
            .filter(|model| model.api_key_set);
        let records = configured
            .filter_map(|setting| {
                self.services.models().images().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id)
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

    fn list_video_models(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let records = settings.models.video.models.iter()
            .filter(|model| model.api_key_set)
            .filter_map(|setting| self.services.models().videos().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id))
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
    ) -> Result<Value, CliFailure> {
        require_no_arguments(request)?;
        let settings = self.settings()?;
        let records = settings.models.audio.models.iter()
            .filter(|model| model.api_key_set && model.kind == kind)
            .filter_map(|setting| self.services.models().audio().iter().find(|entry| entry.debrute_model_id == setting.debrute_model_id && entry.kind == kind))
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

    fn describe_image_model(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .services
            .models()
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

    fn describe_video_model(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .services
            .models()
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
    ) -> Result<Value, CliFailure> {
        let model_id = one_positional(request)?;
        let entry = self
            .services
            .models()
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

    fn project_command(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let root = required_project_root(request)?;
        if request.command != "project.init" {
            ensure_project_initialized(root)?;
        }
        let opened = self.open_project(root)?;
        let sync = opened.session.sync_snapshot().map_err(project_failure)?;
        let snapshot = sync.snapshot;
        if request.command == "project.validate" && snapshot.health.diagnostic_counts.errors > 0 {
            return Ok(error_records(
                &request.command,
                "project_validation_failed",
                "Project validation failed.",
                diagnostic_records(&snapshot),
                diagnostic_count_fields(&snapshot),
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

    fn canvas_command(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let root = required_project_root(request)?;
        ensure_project_initialized(root)?;
        let opened = self.open_project(root)?;
        let command = project_mutation(request)?;
        let result = opened.session.execute(command).map_err(project_failure)?;
        let fields = match result.value {
            ProjectCommandResult::CanvasCreated { canvas_id, .. } => {
                json!({"active_canvas": canvas_id})
            }
            ProjectCommandResult::CanvasDeleted {
                active_canvas_id, ..
            }
            | ProjectCommandResult::CanvasRegistryRepaired {
                active_canvas_id, ..
            } => json!({"active_canvas": active_canvas_id}),
            ProjectCommandResult::CanvasLayoutReset { reset_count, .. } => json!({
                "canvas": request.positional.get(1).cloned().unwrap_or_default(),
                "mode": if request.options.get("all").is_some_and(|value| value == "true") { "all" } else { "paths" },
                "reset": reset_count
            }),
            _ if request.command == "canvas-map.push" => json!({
                "canvas": request.positional.get(1).cloned().unwrap_or_default()
            }),
            _ => json!({}),
        };
        Ok(ok(&request.command, fields))
    }

    fn generated_asset_lookup(&self, request: &CliCommandRequest) -> Result<Value, CliFailure> {
        let root = required_project_root(request)?;
        ensure_project_initialized(root)?;
        let _opened = self.open_project(root)?;
        let path = request
            .options
            .get("path")
            .filter(|path| !path.is_empty())
            .ok_or_else(|| CliFailure::new("missing_argument", "--path is required."))?;
        let lookup = self
            .services
            .generation()
            .generated_assets()
            .lookup(root, path)
            .map_err(project_failure)?;
        Ok(ok(&request.command, generated_asset_fields(&lookup)))
    }

    fn generate(
        &self,
        request: &CliCommandRequest,
        kind: GenerationKind,
    ) -> Result<Value, CliFailure> {
        let root = required_project_root(request)?;
        ensure_project_initialized(root)?;
        let _opened = self.open_project(root)?;
        let generation_request = generation_request(request)?;
        match self.services.generation().execute(
            root,
            kind,
            &generation_request,
            &GenerationCancellation::default(),
        ) {
            Ok(success) => {
                let records = success
                    .artifacts
                    .iter()
                    .map(|artifact| {
                        json!({
                            "name": "artifact",
                            "fields": {
                                "id": artifact.artifact_id,
                                "path": artifact.project_relative_path,
                                "title": artifact.title,
                                "mime": artifact.mime_type,
                                "width": artifact.width,
                                "height": artifact.height
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(ok_records(
                    &request.command,
                    records,
                    json!({
                        "content": success.content,
                        "model": success.model,
                        "artifacts": success.artifacts.len()
                    }),
                ))
            }
            Err(error) => Ok(error_value(
                &request.command,
                normalize_generation_error(kind, error.code()),
                error.message(),
                json!({}),
            )),
        }
    }

    fn settings(&self) -> Result<crate::global::DebruteGlobalSettingsView, CliFailure> {
        self.services
            .global()
            .settings_get()
            .map_err(|error| CliFailure::new("runtime_config_error", error.to_string()))
    }

    fn open_project(&self, root: &Path) -> Result<crate::project::OpenProjectSession, CliFailure> {
        self.services
            .projects()
            .open_project(root, ProjectUseKind::Operation)
            .map_err(project_failure)
    }
}

impl RuntimeCliHttpService for RuntimeCliService {
    fn run(&self, request: &Value) -> Result<Value, RuntimeHttpServiceError> {
        let request = parse_request(request)?;
        Ok(match self.run_command(&request) {
            Ok(result) => result,
            Err(failure) => failure_value(&request.command, failure),
        })
    }

    fn run_stream(
        &self,
        request: &Value,
    ) -> Result<RuntimeCliRecordStream, RuntimeHttpServiceError> {
        let request = parse_request(request)?;
        if request.command != "generate.image-batch" {
            return Err(RuntimeHttpServiceError::new(
                400,
                "cli_stream_command_invalid",
                "Only generate.image-batch uses the Runtime CLI stream.",
            ));
        }
        let (sender, stream) = RuntimeCliRecordStream::bounded(64);
        let services = Arc::clone(&self.services);
        std::thread::Builder::new()
            .name("debrute-cli-image-batch".to_owned())
            .spawn(move || {
                let result = match super::batch::run_image_batch(services, &request, &sender) {
                    Ok(result) => result,
                    Err(failure) => failure_value(&request.command, failure),
                };
                let _ = sender.blocking_send(json!({
                    "type": "result",
                    "result": result
                }));
            })
            .map_err(|error| {
                RuntimeHttpServiceError::new(500, "cli_stream_unavailable", error.to_string())
            })?;
        Ok(stream)
    }
}

fn parse_request(request: &Value) -> Result<CliCommandRequest, RuntimeHttpServiceError> {
    serde_json::from_value(request.clone()).map_err(|error| {
        RuntimeHttpServiceError::new(400, "cli_request_invalid", error.to_string())
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

fn required_project_root(request: &CliCommandRequest) -> Result<&Path, CliFailure> {
    request.project_root.as_deref().ok_or_else(|| {
        CliFailure::new(
            "missing_argument",
            format!("{} requires projectRoot.", request.command),
        )
    })
}

fn generation_request(request: &CliCommandRequest) -> Result<GenerationRequest, CliFailure> {
    let raw = request
        .options
        .get("input-json")
        .ok_or_else(|| CliFailure::new("missing_argument", "--input-json is required."))?;
    let mut input = serde_json::from_str::<Value>(raw)
        .map_err(|_| CliFailure::new("invalid_json_input", "--input-json must be valid JSON."))?;
    let object = input.as_object_mut().ok_or_else(|| {
        CliFailure::new("invalid_json_input", "--input-json must be a JSON object.")
    })?;
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                "--input-json requires string field \"model\".",
            )
        })?
        .to_owned();
    let arguments = object
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                "--input-json requires object field \"arguments\".",
            )
        })?
        .clone();
    let timeout_ms = if let Some(raw) = request.options.get("timeout-ms") {
        Some(positive_u64(raw, "--timeout-ms")?)
    } else {
        object
            .get("timeoutMs")
            .map(|value| {
                value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
                    CliFailure::new(
                        "invalid_input",
                        "input-json.timeoutMs must be a positive integer.",
                    )
                })
            })
            .transpose()?
    };
    Ok(GenerationRequest {
        model,
        arguments,
        timeout_ms,
    })
}

pub(super) fn positive_u64(raw: &str, label: &str) -> Result<u64, CliFailure> {
    raw.parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_input",
                format!("{label} must be a positive integer."),
            )
        })
}

fn project_mutation(request: &CliCommandRequest) -> Result<ProjectCommand, CliFailure> {
    match request.command.as_str() {
        "canvas-map.push" => Ok(ProjectCommand::PushCanvasMap {
            canvas_id: positional(request, 1)?,
        }),
        "canvas.create" => Ok(ProjectCommand::CreateCanvas),
        "canvas.rename" => Ok(ProjectCommand::RenameCanvas {
            canvas_id: positional(request, 1)?,
            name: positional(request, 2)?,
        }),
        "canvas.delete" => Ok(ProjectCommand::DeleteCanvas {
            canvas_id: positional(request, 1)?,
        }),
        "canvas.reorder" => {
            if request.positional.len() < 2 {
                return Err(CliFailure::new(
                    "missing_argument",
                    "canvas.reorder requires at least one Canvas id.",
                ));
            }
            Ok(ProjectCommand::ReorderCanvases {
                order: request.positional[1..].to_vec(),
            })
        }
        "canvas.repair-index" => Ok(ProjectCommand::RepairCanvasRegistry),
        "canvas.reset-layout" => {
            let all = request
                .options
                .get("all")
                .is_some_and(|value| value == "true");
            let paths = string_array_option(request, "path")?;
            let globs = string_array_option(request, "glob")?;
            if all == (!paths.is_empty() || !globs.is_empty()) {
                return Err(CliFailure::new(
                    "invalid_input",
                    "canvas.reset-layout requires --all or at least one --path/--glob.",
                ));
            }
            Ok(ProjectCommand::ResetCanvasLayout {
                canvas_id: positional(request, 1)?,
                rules: (!all).then_some(CanvasMapPathRuleSet { paths, globs }),
            })
        }
        _ => Err(CliFailure::new(
            "invalid_command",
            "Unsupported Canvas command.",
        )),
    }
}

fn positional(request: &CliCommandRequest, index: usize) -> Result<String, CliFailure> {
    request.positional.get(index).cloned().ok_or_else(|| {
        CliFailure::new(
            "missing_argument",
            format!("{} requires more arguments.", request.command),
        )
    })
}

fn string_array_option(request: &CliCommandRequest, key: &str) -> Result<Vec<String>, CliFailure> {
    request.options.get(key).map_or_else(
        || Ok(Vec::new()),
        |value| {
            serde_json::from_str(value).map_err(|_| {
                CliFailure::new(
                    "invalid_input",
                    format!("--{key} must be one or more strings."),
                )
            })
        },
    )
}

fn model_detail(
    command: &str,
    model_id: &str,
    kind: Option<&str>,
    summary: &str,
    capabilities: &Value,
    arguments_schema: &Value,
    documentation: &super::model_docs::ModelDocumentation,
) -> Value {
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
    let mut fields = diagnostic_count_fields(snapshot)
        .as_object()
        .cloned()
        .unwrap_or_default();
    fields.insert(
        "project_root".to_owned(),
        Value::String(snapshot.project_root.clone()),
    );
    fields.insert(
        "project_name".to_owned(),
        Value::String(snapshot.health.project_name.clone()),
    );
    fields.insert(
        "canvases".to_owned(),
        Value::from(snapshot.health.canvas_count),
    );
    Value::Object(fields)
}

fn diagnostic_count_fields(snapshot: &ProjectSnapshot) -> Value {
    json!({
        "errors": snapshot.health.diagnostic_counts.errors,
        "warnings": snapshot.health.diagnostic_counts.warnings,
        "infos": snapshot.health.diagnostic_counts.infos
    })
}

fn diagnostic_records(snapshot: &ProjectSnapshot) -> Vec<Value> {
    snapshot.diagnostics.iter().map(diagnostic_record).collect()
}

fn diagnostic_record(diagnostic: &Diagnostic) -> Value {
    let source = serde_json::to_value(&diagnostic.source).expect("diagnostic source serializes");
    let severity = match diagnostic.severity {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Info => "info",
    };
    json!({"name": "diagnostic", "fields": {
        "id": diagnostic.id,
        "source": source,
        "severity": severity,
        "code": diagnostic.code,
        "message": diagnostic.message,
        "path": diagnostic.file_path
    }})
}

fn generated_asset_fields(lookup: &GeneratedAssetMetadataLookup) -> Value {
    match lookup {
        GeneratedAssetMetadataLookup::Matched {
            fingerprint,
            records,
            ..
        } => json!({
            "status": "matched", "hash": fingerprint.hash, "records": records.len(),
            "metadata": serde_json::to_string(lookup).expect("lookup serializes")
        }),
        GeneratedAssetMetadataLookup::Unmatched { fingerprint, .. } => json!({
            "status": "unmatched", "hash": fingerprint.hash, "records": 0,
            "metadata": serde_json::to_string(lookup).expect("lookup serializes")
        }),
        GeneratedAssetMetadataLookup::Unavailable {
            reason, message, ..
        } => json!({
            "status": "unavailable",
            "reason": serde_json::to_value(reason).expect("reason serializes"),
            "message": message
        }),
    }
}

fn audio_kind_name(kind: AudioModelKind) -> &'static str {
    match kind {
        AudioModelKind::Tts => "tts",
        AudioModelKind::Music => "music",
        AudioModelKind::SoundEffect => "sound-effect",
    }
}

pub(super) fn normalize_generation_error(kind: GenerationKind, code: &str) -> &str {
    let audio = matches!(
        kind,
        GenerationKind::Tts | GenerationKind::Music | GenerationKind::SoundEffect
    );
    match code {
        "model_configuration_invalid" | "global_settings_unavailable" => "runtime_config_error",
        "model_unavailable" if audio => "audio_model_unavailable",
        "model_not_configured" if audio => "audio_model_not_configured",
        "generation_timeout" if audio => "audio_task_timeout",
        "generation_input_invalid" | "model_request_invalid" if audio => "audio_argument_invalid",
        "model_request_failed" | "model_response_failed" | "model_response_invalid" if audio => {
            "audio_request_failed"
        }
        "invalid_image_input"
        | "video_argument_invalid"
        | "generation_timeout_invalid"
        | "generation_input_invalid"
        | "model_request_invalid"
        | "remote_media_url_invalid"
        | "remote_media_dns_failed"
        | "remote_media_redirect_invalid" => "invalid_input",
        "image_request_failed"
        | "video_request_failed"
        | "request_failed"
        | "response_parse_failed"
        | "model_response_failed"
        | "model_response_invalid"
        | "generation_timeout" => "model_request_failed",
        other => other,
    }
}

pub(super) fn project_failure(error: ProjectError) -> CliFailure {
    let code = error.code();
    let mut failure = CliFailure::new(code, error.to_string());
    for key in ["path", "canvas_id", "project_relative_path"] {
        if let Some(value) = error.field(key) {
            failure
                .fields
                .insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    failure
}

pub(super) fn ensure_project_initialized(root: &Path) -> Result<(), CliFailure> {
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
    match open_no_symlink_existing_project_file(&canonical, PROJECT_FILE) {
        Ok(_) => Ok(()),
        Err(ProjectError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(CliFailure::new(
                "project_not_found",
                "Debrute Project metadata was not found.",
            )
            .with_field("path", root.to_string_lossy().into_owned()))
        }
        Err(error) => Err(project_failure(error)),
    }
}

pub(super) fn ok(command: &str, fields: Value) -> Value {
    json!({"status": "ok", "command": command, "fields": primitive_object(fields)})
}

fn ok_records(command: &str, records: Vec<Value>, fields: Value) -> Value {
    json!({"status": "ok", "command": command, "records": records, "fields": primitive_object(fields)})
}

fn error_records(
    command: &str,
    code: &str,
    message: &str,
    records: Vec<Value>,
    fields: Value,
) -> Value {
    json!({
        "status": "error", "command": command, "code": code, "message": message,
        "records": records, "fields": primitive_object(fields)
    })
}

pub(super) fn failure_value(command: &str, failure: CliFailure) -> Value {
    error_value(
        command,
        &failure.code,
        &failure.message,
        Value::Object(failure.fields),
    )
}

fn error_value(command: &str, code: &str, message: &str, fields: Value) -> Value {
    json!({
        "status": "error", "command": command, "code": code, "message": message,
        "fields": primitive_object(fields)
    })
}

fn primitive_object(value: Value) -> Value {
    Value::Object(value.as_object().map_or_else(Map::new, |object| {
        object
            .iter()
            .filter(|(_, value)| {
                matches!(
                    value,
                    Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
                )
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }))
}
