use std::{collections::BTreeMap, path::Path, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::project::{
    GeneratedArtifactRole, GeneratedAssetMetadataService, GeneratedModelRun, ProjectCapabilityFs,
    RecordGeneratedAssetInput, assert_project_tree_visible_mutation_path,
    assert_project_tree_visible_path, project_content_type,
};

use super::{
    http::validate_public_url,
    redaction::redact_model_run_value,
    types::{
        GeneratedPayload, GenerationArtifact, GenerationCancellation, GenerationDeadline,
        GenerationError, HttpBody, HttpMethod, HttpTargetPolicy, ModelExecution, ModelHttpRequest,
        ModelHttpResponse, ModelHttpTransport, ResolvedGenerationModel,
    },
};

pub(crate) const DEFAULT_GENERATION_TIMEOUT: Duration = Duration::from_mins(10);
pub(crate) const MAX_MODEL_JSON_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_GENERATED_MEDIA_BYTES: usize = 256 * 1024 * 1024;
const MAX_GENERATED_MEDIA_TOTAL_BYTES: usize = 512 * 1024 * 1024;
const MAX_GENERATED_ARTIFACTS: usize = 16;
const MAX_INPUT_MEDIA_BYTES: usize = 64 * 1024 * 1024;
const MAX_MODEL_RUN_RESPONSE_LOGS: usize = 64;
const MAX_MODEL_RUN_RESPONSE_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION: u32 = 50_000;
const MAX_GENERATED_IMAGE_ALLOCATION: u64 = 64 * 1024 * 1024;

pub(crate) struct ExecutionContext<'a> {
    pub model: &'a ResolvedGenerationModel,
    pub arguments: &'a Map<String, Value>,
    pub project_root: &'a Path,
    pub cancellation: &'a GenerationCancellation,
    pub transport: &'a dyn ModelHttpTransport,
    deadline: GenerationDeadline,
    pub safe_responses: Vec<Value>,
    pub logs: Vec<Value>,
    generated_media_bytes: usize,
    response_log_bytes: usize,
    response_log_truncated: bool,
}

impl<'a> ExecutionContext<'a> {
    pub(crate) fn new(
        model: &'a ResolvedGenerationModel,
        arguments: &'a Map<String, Value>,
        project_root: &'a Path,
        cancellation: &'a GenerationCancellation,
        transport: &'a dyn ModelHttpTransport,
        deadline: GenerationDeadline,
    ) -> Result<Self, GenerationError> {
        deadline.remaining(cancellation)?;
        Ok(Self {
            model,
            arguments,
            project_root,
            cancellation,
            transport,
            deadline,
            safe_responses: Vec::new(),
            logs: Vec::new(),
            generated_media_bytes: 0,
            response_log_bytes: 0,
            response_log_truncated: false,
        })
    }

    pub(crate) fn remaining(&self) -> Result<Duration, GenerationError> {
        self.deadline.remaining(self.cancellation)
    }

    pub(crate) fn sleep(&self, duration: Duration) -> Result<(), GenerationError> {
        let remaining = self.remaining()?;
        let until = std::time::Instant::now() + duration.min(remaining);
        while std::time::Instant::now() < until {
            self.cancellation.check()?;
            std::thread::sleep(
                until
                    .saturating_duration_since(std::time::Instant::now())
                    .min(Duration::from_millis(50)),
            );
        }
        self.remaining().map(|_| ())
    }

    pub(crate) fn json(
        &mut self,
        method: HttpMethod,
        url: String,
        headers: BTreeMap<String, String>,
        body: HttpBody,
    ) -> Result<Value, GenerationError> {
        let response = self.request(
            method,
            url,
            headers,
            body,
            MAX_MODEL_JSON_BYTES,
            HttpTargetPolicy::ModelEndpoint,
        )?;
        let parsed = if response.body.is_empty() {
            Value::Object(Map::new())
        } else {
            serde_json::from_slice(&response.body).map_err(|error| {
                GenerationError::new(
                    "model_response_invalid",
                    format!("Model response was not valid JSON: {error}"),
                )
            })?
        };
        self.push_response_log(response_log(&response, &parsed));
        if !(200..300).contains(&response.status) {
            return Err(GenerationError::new(
                "model_request_failed",
                format!("Model endpoint returned HTTP {}.", response.status),
            )
            .with_details(serde_json::json!({
                "status": response.status,
                "body": summarize_json(&parsed),
            })));
        }
        Ok(parsed)
    }

