use std::{collections::BTreeMap, path::Path, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::model_operation::{ArtifactPointer, ModelRequest};
use crate::project::{
    CommitGeneratedAssetFile, GeneratedArtifactRole, GeneratedAssetMetadataService,
    GeneratedModelRun, ProjectCapabilityFs, RecordGeneratedAssetInput, StagedGeneratedAssetFiles,
    assert_project_tree_visible_mutation_path, assert_project_tree_visible_path,
    project_content_type,
};

use super::{
    http::{validate_public_url, validate_request_size},
    redaction::redact_model_run_value,
    types::{
        GeneratedPayload, GenerationCancellation, GenerationDeadline, GenerationError, HttpBody,
        HttpMethod, HttpTargetPolicy, ModelExecution, ModelHttpRequest, ModelHttpResponse,
        ModelHttpTransport, PreparedHttpBody, ResolvedGenerationModel,
    },
};

pub(crate) const MAX_MODEL_JSON_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_GENERATED_MEDIA_BYTES: usize = 256 * 1024 * 1024;
const MAX_GENERATED_MEDIA_TOTAL_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_INPUT_MEDIA_ITEM_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const MAX_MODEL_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_MODEL_RUN_RESPONSE_LOGS: usize = 64;
const MAX_MODEL_RUN_RESPONSE_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_REMOTE_ERROR_BYTES: usize = 8 * 1024;
const MAX_GENERATED_IMAGE_DIMENSION: u32 = 50_000;
const MAX_GENERATED_IMAGE_ALLOCATION: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ModelRequestResourceLimits {
    pub input_media_item_bytes: usize,
    pub model_request_bytes: usize,
}

pub(crate) enum ResolvedMediaReference {
    PublicUrl(String),
    Inline {
        mime_type: String,
        bytes: Vec<u8>,
        request_bytes_reserved: usize,
    },
}

impl ResolvedMediaReference {
    pub(crate) fn is_public_url(&self) -> bool {
        matches!(self, Self::PublicUrl(_))
    }

    pub(crate) fn accounted_public_url<'b>(
        &'b self,
        context: &mut ExecutionContext<'_>,
    ) -> Result<Option<&'b str>, GenerationError> {
        match self {
            Self::PublicUrl(url) => {
                context.reserve_request_bytes(url.len())?;
                Ok(Some(url))
            }
            Self::Inline { .. } => Ok(None),
        }
    }

    pub(crate) fn into_reference_string(
        self,
        context: &mut ExecutionContext<'_>,
    ) -> Result<String, GenerationError> {
        match self {
            Self::PublicUrl(url) => {
                context.reserve_request_bytes(url.len())?;
                Ok(url)
            }
            Self::Inline {
                mime_type,
                bytes,
                request_bytes_reserved,
            } => {
                let encoded_bytes = encoded_base64_len(bytes.len())?;
                let request_bytes = "data:"
                    .len()
                    .saturating_add(mime_type.len())
                    .saturating_add(";base64,".len())
                    .saturating_add(encoded_bytes);
                context.replace_request_bytes(request_bytes_reserved, request_bytes)?;
                Ok(format!("data:{mime_type};base64,{}", BASE64.encode(bytes)))
            }
        }
    }

    pub(crate) fn into_inline_base64(
        self,
        context: &mut ExecutionContext<'_>,
    ) -> Result<(String, String), GenerationError> {
        match self {
            Self::PublicUrl(_) => Err(GenerationError::new(
                "generation_input_invalid",
                "Public media URL cannot be encoded as inline media.",
            )),
            Self::Inline {
                mime_type,
                bytes,
                request_bytes_reserved,
            } => {
                let request_bytes = encoded_base64_len(bytes.len())?
                    .checked_add(mime_type.len())
                    .ok_or_else(model_request_too_large)?;
                context.replace_request_bytes(request_bytes_reserved, request_bytes)?;
                Ok((mime_type, BASE64.encode(bytes)))
            }
        }
    }
}

impl Default for ModelRequestResourceLimits {
    fn default() -> Self {
        Self {
            input_media_item_bytes: MAX_INPUT_MEDIA_ITEM_BYTES,
            model_request_bytes: MAX_MODEL_REQUEST_BYTES,
        }
    }
}

