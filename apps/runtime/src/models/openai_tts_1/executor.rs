use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::model_request::audio::audio_payload;
use crate::model_request::types::ModelExecutionDraft;
use crate::model_request::{
    common::{ExecutionContext, join_url, mime_from_path_or_bytes, mime_from_response},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let mut body = context.arguments.clone();
    let text = body.remove("text");
    let requested_format = optional_string(&mut body, "format")?;
    if let Some(text) = text
        && body.insert("input".to_owned(), text).is_some()
    {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "openai-tts-1 cannot map both text and input.",
        ));
    }
    if body.contains_key("model") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "openai-tts-1 arguments.model conflicts with the configured request model ID.",
        ));
    }
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    if let Some(format) = &requested_format
        && body
            .insert("response_format".to_owned(), Value::String(format.clone()))
            .is_some()
    {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "openai-tts-1 cannot map both format and response_format.",
        ));
    }
    let url = join_url(&context.model.base_url, "audio/speech")?;
    let response = context.bytes(
        HttpMethod::Post,
        url.clone(),
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let mime = mime_from_response(&response)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes("", &response.body).map(str::to_owned))
        .or_else(|| requested_format.as_deref().and_then(format_mime))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "openai-tts-1 response audio type could not be identified.",
            )
        })?;
    Ok(ModelExecutionDraft {
        payloads: vec![audio_payload(response.body, &mime)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": Value::Object(body),
        }),
    })
}

fn optional_string(
    body: &mut serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<String>, ModelRequestError> {
    body.remove(name)
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                ModelRequestError::new(
                    "model_request_argument_invalid",
                    format!("openai-tts-1 {name} must be a string for request mapping."),
                )
            })
        })
        .transpose()
}

fn format_mime(format: &str) -> Option<String> {
    Some(
        match format {
            "mp3" => "audio/mpeg",
            "opus" => "audio/ogg",
            "aac" => "audio/aac",
            "flac" => "audio/flac",
            "wav" => "audio/wav",
            "pcm" => "audio/pcm",
            _ => return None,
        }
        .to_owned(),
    )
}