    pub(crate) fn bytes(
        &mut self,
        method: HttpMethod,
        url: String,
        headers: BTreeMap<String, String>,
        body: HttpBody,
    ) -> Result<ModelHttpResponse, GenerationError> {
        let response = self.request(
            method,
            url,
            headers,
            body,
            MAX_GENERATED_MEDIA_BYTES,
            HttpTargetPolicy::ModelEndpoint,
        )?;
        self.push_response_log(serde_json::json!({
            "status": response.status,
            "headers": safe_response_headers(&response.headers),
            "body": {"bytes": response.body.len()},
        }));
        if !(200..300).contains(&response.status) {
            return Err(GenerationError::new(
                "model_request_failed",
                format!("Model endpoint returned HTTP {}.", response.status),
            ));
        }
        self.record_generated_media(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn download(&mut self, url: &str) -> Result<ModelHttpResponse, GenerationError> {
        let response = self.request(
            HttpMethod::Get,
            url.to_owned(),
            BTreeMap::new(),
            HttpBody::Empty,
            MAX_GENERATED_MEDIA_BYTES,
            HttpTargetPolicy::PublicMedia,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(GenerationError::new(
                "generated_artifact_download_failed",
                format!(
                    "Generated artifact download returned HTTP {}.",
                    response.status
                ),
            ));
        }
        self.record_generated_media(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn resolve_media_reference(
        &self,
        reference: &str,
    ) -> Result<String, GenerationError> {
        let resolved = resolve_media_reference_value(self.project_root, reference)?;
        if resolved.starts_with("http://") || resolved.starts_with("https://") {
            validate_public_url(&resolved, self.cancellation, self.deadline)?;
        }
        Ok(resolved)
    }

    fn request(
        &self,
        method: HttpMethod,
        url: String,
        headers: BTreeMap<String, String>,
        body: HttpBody,
        maximum_response_bytes: usize,
        target_policy: HttpTargetPolicy,
    ) -> Result<ModelHttpResponse, GenerationError> {
        self.transport.execute(
            ModelHttpRequest {
                method,
                url,
                headers,
                body,
                maximum_response_bytes,
                target_policy,
            },
            self.cancellation,
            self.deadline,
        )
    }

    fn push_response_log(&mut self, value: Value) {
        push_bounded_response_log(
            &mut self.safe_responses,
            &mut self.response_log_bytes,
            &mut self.response_log_truncated,
            value,
        );
    }

    fn record_generated_media(&mut self, bytes: usize) -> Result<(), GenerationError> {
        self.generated_media_bytes =
            self.generated_media_bytes
                .checked_add(bytes)
                .ok_or_else(|| {
                    GenerationError::new(
                        "model_response_too_large",
                        "Generated media total overflowed its size bound.",
                    )
                })?;
        if self.generated_media_bytes > MAX_GENERATED_MEDIA_TOTAL_BYTES {
            return Err(GenerationError::new(
                "model_response_too_large",
                format!(
                    "Generated media exceeds the {MAX_GENERATED_MEDIA_TOTAL_BYTES}-byte command limit."
                ),
            ));
        }
        Ok(())
    }
}

fn push_bounded_response_log(
    responses: &mut Vec<Value>,
    response_bytes: &mut usize,
    truncated: &mut bool,
    value: Value,
) {
    let bytes = serde_json::to_vec(&value).map_or(0, |bytes| bytes.len());
    if responses.len() < MAX_MODEL_RUN_RESPONSE_LOGS
        && response_bytes.saturating_add(bytes) <= MAX_MODEL_RUN_RESPONSE_LOG_BYTES
    {
        *response_bytes = response_bytes.saturating_add(bytes);
        responses.push(value);
    } else if !*truncated {
        *truncated = true;
        responses.push(serde_json::json!({
            "truncated": true,
            "reason": "model-run response log limit reached"
        }));
    }
}

pub(crate) fn execute_result(
    payloads: Vec<GeneratedPayload>,
    safe_request: Value,
    context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    if payloads.is_empty() {
        return Err(GenerationError::new(
            "model_response_invalid",
            "Model response did not include generated media.",
        ));
    }
    validate_generated_artifact_count(payloads.len())?;
    let total = payloads
        .iter()
        .try_fold(0_usize, |total, payload| {
            total.checked_add(payload.bytes.len())
        })
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_too_large",
                "Generated artifact total overflowed its size bound.",
            )
        })?;
    if total > MAX_GENERATED_MEDIA_TOTAL_BYTES {
        return Err(GenerationError::new(
            "model_response_too_large",
            format!(
                "Generated artifacts exceed the {MAX_GENERATED_MEDIA_TOTAL_BYTES}-byte command limit."
            ),
        ));
    }
    Ok(ModelExecution {
        payloads,
        safe_request,
        safe_responses: context.safe_responses,
        logs: context.logs,
    })
}

pub(crate) fn validate_generated_artifact_count(count: usize) -> Result<(), GenerationError> {
    if count > MAX_GENERATED_ARTIFACTS {
        Err(GenerationError::new(
            "model_response_too_large",
            format!("Model returned more than {MAX_GENERATED_ARTIFACTS} artifacts."),
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_arguments(
    model_id: &str,
    schema: &Value,
    arguments: &Map<String, Value>,
) -> Result<(), GenerationError> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            GenerationError::new(
                "model_catalog_invalid",
                format!("Model {model_id} has no arguments properties."),
            )
        })?;
    for key in arguments.keys() {
        if !properties.contains_key(key) {
            return Err(GenerationError::new(
                "generation_argument_invalid",
                format!("Unsupported generation argument for {model_id}: {key}."),
            ));
        }
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            let missing = arguments.get(key).is_none_or(|value| {
                value.is_null() || value.as_str().is_some_and(|value| value.trim().is_empty())
            });
            if missing {
                return Err(GenerationError::new(
                    "generation_argument_invalid",
                    format!("Model {model_id} requires argument: {key}."),
                ));
            }
        }
    }
    for (key, value) in arguments {
        validate_argument_schema(model_id, key, value, &properties[key])?;
    }
    Ok(())
}

fn validate_argument_schema(
    model_id: &str,
    path: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), GenerationError> {
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array)
        && !branches
            .iter()
            .any(|branch| validate_argument_schema(model_id, path, value, branch).is_ok())
    {
        return invalid_argument(model_id, path, "does not match any supported shape");
    }
    if let Some(branches) = schema.get("oneOf").and_then(Value::as_array)
        && branches
            .iter()
            .filter(|branch| validate_argument_schema(model_id, path, value, branch).is_ok())
            .count()
            != 1
    {
        return invalid_argument(model_id, path, "does not match exactly one supported shape");
    }
    let type_matches = |kind: &str| match kind {
        "null" => value.is_null(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    };
    let valid = match schema.get("type") {
        Some(Value::String(kind)) => type_matches(kind),
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).any(type_matches),
        None => true,
        _ => false,
    };
    if !valid {
        return invalid_argument(model_id, path, "has the wrong type");
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array)
        && !values.contains(value)
    {
        return invalid_argument(model_id, path, "is not supported");
    }
    if let Some(constant) = schema.get("const")
        && constant != value
    {
        return invalid_argument(model_id, path, "does not match the required value");
    }
    validate_string_constraint(model_id, path, value, schema)?;
    validate_number_constraint(model_id, path, value, schema)?;
    validate_nested_constraint(model_id, path, value, schema)?;
    Ok(())
}