pub(crate) struct ExecutionContext<'a> {
    pub model: &'a ResolvedGenerationModel,
    pub arguments: &'a Map<String, Value>,
    pub project_root: &'a Path,
    pub cancellation: &'a GenerationCancellation,
    pub transport: &'a dyn ModelHttpTransport,
    deadline: GenerationDeadline,
    pub safe_responses: Vec<Value>,
    generated_media_bytes: usize,
    response_log_bytes: usize,
    response_log_truncated: bool,
    limits: ModelRequestResourceLimits,
    request_bytes_reserved: usize,
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
        Self::new_with_limits(
            model,
            arguments,
            project_root,
            cancellation,
            transport,
            deadline,
            ModelRequestResourceLimits::default(),
        )
    }

    pub(crate) fn new_with_limits(
        model: &'a ResolvedGenerationModel,
        arguments: &'a Map<String, Value>,
        project_root: &'a Path,
        cancellation: &'a GenerationCancellation,
        transport: &'a dyn ModelHttpTransport,
        deadline: GenerationDeadline,
        limits: ModelRequestResourceLimits,
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
            generated_media_bytes: 0,
            response_log_bytes: 0,
            response_log_truncated: false,
            limits,
            request_bytes_reserved: 0,
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
            match serde_json::from_slice(&response.body) {
                Ok(parsed) => parsed,
                Err(_) if !(200..300).contains(&response.status) => {
                    return Err(remote_endpoint_error_bytes(response.status, &response.body));
                }
                Err(error) => {
                    return Err(GenerationError::new(
                        "model_response_invalid",
                        format!("Model response was not valid JSON: {error}"),
                    ));
                }
            }
        };
        self.push_response_log(response_log(&response, &parsed));
        if !(200..300).contains(&response.status) {
            return Err(remote_endpoint_error_json(response.status, &parsed));
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
                format!(
                    "Model endpoint rejected request (HTTP {}): {}",
                    response.status,
                    bounded_remote_text(String::from_utf8_lossy(&response.body).into_owned())
                ),
            ));
        }
        self.record_generated_media(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn download_generated_media(
        &mut self,
        url: &str,
    ) -> Result<ModelHttpResponse, GenerationError> {
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

    pub(crate) fn download_input_media(
        &mut self,
        url: &str,
    ) -> Result<ModelHttpResponse, GenerationError> {
        let request_bytes_remaining = self
            .limits
            .model_request_bytes
            .saturating_sub(self.request_bytes_reserved);
        let input_media_item_bytes = self.limits.input_media_item_bytes;
        let request_budget_is_tighter = request_bytes_remaining < input_media_item_bytes;
        let maximum_response_bytes = input_media_item_bytes.min(request_bytes_remaining);
        let response_too_large = || {
            if request_budget_is_tighter {
                model_request_too_large()
            } else {
                input_media_too_large(input_media_item_bytes)
            }
        };
        let response = self
            .request(
                HttpMethod::Get,
                url.to_owned(),
                BTreeMap::new(),
                HttpBody::Empty,
                maximum_response_bytes,
                HttpTargetPolicy::PublicMedia,
            )
            .map_err(|error| {
                if error.code() == "model_response_too_large" {
                    response_too_large()
                } else {
                    error
                }
            })?;
        if !(200..300).contains(&response.status) {
            return Err(GenerationError::new(
                "input_media_download_failed",
                format!("Input media download returned HTTP {}.", response.status),
            ));
        }
        if response.body.len() > maximum_response_bytes {
            return Err(response_too_large());
        }
        self.reserve_request_bytes(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn resolve_media_reference(
        &mut self,
        reference: &str,
    ) -> Result<ResolvedMediaReference, GenerationError> {
        if reference.starts_with("http://") || reference.starts_with("https://") {
            validate_public_url(reference, self.cancellation, self.deadline)?;
            return Ok(ResolvedMediaReference::PublicUrl(reference.to_owned()));
        }
        if reference.starts_with("data:") {
            let (decoded_bytes, mime_type_bytes) =
                input_data_url_layout(reference, self.limits.input_media_item_bytes)?;
            let mut request_bytes_reserved = decoded_bytes
                .checked_add(mime_type_bytes)
                .ok_or_else(model_request_too_large)?;
            self.reserve_request_bytes(request_bytes_reserved)?;
            let (mime_type, bytes) =
                decode_data_url(reference, self.limits.input_media_item_bytes)?;
            if bytes.len() != decoded_bytes {
                let replacement = bytes
                    .len()
                    .checked_add(mime_type.len())
                    .ok_or_else(model_request_too_large)?;
                self.replace_request_bytes(request_bytes_reserved, replacement)?;
                request_bytes_reserved = replacement;
            }
            return Ok(ResolvedMediaReference::Inline {
                mime_type,
                bytes,
                request_bytes_reserved,
            });
        }

        let path = assert_project_tree_visible_path(reference)?;
        let project = ProjectCapabilityFs::open(self.project_root)?;
        let file_size = usize::try_from(project.file_size(&path)?)
            .map_err(|_| input_media_too_large(self.limits.input_media_item_bytes))?;
        if file_size > self.limits.input_media_item_bytes {
            return Err(input_media_too_large(self.limits.input_media_item_bytes));
        }
        self.reserve_request_bytes(file_size)?;
        let bytes = project
            .read_limited(&path, self.limits.input_media_item_bytes)
            .map_err(|error| {
                if error.code() == "project_document_too_large" {
                    input_media_too_large(self.limits.input_media_item_bytes)
                } else {
                    error.into()
                }
            })?;
        if bytes.len() != file_size {
            self.replace_request_bytes(file_size, bytes.len())?;
        }
        let mime_type = mime_from_path_or_bytes(&path, &bytes)
            .ok_or_else(|| {
                GenerationError::new(
                    "generation_input_invalid",
                    format!("Project media input has an unsupported type: {path}"),
                )
            })?
            .to_owned();
        self.reserve_request_bytes(mime_type.len())?;
        let request_bytes_reserved = bytes
            .len()
            .checked_add(mime_type.len())
            .ok_or_else(model_request_too_large)?;
        Ok(ResolvedMediaReference::Inline {
            mime_type,
            bytes,
            request_bytes_reserved,
        })
    }

    fn reserve_request_bytes(&mut self, bytes: usize) -> Result<(), GenerationError> {
        let next = self.ensure_request_bytes(bytes)?;
        self.request_bytes_reserved = next;
        Ok(())
    }

    fn ensure_request_bytes(&self, bytes: usize) -> Result<usize, GenerationError> {
        let next = self
            .request_bytes_reserved
            .checked_add(bytes)
            .ok_or_else(model_request_too_large)?;
        if next > self.limits.model_request_bytes {
            return Err(model_request_too_large());
        }
        Ok(next)
    }

    fn replace_request_bytes(
        &mut self,
        previous: usize,
        replacement: usize,
    ) -> Result<(), GenerationError> {
        let retained = self
            .request_bytes_reserved
            .checked_sub(previous)
            .ok_or_else(model_request_too_large)?;
        let next = retained
            .checked_add(replacement)
            .ok_or_else(model_request_too_large)?;
        if next > self.limits.model_request_bytes {
            return Err(model_request_too_large());
        }
        self.request_bytes_reserved = next;
        Ok(())
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
        let body = PreparedHttpBody::try_from(body)?;
        validate_request_size(&body, self.limits.model_request_bytes)?;
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

fn remote_endpoint_error_json(status: u16, body: &Value) -> GenerationError {
    let safe = redact_model_run_value(body, std::iter::empty());
    let body = serde_json::to_string(&safe).unwrap_or_else(|_| "<unserializable body>".to_owned());
    GenerationError::new(
        "model_request_failed",
        format!(
            "Model endpoint rejected request (HTTP {status}): {}",
            bounded_remote_text(body)
        ),
    )
}

fn remote_endpoint_error_bytes(status: u16, body: &[u8]) -> GenerationError {
    if let Ok(body) = serde_json::from_slice::<Value>(body) {
        return remote_endpoint_error_json(status, &body);
    }
    GenerationError::new(
        "model_request_failed",
        format!(
            "Model endpoint rejected request (HTTP {status}): {}",
            bounded_remote_text(String::from_utf8_lossy(body).into_owned())
        ),
    )
}

fn bounded_remote_text(mut text: String) -> String {
    if text.len() <= MAX_AGENT_REMOTE_ERROR_BYTES {
        return text;
    }
    let mut end = MAX_AGENT_REMOTE_ERROR_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("...[truncated]");
    text
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
    })
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
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(key) {
                return Err(GenerationError::new(
                    "generation_argument_invalid",
                    format!("Model {model_id} requires argument: {key}."),
                ));
            }
        }
    }
    for (key, value) in arguments {
        if let Some(property_schema) = properties.get(key) {
            validate_argument_schema(model_id, key, value, property_schema)?;
        }
    }
    Ok(())
}

pub(crate) fn materialize_argument_defaults(
    model_id: &str,
    schema: &Value,
    arguments: &mut Map<String, Value>,
) -> Result<(), GenerationError> {
    materialize_object_defaults(model_id, "arguments", schema, arguments)
}

fn materialize_object_defaults(
    model_id: &str,
    path: &str,
    schema: &Value,
    object: &mut Map<String, Value>,
) -> Result<(), GenerationError> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            GenerationError::new(
                "model_catalog_invalid",
                format!("Model {model_id} schema {path} has no properties."),
            )
        })?;
    for (key, child_schema) in properties {
        if let Some(value) = object.get_mut(key) {
            materialize_nested_defaults(model_id, &format!("{path}.{key}"), child_schema, value)?;
            continue;
        }
        if let Some(default) = child_schema.get("default") {
            object.insert(key.clone(), default.clone());
            continue;
        }
        if child_schema.get("type").and_then(Value::as_str) == Some("object")
            && child_schema.get("properties").is_some()
        {
            let mut child = Map::new();
            materialize_object_defaults(
                model_id,
                &format!("{path}.{key}"),
                child_schema,
                &mut child,
            )?;
            if !child.is_empty() {
                object.insert(key.clone(), Value::Object(child));
            }
        }
    }
    Ok(())
}

