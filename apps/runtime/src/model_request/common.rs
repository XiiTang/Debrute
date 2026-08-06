use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::model_operation::{ArtifactPointer, ModelOperationCommitWarnings, ModelRequest};
use crate::project::project_content_type;

use super::{
    http::{validate_public_url, validate_request_size},
    provenance::{
        ModelArtifactProvenanceResponse, ModelArtifactProvenanceStore,
        RecordModelArtifactProvenanceInput,
    },
    redaction::redact_model_request_value,
    types::{
        HttpBody, HttpMethod, HttpTargetPolicy, ModelArtifactPayload, ModelExecution,
        ModelHttpRequest, ModelHttpResponse, ModelHttpTransport, ModelRequestCancellation,
        ModelRequestDeadline, ModelRequestError, PreparedHttpBody, ResolvedModelRequestModel,
    },
};

pub(crate) const MAX_MODEL_JSON_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_MODEL_OUTPUT_MEDIA_BYTES: usize = 256 * 1024 * 1024;
const MAX_MODEL_OUTPUT_MEDIA_TOTAL_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_INPUT_MEDIA_ITEM_BYTES: usize = 128 * 1024 * 1024;
pub(crate) const MAX_MODEL_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_MODEL_REQUEST_TRACE_ENTRIES: usize = 64;
const MAX_MODEL_RUN_RESPONSE_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_REMOTE_ERROR_BYTES: usize = 8 * 1024;
const MAX_REMOTE_CANCELLATION_RESPONSE_BYTES: usize = 64 * 1024;
const REMOTE_CANCELLATION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODEL_ARTIFACT_IMAGE_DIMENSION: u32 = 50_000;
const MAX_MODEL_ARTIFACT_IMAGE_ALLOCATION: u64 = 64 * 1024 * 1024;

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
    ) -> Result<Option<&'b str>, ModelRequestError> {
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
    ) -> Result<String, ModelRequestError> {
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
    ) -> Result<(String, String), ModelRequestError> {
        match self {
            Self::PublicUrl(_) => Err(ModelRequestError::new(
                "model_request_input_invalid",
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
    pub model: &'a ResolvedModelRequestModel,
    pub arguments: &'a Map<String, Value>,
    pub invocation_cwd: &'a Path,
    pub cancellation: &'a ModelRequestCancellation,
    pub transport: &'a dyn ModelHttpTransport,
    deadline: ModelRequestDeadline,
    pub safe_responses: Vec<Value>,
    model_output_media_bytes: usize,
    response_log_bytes: usize,
    response_log_truncated: bool,
    limits: ModelRequestResourceLimits,
    request_bytes_reserved: usize,
}

impl<'a> ExecutionContext<'a> {
    pub(crate) fn new(
        model: &'a ResolvedModelRequestModel,
        arguments: &'a Map<String, Value>,
        invocation_cwd: &'a Path,
        cancellation: &'a ModelRequestCancellation,
        transport: &'a dyn ModelHttpTransport,
        deadline: ModelRequestDeadline,
    ) -> Result<Self, ModelRequestError> {
        Self::new_with_limits(
            model,
            arguments,
            invocation_cwd,
            cancellation,
            transport,
            deadline,
            ModelRequestResourceLimits::default(),
        )
    }

    pub(crate) fn new_with_limits(
        model: &'a ResolvedModelRequestModel,
        arguments: &'a Map<String, Value>,
        invocation_cwd: &'a Path,
        cancellation: &'a ModelRequestCancellation,
        transport: &'a dyn ModelHttpTransport,
        deadline: ModelRequestDeadline,
        limits: ModelRequestResourceLimits,
    ) -> Result<Self, ModelRequestError> {
        deadline.remaining(cancellation)?;
        Ok(Self {
            model,
            arguments,
            invocation_cwd,
            cancellation,
            transport,
            deadline,
            safe_responses: Vec::new(),
            model_output_media_bytes: 0,
            response_log_bytes: 0,
            response_log_truncated: false,
            limits,
            request_bytes_reserved: 0,
        })
    }

    pub(crate) fn remaining(&self) -> Result<Duration, ModelRequestError> {
        self.deadline.remaining(self.cancellation)
    }

    pub(crate) fn sleep(&self, duration: Duration) -> Result<(), ModelRequestError> {
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
    ) -> Result<Value, ModelRequestError> {
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
                    return Err(ModelRequestError::new(
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
    ) -> Result<ModelHttpResponse, ModelRequestError> {
        let response = self.request(
            method,
            url,
            headers,
            body,
            MAX_MODEL_OUTPUT_MEDIA_BYTES,
            HttpTargetPolicy::ModelEndpoint,
        )?;
        self.push_response_log(serde_json::json!({
            "status": response.status,
            "headers": safe_response_headers(&response.headers),
            "body": {"bytes": response.body.len()},
        }));
        if !(200..300).contains(&response.status) {
            return Err(ModelRequestError::new(
                "model_request_failed",
                format!(
                    "Model endpoint rejected request (HTTP {}): {}",
                    response.status,
                    bounded_remote_text(String::from_utf8_lossy(&response.body).into_owned())
                ),
            ));
        }
        self.record_model_output_media(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn download_model_output_media(
        &mut self,
        url: &str,
    ) -> Result<ModelHttpResponse, ModelRequestError> {
        let response = self.request(
            HttpMethod::Get,
            url.to_owned(),
            BTreeMap::new(),
            HttpBody::Empty,
            MAX_MODEL_OUTPUT_MEDIA_BYTES,
            HttpTargetPolicy::PublicMedia,
        )?;
        if !(200..300).contains(&response.status) {
            return Err(ModelRequestError::new(
                "model_artifact_download_failed",
                format!("Model artifact download returned HTTP {}.", response.status),
            ));
        }
        self.record_model_output_media(response.body.len())?;
        Ok(response)
    }

    pub(crate) fn download_input_media(
        &mut self,
        url: &str,
    ) -> Result<ModelHttpResponse, ModelRequestError> {
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
            return Err(ModelRequestError::new(
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

    pub(crate) fn best_effort_remote_cancellation(
        &self,
        method: HttpMethod,
        url: String,
        headers: BTreeMap<String, String>,
        body: HttpBody,
    ) {
        let Ok(body) = PreparedHttpBody::try_from(body) else {
            return;
        };
        if validate_request_size(&body, self.limits.model_request_bytes).is_err() {
            return;
        }
        let cancellation = ModelRequestCancellation::default();
        let Ok(deadline) = ModelRequestDeadline::after(REMOTE_CANCELLATION_TIMEOUT) else {
            return;
        };
        let _ = self.transport.execute(
            ModelHttpRequest {
                method,
                url,
                headers,
                body,
                maximum_response_bytes: MAX_REMOTE_CANCELLATION_RESPONSE_BYTES,
                target_policy: HttpTargetPolicy::ModelEndpoint,
            },
            &cancellation,
            deadline,
        );
    }

    pub(crate) fn resolve_media_reference(
        &mut self,
        reference: &str,
    ) -> Result<ResolvedMediaReference, ModelRequestError> {
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

        let supplied = Path::new(reference);
        let path = if supplied.is_absolute() {
            supplied.to_path_buf()
        } else {
            self.invocation_cwd.join(supplied)
        }
        .canonicalize()
        .map_err(|error| {
            ModelRequestError::new(
                "model_request_input_invalid",
                format!("Local media path is unavailable: {reference} ({error})"),
            )
        })?;
        let metadata = fs::metadata(&path).map_err(|error| {
            ModelRequestError::new("model_request_input_invalid", error.to_string())
        })?;
        if !metadata.is_file() {
            return Err(ModelRequestError::new(
                "model_request_input_invalid",
                format!(
                    "Local media path is not an ordinary file: {}",
                    path.display()
                ),
            ));
        }
        let file_size = usize::try_from(metadata.len())
            .map_err(|_| input_media_too_large(self.limits.input_media_item_bytes))?;
        if file_size > self.limits.input_media_item_bytes {
            return Err(input_media_too_large(self.limits.input_media_item_bytes));
        }
        self.reserve_request_bytes(file_size)?;
        let mut bytes = Vec::with_capacity(file_size);
        fs::File::open(&path)
            .and_then(|file| {
                file.take(u64::try_from(self.limits.input_media_item_bytes).unwrap_or(u64::MAX) + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| {
                ModelRequestError::new("model_request_input_invalid", error.to_string())
            })?;
        if bytes.len() > self.limits.input_media_item_bytes {
            return Err(input_media_too_large(self.limits.input_media_item_bytes));
        }
        if bytes.len() != file_size {
            self.replace_request_bytes(file_size, bytes.len())?;
        }
        let path_string = path.to_string_lossy();
        let mime_type = mime_from_path_or_bytes(&path_string, &bytes)
            .ok_or_else(|| {
                ModelRequestError::new(
                    "model_request_input_invalid",
                    format!(
                        "Local media input has an unsupported type: {}",
                        path.display()
                    ),
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

    fn reserve_request_bytes(&mut self, bytes: usize) -> Result<(), ModelRequestError> {
        let next = self.ensure_request_bytes(bytes)?;
        self.request_bytes_reserved = next;
        Ok(())
    }

    fn ensure_request_bytes(&self, bytes: usize) -> Result<usize, ModelRequestError> {
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
    ) -> Result<(), ModelRequestError> {
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
    ) -> Result<ModelHttpResponse, ModelRequestError> {
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

    fn record_model_output_media(&mut self, bytes: usize) -> Result<(), ModelRequestError> {
        self.model_output_media_bytes = self
            .model_output_media_bytes
            .checked_add(bytes)
            .ok_or_else(|| {
                ModelRequestError::new(
                    "model_response_too_large",
                    "Model output media total overflowed its size bound.",
                )
            })?;
        if self.model_output_media_bytes > MAX_MODEL_OUTPUT_MEDIA_TOTAL_BYTES {
            return Err(ModelRequestError::new(
                "model_response_too_large",
                format!(
                    "Model output media exceeds the {MAX_MODEL_OUTPUT_MEDIA_TOTAL_BYTES}-byte command limit."
                ),
            ));
        }
        Ok(())
    }
}

fn remote_endpoint_error_json(status: u16, body: &Value) -> ModelRequestError {
    let safe = redact_model_request_value(body, std::iter::empty());
    let body = serde_json::to_string(&safe).expect("redacted JSON values always serialize");
    ModelRequestError::new(
        "model_request_failed",
        format!(
            "Model endpoint rejected request (HTTP {status}): {}",
            bounded_remote_text(body)
        ),
    )
}

fn remote_endpoint_error_bytes(status: u16, body: &[u8]) -> ModelRequestError {
    if let Ok(body) = serde_json::from_slice::<Value>(body) {
        return remote_endpoint_error_json(status, &body);
    }
    ModelRequestError::new(
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
    if responses.len() < MAX_MODEL_REQUEST_TRACE_ENTRIES
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
    payloads: Vec<ModelArtifactPayload>,
    safe_request: Value,
    context: ExecutionContext<'_>,
) -> Result<ModelExecution, ModelRequestError> {
    if payloads.is_empty() {
        return Err(ModelRequestError::new(
            "model_response_invalid",
            "Model response did not include a media output.",
        ));
    }
    let total = payloads
        .iter()
        .try_fold(0_usize, |total, payload| {
            total.checked_add(payload.bytes.len())
        })
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_too_large",
                "Model artifact total overflowed its size bound.",
            )
        })?;
    if total > MAX_MODEL_OUTPUT_MEDIA_TOTAL_BYTES {
        return Err(ModelRequestError::new(
            "model_response_too_large",
            format!(
                "Model artifacts exceed the {MAX_MODEL_OUTPUT_MEDIA_TOTAL_BYTES}-byte command limit."
            ),
        ));
    }
    Ok(ModelExecution {
        payloads,
        safe_request,
        safe_responses: context.safe_responses,
    })
}

pub(crate) fn materialize_argument_defaults(
    model_id: &str,
    schema: &Value,
    arguments: &mut Map<String, Value>,
) -> Result<(), ModelRequestError> {
    materialize_object_defaults(model_id, "arguments", schema, arguments)
}

fn materialize_object_defaults(
    model_id: &str,
    path: &str,
    schema: &Value,
    object: &mut Map<String, Value>,
) -> Result<(), ModelRequestError> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ModelRequestError::new(
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
) -> Result<(), ModelRequestError> {
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

pub(crate) fn authorization(api_key: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("authorization".to_owned(), format!("Bearer {api_key}")),
        ("content-type".to_owned(), "application/json".to_owned()),
    ])
}

pub(crate) fn is_string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

pub(crate) fn join_url(base: &str, suffix: &str) -> Result<String, ModelRequestError> {
    let base = format!("{}/", base.trim_end_matches('/'));
    url::Url::parse(&base)
        .and_then(|url| url.join(suffix.trim_start_matches('/')))
        .map(String::from)
        .map_err(|error| ModelRequestError::new("model_configuration_invalid", error.to_string()))
}

pub(crate) fn decode_base64(value: &str, label: &str) -> Result<Vec<u8>, ModelRequestError> {
    if value.len() > MAX_MODEL_OUTPUT_MEDIA_BYTES.saturating_mul(4) / 3 + 8 {
        return Err(ModelRequestError::new(
            "model_response_too_large",
            format!("{label} exceeds the model-output-media limit."),
        ));
    }
    let bytes = BASE64.decode(value).map_err(|error| {
        ModelRequestError::new(
            "model_response_invalid",
            format!("{label} is not valid base64: {error}"),
        )
    })?;
    if bytes.len() > MAX_MODEL_OUTPUT_MEDIA_BYTES {
        return Err(ModelRequestError::new(
            "model_response_too_large",
            format!("{label} exceeds the model-output-media limit."),
        ));
    }
    Ok(bytes)
}

fn encoded_base64_len(bytes: usize) -> Result<usize, ModelRequestError> {
    bytes
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or_else(model_request_too_large)
}

fn input_data_url_layout(
    value: &str,
    maximum_bytes: usize,
) -> Result<(usize, usize), ModelRequestError> {
    let payload = value.strip_prefix("data:").ok_or_else(|| {
        ModelRequestError::new(
            "model_request_input_invalid",
            "Media data URL is malformed.",
        )
    })?;
    let (header, encoded) = payload.split_once(',').ok_or_else(|| {
        ModelRequestError::new(
            "model_request_input_invalid",
            "Media data URL is malformed.",
        )
    })?;
    let mime_type = header
        .strip_suffix(";base64")
        .filter(|mime| !mime.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_input_invalid",
                "Media data URL must use base64 encoding.",
            )
        })?;
    if encoded.len() % 4 != 0 {
        return Err(ModelRequestError::new(
            "model_request_input_invalid",
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

fn model_request_too_large() -> ModelRequestError {
    ModelRequestError::new(
        "model_request_too_large",
        "Model request exceeds the Runtime request-size limit.",
    )
}

fn input_media_too_large(maximum_bytes: usize) -> ModelRequestError {
    ModelRequestError::new(
        "model_request_input_too_large",
        format!("Input media exceeds the {maximum_bytes}-byte item limit."),
    )
}

pub(crate) fn decode_data_url(
    value: &str,
    maximum_bytes: usize,
) -> Result<(String, Vec<u8>), ModelRequestError> {
    let (metadata, encoded) = value.split_once(',').ok_or_else(|| {
        ModelRequestError::new(
            "model_request_input_invalid",
            "Media data URL is malformed.",
        )
    })?;
    let mime = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_input_invalid",
                "Media data URL must contain base64 bytes and a MIME type.",
            )
        })?;
    if encoded.len() > maximum_bytes.saturating_mul(4) / 3 + 8 {
        return Err(ModelRequestError::new(
            "model_request_input_too_large",
            "Media data URL exceeds the input limit.",
        ));
    }
    let bytes = BASE64.decode(encoded).map_err(|error| {
        ModelRequestError::new("model_request_input_invalid", error.to_string())
    })?;
    if bytes.len() > maximum_bytes {
        return Err(ModelRequestError::new(
            "model_request_input_too_large",
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

pub(crate) fn extension_for_mime(mime: &str) -> Result<&'static str, ModelRequestError> {
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
        value => Err(ModelRequestError::new(
            "model_artifact_type_unsupported",
            format!("Model artifact MIME type is unsupported: {value}"),
        )),
    }
}

struct OutputNaming {
    directory: PathBuf,
    basename: String,
}

impl OutputNaming {
    fn new(request: &ModelRequest) -> Self {
        Self {
            directory: PathBuf::from(&request.output.directory),
            basename: request.output.name.clone(),
        }
    }

    fn path(&self, extension: &str, index: usize, count: usize) -> PathBuf {
        let filename = if count == 1 {
            format!("{}.{extension}", self.basename)
        } else {
            format!("{}_{}.{extension}", self.basename, index + 1)
        };
        self.directory.join(filename)
    }
}

pub(crate) struct StagedModelExecution {
    files: Vec<ModelArtifactWrite>,
    provenance: Vec<RecordModelArtifactProvenanceInput>,
}

struct ModelArtifactWrite {
    target: PathBuf,
    content: Vec<u8>,
    replace: bool,
}

pub(crate) fn stage_execution(
    operation_id: &str,
    item_index: usize,
    request: &ModelRequest,
    replace: bool,
    execution: ModelExecution,
    configured_secrets: &[String],
) -> Result<(StagedModelExecution, Vec<ArtifactPointer>), ModelRequestError> {
    let item_index = u64::try_from(item_index).map_err(|_| {
        ModelRequestError::new(
            "model_response_too_large",
            "Model Operation item index exceeds the supported range.",
        )
    })?;
    let safe_request =
        redact_model_request_value(&execution.safe_request, configured_secrets.iter().cloned());
    let safe_trace = redact_model_request_value(
        &Value::Array(execution.safe_responses),
        configured_secrets.iter().cloned(),
    )
    .as_array()
    .cloned()
    .expect("redacting a JSON array preserves its container type");
    let naming = OutputNaming::new(request);
    let extensions = execution
        .payloads
        .iter()
        .map(|payload| extension_for_mime(&payload.mime_type).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let mut extension_counts = HashMap::<String, usize>::new();
    for extension in &extensions {
        *extension_counts.entry(extension.clone()).or_default() += 1;
    }
    let mut extension_indexes = HashMap::<String, usize>::new();
    let mut output_files = Vec::with_capacity(execution.payloads.len());
    let mut provenance = Vec::with_capacity(execution.payloads.len());
    let mut artifacts = Vec::with_capacity(execution.payloads.len());
    for (index, (payload, extension)) in execution.payloads.into_iter().zip(extensions).enumerate()
    {
        let artifact_index = u64::try_from(index).map_err(|_| {
            ModelRequestError::new(
                "model_response_too_large",
                "Model Artifact count exceeds the supported index range.",
            )
        })?;
        let dimensions = if payload.mime_type.starts_with("image/") {
            model_artifact_image_dimensions(&payload.bytes)?
        } else {
            (None, None)
        };
        let extension_index = extension_indexes.entry(extension.clone()).or_default();
        let path = naming.path(&extension, *extension_index, extension_counts[&extension]);
        *extension_index += 1;
        let output =
            redact_model_request_value(&payload.model_output, configured_secrets.iter().cloned());
        output_files.push(ModelArtifactWrite {
            target: path.clone(),
            content: payload.bytes,
            replace,
        });
        provenance.push(RecordModelArtifactProvenanceInput {
            operation_id: operation_id.to_owned(),
            item_index,
            output_path: path.clone(),
            artifact_index,
            mime_type: payload.mime_type.clone(),
            request: safe_request.clone(),
            response: ModelArtifactProvenanceResponse {
                trace: safe_trace.clone(),
                output,
            },
        });
        let (width, height) = dimensions;
        artifacts.push(ArtifactPointer {
            artifact_index,
            output_path: path
                .to_str()
                .expect("accepted Model Operation output paths are UTF-8")
                .to_owned(),
            mime_type: payload.mime_type,
            width,
            height,
        });
    }
    Ok((
        StagedModelExecution {
            files: output_files,
            provenance,
        },
        artifacts,
    ))
}

pub(crate) fn commit_staged_execution(
    staged: StagedModelExecution,
    provenance_store: &ModelArtifactProvenanceStore,
) -> Result<ModelOperationCommitWarnings, ModelRequestError> {
    let StagedModelExecution { files, provenance } = staged;
    let provenance_commit = provenance_store.begin_commit();
    let artifact_cleanup_failures = commit_model_artifacts(files)?;
    let mut provenance_failures = 0_usize;
    for input in provenance {
        if provenance_commit.record(input).is_err() {
            provenance_failures += 1;
        }
    }
    Ok(ModelOperationCommitWarnings {
        provenance_failures,
        artifact_cleanup_failures,
    })
}

#[cfg(test)]
pub(crate) fn commit_execution(
    operation_id: &str,
    request: &ModelRequest,
    replace: bool,
    execution: ModelExecution,
    provenance_store: &ModelArtifactProvenanceStore,
    configured_secrets: &[String],
) -> Result<Vec<ArtifactPointer>, ModelRequestError> {
    let (staged, artifacts) = stage_execution(
        operation_id,
        0,
        request,
        replace,
        execution,
        configured_secrets,
    )?;
    let _provenance_failures = commit_staged_execution(staged, provenance_store)?;
    Ok(artifacts)
}

struct PendingArtifactPublish {
    temporary: PathBuf,
    target: PathBuf,
    backup: Option<PathBuf>,
    replace: bool,
    published: bool,
}

fn commit_model_artifacts(files: Vec<ModelArtifactWrite>) -> Result<usize, ModelRequestError> {
    let mut publishes = Vec::with_capacity(files.len());
    let mut created_directories = Vec::new();
    let result = (|| {
        for file in files {
            let directory = file.target.parent().ok_or_else(|| {
                artifact_commit_error("Model Artifact output has no parent directory.")
            })?;
            ensure_output_directory(directory, &mut created_directories)?;
            match fs::symlink_metadata(&file.target) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(artifact_commit_error(format!(
                        "Model Artifact target is not an ordinary file: {}",
                        file.target.display()
                    )));
                }
                Ok(_) if !file.replace => {
                    return Err(artifact_commit_error(format!(
                        "Model Artifact target already exists: {}",
                        file.target.display()
                    )));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(artifact_commit_error(error.to_string())),
            }
            let name = file
                .target
                .file_name()
                .ok_or_else(|| artifact_commit_error("Model Artifact output has no filename."))?;
            let temporary = directory.join(format!(
                ".{}.{}.tmp",
                name.to_string_lossy(),
                Uuid::new_v4()
            ));
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            let mut handle = options
                .open(&temporary)
                .map_err(|error| artifact_commit_error(error.to_string()))?;
            publishes.push(PendingArtifactPublish {
                temporary,
                target: file.target,
                backup: None,
                replace: file.replace,
                published: false,
            });
            handle
                .write_all(&file.content)
                .and_then(|()| handle.sync_all())
                .map_err(|error| artifact_commit_error(error.to_string()))?;
        }
        for publish in &mut publishes {
            match fs::symlink_metadata(&publish.target) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(artifact_commit_error(format!(
                        "Model Artifact target is not an ordinary file: {}",
                        publish.target.display()
                    )));
                }
                Ok(_) if publish.replace => {
                    let backup = publish.target.with_file_name(format!(
                        ".{}.{}.restore.tmp",
                        publish
                            .target
                            .file_name()
                            .expect("validated output has a filename")
                            .to_string_lossy(),
                        Uuid::new_v4()
                    ));
                    fs::rename(&publish.target, &backup)
                        .map_err(|error| artifact_commit_error(error.to_string()))?;
                    publish.backup = Some(backup);
                    fs::rename(&publish.temporary, &publish.target)
                        .map_err(|error| artifact_commit_error(error.to_string()))?;
                }
                Ok(_) => {
                    return Err(artifact_commit_error(format!(
                        "Model Artifact target already exists: {}",
                        publish.target.display()
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::hard_link(&publish.temporary, &publish.target)
                        .map_err(|error| artifact_commit_error(error.to_string()))?;
                }
                Err(error) => return Err(artifact_commit_error(error.to_string())),
            }
            publish.published = true;
        }
        Ok(())
    })();
    if let Err(error) = result {
        rollback_model_artifacts(&mut publishes);
        cleanup_created_directories(&created_directories);
        return Err(error);
    }
    let mut cleanup_failures = 0_usize;
    for publish in publishes {
        cleanup_failures += remove_published_temporary(&publish.temporary);
        if let Some(backup) = publish.backup {
            cleanup_failures += remove_published_temporary(&backup);
        }
    }
    Ok(cleanup_failures)
}

fn remove_published_temporary(path: &Path) -> usize {
    match fs::remove_file(path) {
        Ok(()) => 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => 1,
    }
}

fn ensure_output_directory(
    directory: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), ModelRequestError> {
    if directory.is_dir() {
        let canonical = directory
            .canonicalize()
            .map_err(|error| artifact_commit_error(error.to_string()))?;
        return if canonical == directory {
            Ok(())
        } else {
            Err(artifact_commit_error(
                "Model Artifact directory no longer resolves to the accepted path.",
            ))
        };
    }
    let mut cursor = directory;
    while !cursor.exists() {
        created.push(cursor.to_path_buf());
        cursor = cursor.parent().ok_or_else(|| {
            artifact_commit_error("Model Artifact directory has no existing ancestor.")
        })?;
    }
    fs::create_dir_all(directory).map_err(|error| artifact_commit_error(error.to_string()))?;
    let canonical = directory
        .canonicalize()
        .map_err(|error| artifact_commit_error(error.to_string()))?;
    if canonical != directory {
        return Err(artifact_commit_error(
            "Model Artifact directory no longer resolves to the accepted path.",
        ));
    }
    Ok(())
}

fn rollback_model_artifacts(publishes: &mut [PendingArtifactPublish]) {
    for publish in publishes.iter_mut().rev() {
        if publish.published {
            let _ = fs::remove_file(&publish.target);
        }
        if let Some(backup) = publish.backup.take() {
            let _ = fs::rename(backup, &publish.target);
        }
        let _ = fs::remove_file(&publish.temporary);
    }
}

fn cleanup_created_directories(created: &[PathBuf]) {
    for directory in created {
        let _ = fs::remove_dir(directory);
    }
}

fn artifact_commit_error(message: impl Into<String>) -> ModelRequestError {
    ModelRequestError::new("model_artifact_commit_failed", message)
}

fn model_artifact_image_dimensions(
    bytes: &[u8],
) -> Result<(Option<u32>, Option<u32>), ModelRequestError> {
    use image::ImageDecoder as _;

    let cursor = std::io::Cursor::new(bytes);
    let mut reader = image::ImageReader::new(cursor);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_MODEL_ARTIFACT_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_MODEL_ARTIFACT_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_MODEL_ARTIFACT_IMAGE_ALLOCATION);
    reader.limits(limits);
    let reader = reader.with_guessed_format().map_err(|error| {
        ModelRequestError::new(
            "model_artifact_invalid",
            format!("Model output image format could not be inspected: {error}"),
        )
    })?;
    let decoder = reader.into_decoder().map_err(|error| {
        ModelRequestError::new(
            "model_artifact_invalid",
            format!("Model output image header could not be inspected: {error}"),
        )
    })?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_MODEL_ARTIFACT_IMAGE_DIMENSION
        || height > MAX_MODEL_ARTIFACT_IMAGE_DIMENSION
        || u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(4)
            > MAX_MODEL_ARTIFACT_IMAGE_ALLOCATION
    {
        return Err(ModelRequestError::new(
            "model_artifact_invalid",
            "Model output image dimensions exceed the safe inspection limit.",
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
    use crate::model_request::ModelArtifactProvenanceStore;

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
    fn shared_image_registry_is_used_for_model_request_inputs() {
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
    fn model_output_numbers_only_artifacts_with_the_same_extension() {
        let root = std::env::temp_dir().join(format!("debrute-model-request-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let execution = ModelExecution {
            payloads: vec![
                ModelArtifactPayload {
                    bytes: b"audio".to_vec(),
                    mime_type: "audio/mpeg".to_owned(),
                    model_output: Value::Null,
                },
                ModelArtifactPayload {
                    bytes: b"video".to_vec(),
                    mime_type: "video/mp4".to_owned(),
                    model_output: Value::Null,
                },
                ModelArtifactPayload {
                    bytes: b"audio-two".to_vec(),
                    mime_type: "audio/mpeg".to_owned(),
                    model_output: Value::Null,
                },
                ModelArtifactPayload {
                    bytes: b"video-two".to_vec(),
                    mime_type: "video/mp4".to_owned(),
                    model_output: Value::Null,
                },
            ],
            safe_request: Value::Null,
            safe_responses: Vec::new(),
        };
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: crate::model_operation::ModelOutput {
                directory: root.join("generated").to_string_lossy().into_owned(),
                name: "covers".to_owned(),
            },
        };
        let provenance = ModelArtifactProvenanceStore::new(&root.join("home"));
        let artifacts =
            commit_execution("operation", &request, false, execution, &provenance, &[]).unwrap();
        assert_eq!(artifacts[0].artifact_index, 0);
        assert_eq!(artifacts[1].artifact_index, 1);
        assert_eq!(
            artifacts
                .iter()
                .map(|artifact| artifact.output_path.as_str())
                .collect::<Vec<_>>(),
            vec![
                root.join("generated/covers_1.mp3").to_str().unwrap(),
                root.join("generated/covers_1.mp4").to_str().unwrap(),
                root.join("generated/covers_2.mp3").to_str().unwrap(),
                root.join("generated/covers_2.mp4").to_str().unwrap(),
            ]
        );
        assert_eq!(
            std::fs::read(root.join("generated/covers_1.mp3")).unwrap(),
            b"audio"
        );
        assert_eq!(
            std::fs::read(root.join("generated/covers_1.mp4")).unwrap(),
            b"video"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provenance_failure_does_not_roll_back_published_output() {
        let root = std::env::temp_dir().join(format!("debrute-model-request-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("generated")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("generated/covers.mp3"), b"old").unwrap();
        let execution = ModelExecution {
            payloads: vec![ModelArtifactPayload {
                bytes: b"new".to_vec(),
                mime_type: "audio/mpeg".to_owned(),
                model_output: Value::Null,
            }],
            safe_request: Value::Null,
            safe_responses: Vec::new(),
        };
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: crate::model_operation::ModelOutput {
                directory: root.join("generated").to_string_lossy().into_owned(),
                name: "covers".to_owned(),
            },
        };

        let blocked_home = root.join("blocked-home");
        std::fs::write(&blocked_home, b"not a directory").unwrap();
        let artifacts = commit_execution(
            "operation",
            &request,
            true,
            execution,
            &ModelArtifactProvenanceStore::new(&blocked_home),
            &[],
        )
        .unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(
            std::fs::read(root.join("generated/covers.mp3")).unwrap(),
            b"new"
        );
        let temporary = std::fs::read_dir(root.join("generated"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_multi_artifact_publish_removes_earlier_targets_and_staging_files() {
        let root = std::env::temp_dir().join(format!("debrute-model-request-{}", Uuid::new_v4()));
        let generated = root.join("generated");
        std::fs::create_dir_all(&generated).unwrap();
        std::fs::write(generated.join("second.mp3"), b"existing").unwrap();

        let error = commit_model_artifacts(vec![
            ModelArtifactWrite {
                target: generated.join("first.mp3"),
                content: b"first".to_vec(),
                replace: false,
            },
            ModelArtifactWrite {
                target: generated.join("second.mp3"),
                content: b"second".to_vec(),
                replace: false,
            },
        ])
        .unwrap_err();

        assert_eq!(error.code(), "model_artifact_commit_failed");
        assert!(!generated.join("first.mp3").exists());
        assert_eq!(
            std::fs::read(generated.join("second.mp3")).unwrap(),
            b"existing"
        );
        assert_eq!(
            std::fs::read_dir(&generated)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_model_commits_serialize_files_with_their_provenance() {
        let root = std::env::temp_dir().join(format!("debrute-model-request-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("generated")).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(root.join("generated/shared.mp3"), b"original").unwrap();
        let metadata = Arc::new(ModelArtifactProvenanceStore::new(&root.join("home")));
        let barrier = Arc::new(Barrier::new(2));
        let request = ModelRequest {
            model: "fixture".to_owned(),
            arguments: Map::new(),
            output: crate::model_operation::ModelOutput {
                directory: root.join("generated").to_string_lossy().into_owned(),
                name: "shared".to_owned(),
            },
        };
        let threads = [b"first".to_vec(), b"second".to_vec()].map(|bytes| {
            let metadata = Arc::clone(&metadata);
            let barrier = Arc::clone(&barrier);
            let request = request.clone();
            std::thread::spawn(move || {
                barrier.wait();
                commit_execution(
                    &Uuid::new_v4().to_string(),
                    &request,
                    true,
                    ModelExecution {
                        payloads: vec![ModelArtifactPayload {
                            bytes,
                            mime_type: "audio/mpeg".to_owned(),
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
        assert!(
            metadata
                .lookup(&root.join("generated/shared.mp3"))
                .unwrap()
                .record
                .is_some()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_request_trace_has_count_and_byte_bounds() {
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
        assert!(responses.len() <= MAX_MODEL_REQUEST_TRACE_ENTRIES + 1);
        assert!(bytes <= MAX_MODEL_RUN_RESPONSE_LOG_BYTES);
    }
}