fn validate_string_constraint(
    model_id: &str,
    path: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), GenerationError> {
    if let Some(string) = value.as_str()
        && let Some(pattern) = schema.get("pattern").and_then(Value::as_str)
    {
        let pattern = regex::Regex::new(pattern).map_err(|error| {
            GenerationError::new(
                "model_catalog_invalid",
                format!("Model {model_id} argument {path} has an invalid pattern: {error}"),
            )
        })?;
        if !pattern.is_match(string) {
            return invalid_argument(model_id, path, "does not match the required format");
        }
    }
    Ok(())
}

fn validate_number_constraint(
    model_id: &str,
    path: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), GenerationError> {
    if let Some(number) = value.as_f64() {
        if schema
            .get("minimum")
            .and_then(Value::as_f64)
            .is_some_and(|minimum| number < minimum)
        {
            return invalid_argument(model_id, path, "is below the supported minimum");
        }
        if schema
            .get("maximum")
            .and_then(Value::as_f64)
            .is_some_and(|maximum| number > maximum)
        {
            return invalid_argument(model_id, path, "exceeds the supported maximum");
        }
    }
    Ok(())
}

fn validate_nested_constraint(
    model_id: &str,
    path: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), GenerationError> {
    if let Some(items) = value.as_array()
        && let Some(item_schema) = schema.get("items")
    {
        for (index, item) in items.iter().enumerate() {
            validate_argument_schema(model_id, &format!("{path}[{index}]"), item, item_schema)?;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if object.get(key).is_none_or(Value::is_null) {
                    return invalid_argument(model_id, &format!("{path}.{key}"), "is required");
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        if schema.get("additionalProperties") == Some(&Value::Bool(false))
            && let Some(unsupported) = object
                .keys()
                .find(|key| properties.is_none_or(|properties| !properties.contains_key(*key)))
        {
            return invalid_argument(
                model_id,
                &format!("{path}.{unsupported}"),
                "is not supported",
            );
        }
        if let Some(properties) = properties {
            for (key, child) in object {
                if let Some(child_schema) = properties.get(key) {
                    validate_argument_schema(
                        model_id,
                        &format!("{path}.{key}"),
                        child,
                        child_schema,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn invalid_argument<T>(model_id: &str, path: &str, reason: &str) -> Result<T, GenerationError> {
    Err(GenerationError::new(
        "generation_argument_invalid",
        format!("Generation argument {path} {reason} for {model_id}."),
    ))
}

pub(crate) fn authorization(api_key: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("authorization".to_owned(), format!("Bearer {api_key}")),
        ("content-type".to_owned(), "application/json".to_owned()),
    ])
}

pub(crate) fn join_url(base: &str, suffix: &str) -> Result<String, GenerationError> {
    let base = format!("{}/", base.trim_end_matches('/'));
    url::Url::parse(&base)
        .and_then(|url| url.join(suffix.trim_start_matches('/')))
        .map(String::from)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))
}

pub(crate) fn required_string(value: &Value, pointer: &str) -> Result<String, GenerationError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                format!("Model response omitted {pointer}."),
            )
        })
}