fn materialize_nested_defaults(
    model_id: &str,
    path: &str,
    schema: &Value,
    value: &mut Value,
) -> Result<(), GenerationError> {
    if let Some(object) = value.as_object_mut()
        && schema.get("properties").is_some()
    {
        materialize_object_defaults(model_id, path, schema, object)?;
    }
    if let Some(items) = value.as_array_mut()
        && let Some(item_schema) = schema.get("items")
    {
        for (index, item) in items.iter_mut().enumerate() {
            materialize_nested_defaults(model_id, &format!("{path}[{index}]"), item_schema, item)?;
        }
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
        && !branches
            .iter()
            .any(|branch| validate_argument_schema(model_id, path, value, branch).is_ok())
    {
        return invalid_argument(model_id, path, "does not match any supported shape");
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
    validate_nested_constraint(model_id, path, value, schema)?;
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
                if !object.contains_key(key) {
                    return invalid_argument(model_id, &format!("{path}.{key}"), "is required");
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
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

fn encoded_base64_len(bytes: usize) -> Result<usize, GenerationError> {
    bytes
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or_else(model_request_too_large)
}

fn input_data_url_layout(
    value: &str,
    maximum_bytes: usize,
) -> Result<(usize, usize), GenerationError> {
    let payload = value.strip_prefix("data:").ok_or_else(|| {
        GenerationError::new("generation_input_invalid", "Media data URL is malformed.")
    })?;
    let (header, encoded) = payload.split_once(',').ok_or_else(|| {
        GenerationError::new("generation_input_invalid", "Media data URL is malformed.")
    })?;
    let mime_type = header
        .strip_suffix(";base64")
        .filter(|mime| !mime.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "generation_input_invalid",
                "Media data URL must use base64 encoding.",
            )
        })?;
    if encoded.len() % 4 != 0 {
        return Err(GenerationError::new(
            "generation_input_invalid",
            "Media data URL has an invalid base64 length.",
        ));
    }
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);
    let decoded = encoded
        .len()
        .checked_div(4)
        .and_then(|groups| groups.checked_mul(3))
        .and_then(|bytes| bytes.checked_sub(padding))
        .ok_or_else(|| input_media_too_large(maximum_bytes))?;
    if decoded > maximum_bytes {
        return Err(input_media_too_large(maximum_bytes));
    }
    Ok((decoded, mime_type.len()))
}

fn model_request_too_large() -> GenerationError {
    GenerationError::new(
        "model_request_too_large",
        "Model request exceeds the Runtime request-size limit.",
    )
}

fn input_media_too_large(maximum_bytes: usize) -> GenerationError {
    GenerationError::new(
        "generation_input_too_large",
        format!("Input media exceeds the {maximum_bytes}-byte item limit."),
    )
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

struct OutputNaming {
    directory: String,
    basename: String,
    artifact_count: usize,
}

impl OutputNaming {
    fn new(operation_id: &str, request: &ModelRequest, artifact_count: usize) -> Self {
        let output = request.output.as_ref();
        Self {
            directory: output
                .and_then(|output| output.directory.as_deref())
                .map_or_else(|| format!("generated/{operation_id}"), str::to_owned),
            basename: output
                .and_then(|output| output.filename.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            artifact_count,
        }
    }

    fn path(&self, index: usize, extension: &str) -> Result<String, GenerationError> {
        let filename = if self.artifact_count == 1 {
            format!("{}.{extension}", self.basename)
        } else {
            format!("{}_{}.{extension}", self.basename, index + 1)
        };
        let path = if self.directory == "." {
            filename
        } else {
            format!("{}/{filename}", self.directory)
        };
        assert_project_tree_visible_mutation_path(&path).map_err(GenerationError::from)
    }
}

pub(crate) struct StagedModelExecution {
    files: StagedGeneratedAssetFiles,
}

pub(crate) fn stage_execution(
    capability: &ProjectCapabilityFs,
    operation_id: &str,
    request: &ModelRequest,
    replace: bool,
    execution: ModelExecution,
    configured_secrets: &[String],
) -> Result<(StagedModelExecution, Vec<ArtifactPointer>), GenerationError> {
    let model_run_id = Uuid::new_v4().to_string();
    let safe_request =
        redact_model_run_value(&execution.safe_request, configured_secrets.iter().cloned());
    let safe_responses = redact_model_run_value(
        &Value::Array(execution.safe_responses),
        configured_secrets.iter().cloned(),
    );
    let artifact_count = execution.payloads.len();
    let naming = OutputNaming::new(operation_id, request, artifact_count);
    let mut committed_files = Vec::with_capacity(artifact_count);
    let mut artifacts = Vec::with_capacity(artifact_count);
    for (index, payload) in execution.payloads.into_iter().enumerate() {
        let artifact_index = u64::try_from(index).map_err(|_| {
            GenerationError::new(
                "model_response_too_large",
                "Generated Artifact count exceeds the supported index range.",
            )
        })?;
        let dimensions = if payload.role == GeneratedArtifactRole::PrimaryImage {
            generated_image_dimensions(&payload.bytes)?
        } else {
            (None, None)
        };
        let extension = extension_for_mime(&payload.mime_type)?;
        let path = naming.path(index, extension)?;
        let output = redact_model_run_value(
            &serde_json::json!({
                "responses": safe_responses,
                "parsed": payload.model_output,
                "artifactIndex": index,
            }),
            configured_secrets.iter().cloned(),
        );
        committed_files.push(CommitGeneratedAssetFile {
            input: RecordGeneratedAssetInput {
                model_run_id: model_run_id.clone(),
                project_relative_path: path.clone(),
                artifact_role: payload.role,
                artifact_index,
                model_run: GeneratedModelRun {
                    request: safe_request.clone(),
                    output,
                },
            },
            content: payload.bytes,
            replace,
        });
        let (width, height) = dimensions;
        artifacts.push(ArtifactPointer {
            artifact_index,
            role: payload.role,
            project_relative_path: path,
            mime_type: payload.mime_type,
            width,
            height,
        });
    }
    let files = GeneratedAssetMetadataService::stage_generated_files(capability, committed_files)?;
    Ok((StagedModelExecution { files }, artifacts))
}

pub(crate) fn commit_staged_execution(
    project_root: &Path,
    staged: StagedModelExecution,
    metadata: &GeneratedAssetMetadataService,
) -> Result<(), GenerationError> {
    let StagedModelExecution { files } = staged;
    metadata.with_project_commit(project_root, |commit| {
        commit
            .commit_staged_generated_files(files)
            .map_err(GenerationError::from)
    })?;
    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::too_many_arguments,
    reason = "test and non-Operation callers use the same stage-and-commit path"
)]
pub(crate) fn commit_execution(
    project_root: &Path,
    capability: &ProjectCapabilityFs,
    operation_id: &str,
    request: &ModelRequest,
    replace: bool,
    execution: ModelExecution,
    metadata: &GeneratedAssetMetadataService,
    configured_secrets: &[String],
) -> Result<Vec<ArtifactPointer>, GenerationError> {
    let (staged, artifacts) = stage_execution(
        capability,
        operation_id,
        request,
        replace,
        execution,
        configured_secrets,
    )?;
    commit_staged_execution(project_root, staged, metadata)?;
    Ok(artifacts)
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
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::project::{GeneratedArtifactRole, GeneratedAssetMetadataLookup};

    #[test]
    fn recursive_catalog_validation_checks_known_shapes_only() {
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
        validate_arguments(
            "fixture",
            &schema,
            &Map::from_iter([
                (
                    "items".to_owned(),
                    serde_json::json!([{"url":"file:///private", "extra": true}]),
                ),
                (
                    "unknown".to_owned(),
                    serde_json::json!({"sent": "to provider"}),
                ),
            ]),
        )
        .unwrap();
        assert!(
            validate_arguments(
                "fixture",
                &schema,
                &Map::from_iter([("items".to_owned(), serde_json::json!([{"url": 42}]),)]),
            )
            .is_err()
        );
    }

    #[test]
    fn catalog_defaults_materialize_recursively_without_replacing_explicit_values() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "delivery": {"type": "string", "default": "uri"},
                "explicit": {"type": ["string", "null"], "default": "default"},
                "options": {
                    "type": "object",
                    "properties": {
                        "format": {"type": "string", "default": "png"}
                    }
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "enabled": {"type": "boolean", "default": false}
                        }
                    }
                }
            }
        });
        let mut arguments = Map::from_iter([
            ("explicit".to_owned(), Value::Null),
            ("items".to_owned(), serde_json::json!([{}])),
        ]);

        materialize_argument_defaults("fixture", &schema, &mut arguments).unwrap();

        assert_eq!(arguments.get("delivery"), Some(&serde_json::json!("uri")));
        assert_eq!(arguments.get("explicit"), Some(&Value::Null));
        let materialized = Value::Object(arguments);
        assert_eq!(
            materialized.pointer("/options/format"),
            Some(&serde_json::json!("png"))
        );
        assert_eq!(
            materialized.pointer("/items/0/enabled"),
            Some(&serde_json::json!(false))
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
    fn model_output_uses_real_extensions_and_actual_artifact_count() {
        let root = std::env::temp_dir().join(format!("debrute-generation-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let execution = ModelExecution {
            payloads: vec![
                GeneratedPayload {
                    bytes: b"jpeg".to_vec(),
                    mime_type: "image/jpeg".to_owned(),
                    role: GeneratedArtifactRole::Other,
                    model_output: Value::Null,
                },
                GeneratedPayload {
                    bytes: b"video".to_vec(),
                    mime_type: "video/mp4".to_owned(),
                    role: GeneratedArtifactRole::Other,
                    model_output: Value::Null,
                },
            ],
            safe_request: Value::Null,
            safe_responses: Vec::new(),
        };
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: Some(crate::model_operation::ModelOutput {
                directory: Some("generated".to_owned()),
                filename: Some("covers".to_owned()),
            }),
        };
        let capability = ProjectCapabilityFs::open(&root).unwrap();
        let artifacts = commit_execution(
            &root,
            &capability,
            "operation",
            &request,
            false,
            execution,
            &GeneratedAssetMetadataService::new(),
            &[],
        )
        .unwrap();
        assert_eq!(
            artifacts
                .iter()
                .map(|artifact| artifact.project_relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["generated/covers_1.jpg", "generated/covers_2.mp4"]
        );
        assert_eq!(
            std::fs::read(root.join("generated/covers_1.jpg")).unwrap(),
            b"jpeg"
        );
        assert_eq!(
            std::fs::read(root.join("generated/covers_2.mp4")).unwrap(),
            b"video"
        );
        drop(capability);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_item_commit_restores_the_output_present_at_commit_time() {
        let root = std::env::temp_dir().join(format!("debrute-generation-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("generated")).unwrap();
        std::fs::create_dir_all(root.join(".debrute/assets")).unwrap();
        std::fs::write(root.join("generated/covers.mp3"), b"old").unwrap();
        std::fs::write(
            root.join(crate::project::GENERATED_ASSET_INDEX_PROJECT_PATH),
            b"invalid metadata",
        )
        .unwrap();
        let execution = ModelExecution {
            payloads: vec![GeneratedPayload {
                bytes: b"new".to_vec(),
                mime_type: "audio/mpeg".to_owned(),
                role: GeneratedArtifactRole::Other,
                model_output: Value::Null,
            }],
            safe_request: Value::Null,
            safe_responses: Vec::new(),
        };
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: Some(crate::model_operation::ModelOutput {
                directory: Some("generated".to_owned()),
                filename: Some("covers".to_owned()),
            }),
        };

        let capability = ProjectCapabilityFs::open(&root).unwrap();
        let error = commit_execution(
            &root,
            &capability,
            "operation",
            &request,
            true,
            execution,
            &GeneratedAssetMetadataService::new(),
            &[],
        )
        .unwrap_err();

        assert_eq!(error.code(), "generation_project_failed");
        assert_eq!(
            std::fs::read(root.join("generated/covers.mp3")).unwrap(),
            b"old"
        );
        let temporary = std::fs::read_dir(root.join("generated"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary, 0);
        drop(capability);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_model_commits_serialize_files_with_their_provenance() {
        let root = std::env::temp_dir().join(format!("debrute-generation-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("generated")).unwrap();
        std::fs::write(root.join("generated/shared.mp3"), b"original").unwrap();
        let metadata = Arc::new(GeneratedAssetMetadataService::new());
        let capability = ProjectCapabilityFs::open(&root).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: Some(crate::model_operation::ModelOutput {
                directory: Some("generated".to_owned()),
                filename: Some("shared".to_owned()),
            }),
        };
        let threads = [b"first".to_vec(), b"second".to_vec()].map(|bytes| {
            let root = root.clone();
            let metadata = Arc::clone(&metadata);
            let capability = capability.clone();
            let barrier = Arc::clone(&barrier);
            let request = request.clone();
            std::thread::spawn(move || {
                barrier.wait();
                commit_execution(
                    &root,
                    &capability,
                    &Uuid::new_v4().to_string(),
                    &request,
                    true,
                    ModelExecution {
                        payloads: vec![GeneratedPayload {
                            bytes,
                            mime_type: "audio/mpeg".to_owned(),
                            role: GeneratedArtifactRole::Other,
                            model_output: Value::Null,
                        }],
                        safe_request: Value::Null,
                        safe_responses: Vec::new(),
                    },
                    &metadata,
                    &[],
                )
            })
        });
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let final_bytes = std::fs::read(root.join("generated/shared.mp3")).unwrap();
        assert!(final_bytes == b"first" || final_bytes == b"second");
        let GeneratedAssetMetadataLookup::Matched { records, .. } =
            metadata.lookup(&root, "generated/shared.mp3").unwrap()
        else {
            panic!("final output must retain matching provenance");
        };
        assert_eq!(records.len(), 1);
        drop(capability);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn generated_commit_remains_anchored_when_the_ambient_project_path_is_replaced() {
        let container = std::env::temp_dir().join(format!("debrute-generation-{}", Uuid::new_v4()));
        let root = container.join("project");
        let accepted_root = container.join("accepted-project");
        std::fs::create_dir_all(&root).unwrap();
        let capability = ProjectCapabilityFs::open_current(&root).unwrap();
        std::fs::rename(&root, &accepted_root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: Some(crate::model_operation::ModelOutput {
                directory: Some("generated".to_owned()),
                filename: Some("anchored".to_owned()),
            }),
        };
        commit_execution(
            &root,
            &capability,
            "operation",
            &request,
            false,
            ModelExecution {
                payloads: vec![GeneratedPayload {
                    bytes: b"anchored".to_vec(),
                    mime_type: "audio/mpeg".to_owned(),
                    role: GeneratedArtifactRole::Other,
                    model_output: Value::Null,
                }],
                safe_request: Value::Null,
                safe_responses: Vec::new(),
            },
            &GeneratedAssetMetadataService::new(),
            &[],
        )
        .unwrap();
        assert_eq!(
            std::fs::read(accepted_root.join("generated/anchored.mp3")).unwrap(),
            b"anchored"
        );
        assert!(!root.join("generated/anchored.mp3").exists());
        std::fs::remove_dir_all(container).unwrap();
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