pub(crate) fn decode_base64(value: &str, label: &str) -> Result<Vec<u8>, GenerationError> {
    if value.len() > MAX_GENERATED_MEDIA_BYTES.saturating_mul(4) / 3 + 8 {
        return Err(GenerationError::new(
            "model_response_too_large",
            format!("{label} exceeds the generated-media limit."),
        ));
    }
    let bytes = BASE64.decode(value).map_err(|error| {
        GenerationError::new(
            "model_response_invalid",
            format!("{label} is not valid base64: {error}"),
        )
    })?;
    if bytes.len() > MAX_GENERATED_MEDIA_BYTES {
        return Err(GenerationError::new(
            "model_response_too_large",
            format!("{label} exceeds the generated-media limit."),
        ));
    }
    Ok(bytes)
}

fn resolve_media_reference_value(
    project_root: &Path,
    reference: &str,
) -> Result<String, GenerationError> {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return Ok(reference.to_owned());
    }
    if reference.starts_with("data:") {
        decode_data_url(reference, MAX_INPUT_MEDIA_BYTES)?;
        return Ok(reference.to_owned());
    }
    let path = assert_project_tree_visible_path(reference)?;
    let bytes =
        ProjectCapabilityFs::open(project_root)?.read_limited(&path, MAX_INPUT_MEDIA_BYTES)?;
    let mime = mime_from_path_or_bytes(&path, &bytes).ok_or_else(|| {
        GenerationError::new(
            "generation_input_invalid",
            format!("Project media input has an unsupported type: {path}"),
        )
    })?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

pub(crate) fn decode_data_url(
    value: &str,
    maximum_bytes: usize,
) -> Result<(String, Vec<u8>), GenerationError> {
    let (metadata, encoded) = value.split_once(',').ok_or_else(|| {
        GenerationError::new("generation_input_invalid", "Media data URL is malformed.")
    })?;
    let mime = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "generation_input_invalid",
                "Media data URL must contain base64 bytes and a MIME type.",
            )
        })?;
    if encoded.len() > maximum_bytes.saturating_mul(4) / 3 + 8 {
        return Err(GenerationError::new(
            "generation_input_too_large",
            "Media data URL exceeds the input limit.",
        ));
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| GenerationError::new("generation_input_invalid", error.to_string()))?;
    if bytes.len() > maximum_bytes {
        return Err(GenerationError::new(
            "generation_input_too_large",
            "Media data URL exceeds the input limit.",
        ));
    }
    Ok((mime.to_owned(), bytes))
}

pub(crate) fn mime_from_response(response: &ModelHttpResponse) -> Option<String> {
    response
        .headers
        .get("content-type")
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

pub(crate) fn mime_from_path_or_bytes(path: &str, bytes: &[u8]) -> Option<&'static str> {
    let path = path.split('?').next().unwrap_or(path);
    let registered = project_content_type(path)
        .split(';')
        .next()
        .unwrap_or_default();
    if registered.starts_with("image/")
        || registered.starts_with("video/")
        || registered.starts_with("audio/")
    {
        Some(registered)
    } else if extension_eq(path, "png") || bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if extension_eq(path, "jpg")
        || extension_eq(path, "jpeg")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
    {
        Some("image/jpeg")
    } else if extension_eq(path, "webp")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
    {
        Some("image/webp")
    } else if extension_eq(path, "mp4") {
        Some("video/mp4")
    } else if extension_eq(path, "wav") || bytes.starts_with(b"RIFF") {
        Some("audio/wav")
    } else if extension_eq(path, "mp3") || bytes.starts_with(b"ID3") {
        Some("audio/mpeg")
    } else if extension_eq(path, "ogg") || bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if extension_eq(path, "flac") || bytes.starts_with(b"fLaC") {
        Some("audio/flac")
    } else if extension_eq(path, "aac") {
        Some("audio/aac")
    } else {
        None
    }
}

fn extension_eq(path: &str, expected: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

pub(crate) fn extension_for_mime(mime: &str) -> Result<&'static str, GenerationError> {
    match mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Ok("png"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/avif" => Ok("avif"),
        "image/tiff" => Ok("tiff"),
        "image/svg+xml" => Ok("svg"),
        "video/mp4" => Ok("mp4"),
        "audio/mpeg" | "audio/mp3" => Ok("mp3"),
        "audio/wav" | "audio/x-wav" => Ok("wav"),
        "audio/ogg" => Ok("ogg"),
        "audio/flac" => Ok("flac"),
        "audio/aac" => Ok("aac"),
        "audio/pcm" | "audio/l16" => Ok("pcm"),
        value => Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated artifact MIME type is unsupported: {value}"),
        )),
    }
}

pub(crate) struct GenerationControl<'a> {
    cancellation: &'a GenerationCancellation,
    deadline: GenerationDeadline,
}

impl<'a> GenerationControl<'a> {
    pub(crate) fn new(
        cancellation: &'a GenerationCancellation,
        deadline: GenerationDeadline,
    ) -> Self {
        Self {
            cancellation,
            deadline,
        }
    }

    fn check(&self) -> Result<(), GenerationError> {
        self.deadline.remaining(self.cancellation).map(|_| ())
    }
}

pub(crate) fn store_execution(
    project_root: &Path,
    invocation_id: &str,
    arguments: &Map<String, Value>,
    execution: ModelExecution,
    metadata: &GeneratedAssetMetadataService,
    configured_secrets: &[String],
    control: &GenerationControl<'_>,
) -> Result<(Vec<GenerationArtifact>, Vec<Value>), GenerationError> {
    control.check()?;
    let model_run_id = Uuid::new_v4().to_string();
    let safe_request =
        redact_model_run_value(&execution.safe_request, configured_secrets.iter().cloned());
    let safe_responses = redact_model_run_value(
        &Value::Array(execution.safe_responses),
        configured_secrets.iter().cloned(),
    );
    let mut artifacts = Vec::with_capacity(execution.payloads.len());
    for (index, payload) in execution.payloads.into_iter().enumerate() {
        control.check()?;
        let dimensions = if payload.role == GeneratedArtifactRole::PrimaryImage {
            generated_image_dimensions(&payload.bytes)?
        } else {
            (None, None)
        };
        let artifact_id = Uuid::new_v4().to_string();
        let output_path = if index == 0 {
            string_argument(arguments, "output_path")
        } else {
            None
        };
        let output_directory = string_argument(arguments, "output_directory")
            .unwrap_or_else(|| format!("generated/{invocation_id}"));
        let path = output_path.unwrap_or_else(|| {
            format!(
                "{}/{}.{}",
                output_directory.trim_end_matches('/'),
                artifact_id,
                payload.suggested_extension
            )
        });
        let path = assert_project_tree_visible_mutation_path(&path)?;
        ProjectCapabilityFs::open(project_root)?.atomic_write_checked(
            &path,
            &payload.bytes,
            || control.check(),
        )?;
        control.check()?;
        let output = redact_model_run_value(
            &serde_json::json!({
                "responses": safe_responses,
                "parsed": payload.model_output,
                "artifactIndex": index,
            }),
            configured_secrets.iter().cloned(),
        );
        metadata.record_checked(
            project_root,
            RecordGeneratedAssetInput {
                model_run_id: model_run_id.clone(),
                project_relative_path: path.clone(),
                artifact_role: payload.role,
                artifact_index: u64::try_from(index).unwrap_or(u64::MAX),
                model_run: GeneratedModelRun {
                    request: safe_request.clone(),
                    output,
                },
            },
            || control.check(),
        )?;
        control.check()?;
        let (width, height) = dimensions;
        let title = path.rsplit('/').next().unwrap_or(&path).to_owned();
        artifacts.push(GenerationArtifact {
            artifact_id,
            title,
            project_relative_path: path,
            mime_type: payload.mime_type,
            role: payload.role,
            artifact_index: u64::try_from(index).unwrap_or(u64::MAX),
            width,
            height,
        });
    }
    control.check()?;
    Ok((artifacts, execution.logs))
}

fn generated_image_dimensions(bytes: &[u8]) -> Result<(Option<u32>, Option<u32>), GenerationError> {
    use image::ImageDecoder as _;

    let cursor = std::io::Cursor::new(bytes);
    let mut reader = image::ImageReader::new(cursor);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_GENERATED_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_GENERATED_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_GENERATED_IMAGE_ALLOCATION);
    reader.limits(limits);
    let reader = reader.with_guessed_format().map_err(|error| {
        GenerationError::new(
            "generated_artifact_invalid",
            format!("Generated image format could not be inspected: {error}"),
        )
    })?;
    let decoder = reader.into_decoder().map_err(|error| {
        GenerationError::new(
            "generated_artifact_invalid",
            format!("Generated image header could not be inspected: {error}"),
        )
    })?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_GENERATED_IMAGE_DIMENSION
        || height > MAX_GENERATED_IMAGE_DIMENSION
        || u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(4)
            > MAX_GENERATED_IMAGE_ALLOCATION
    {
        return Err(GenerationError::new(
            "generated_artifact_invalid",
            "Generated image dimensions exceed the safe inspection limit.",
        ));
    }
    Ok((Some(width), Some(height)))
}

pub(crate) fn string_argument(arguments: &Map<String, Value>, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn strip_output_arguments(arguments: &Map<String, Value>) -> Map<String, Value> {
    arguments
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "output_path" | "output_directory"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub(crate) fn response_log(response: &ModelHttpResponse, parsed: &Value) -> Value {
    serde_json::json!({
        "status": response.status,
        "headers": safe_response_headers(&response.headers),
        "body": summarize_json(parsed),
    })
}

fn safe_response_headers(headers: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "content-type" | "content-length" | "request-id" | "x-request-id" | "x-trace-id"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

pub(crate) fn summarize_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), summarize_json(value)))
                .collect(),
        ),
        Value::Array(values) => serde_json::json!({"arrayLength": values.len()}),
        Value::String(value) if value.len() > 1_024 => {
            serde_json::json!({"stringLength": value.len()})
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::GeneratedArtifactRole;

    #[test]
    fn recursive_catalog_validation_rejects_wrong_array_and_object_shapes() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "single": {"type": "string"},
                "items": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            {"type": "string"},
                            {
                                "type": "object",
                                "properties": {"url": {"type": "string", "pattern": "^https://"}},
                                "required": ["url"],
                                "additionalProperties": false
                            }
                        ]
                    }
                }
            },
            "additionalProperties": false
        });
        assert!(
            validate_arguments(
                "fixture",
                &schema,
                &Map::from_iter([("single".to_owned(), serde_json::json!(["wrong"]))]),
            )
            .is_err()
        );
        assert!(
            validate_arguments(
                "fixture",
                &schema,
                &Map::from_iter([(
                    "items".to_owned(),
                    serde_json::json!([{"url":"file:///private", "extra": true}]),
                )]),
            )
            .is_err()
        );
    }

    #[test]
    fn project_image_registry_is_shared_with_generation_inputs() {
        for (path, expected) in [
            ("one.jfif", "image/jpeg"),
            ("one.avif", "image/avif"),
            ("one.tiff", "image/tiff"),
            ("one.svgz", "image/svg+xml"),
        ] {
            assert_eq!(mime_from_path_or_bytes(path, &[]), Some(expected));
        }
    }

    #[test]
    fn generated_output_cannot_replace_protected_project_documents() {
        let root = std::env::temp_dir().join(format!("debrute-generation-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".debrute")).unwrap();
        std::fs::write(root.join(".debrute/project.json"), b"keep").unwrap();
        let cancellation = GenerationCancellation::default();
        let execution = ModelExecution {
            payloads: vec![GeneratedPayload {
                bytes: b"replace".to_vec(),
                mime_type: "application/octet-stream".to_owned(),
                role: GeneratedArtifactRole::Other,
                suggested_extension: "bin",
                model_output: Value::Null,
            }],
            safe_request: Value::Null,
            safe_responses: Vec::new(),
            logs: Vec::new(),
        };
        let error = store_execution(
            &root,
            "invocation",
            &Map::from_iter([(
                "output_path".to_owned(),
                Value::String(".debrute/project.json".to_owned()),
            )]),
            execution,
            &GeneratedAssetMetadataService::new(),
            &[],
            &GenerationControl::new(
                &cancellation,
                GenerationDeadline::after(Duration::from_secs(1)).unwrap(),
            ),
        )
        .unwrap_err();
        assert_eq!(error.code(), "generation_project_failed");
        assert_eq!(
            std::fs::read(root.join(".debrute/project.json")).unwrap(),
            b"keep"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_run_response_log_has_count_and_byte_bounds() {
        let mut responses = Vec::new();
        let mut bytes = 0;
        let mut truncated = false;
        for index in 0..1_000 {
            push_bounded_response_log(
                &mut responses,
                &mut bytes,
                &mut truncated,
                serde_json::json!({"index": index, "body": "x".repeat(128 * 1024)}),
            );
        }
        assert!(truncated);
        assert!(responses.len() <= MAX_MODEL_RUN_RESPONSE_LOGS + 1);
        assert!(bytes <= MAX_MODEL_RUN_RESPONSE_LOG_BYTES);
    }
}
