use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::{AudioResult, audio_payload};
use crate::generation::{
    common::{ExecutionContext, decode_base64, join_url},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut arguments = context.arguments.clone();
    let text = arguments.remove("text").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "gemini-3-1-flash-tts-preview requires text.",
        )
    })?;
    let speech_config = arguments.remove("speech_config").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "gemini-3-1-flash-tts-preview requires speech_config.",
        )
    })?;
    let mut generation_config = Map::from_iter([("speech_config".to_owned(), speech_config)]);
    if let Some(language) = arguments.remove("language") {
        generation_config.insert("language".to_owned(), language);
    }
    let mut body = arguments;
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    body.insert("input".to_owned(), text);
    body.insert("response_format".to_owned(), json!({"type": "audio"}));
    body.insert(
        "generation_config".to_owned(),
        Value::Object(generation_config),
    );
    body.insert("store".to_owned(), Value::Bool(false));
    let body = Value::Object(body);
    let url = join_url(&context.model.base_url, "interactions")?;
    let headers = BTreeMap::from([
        ("x-goog-api-key".to_owned(), context.model.api_key.clone()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(body.clone()),
    )?;
    let (bytes, mime) = audio_response(&response)?;
    Ok(AudioResult {
        payloads: vec![audio_payload(bytes, &mime, context)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"x-goog-api-key": "[REDACTED]", "content-type": "application/json"},
            "body": body,
        }),
    })
}

fn audio_response(response: &Value) -> Result<(Vec<u8>, String), GenerationError> {
    let mut bytes = Vec::new();
    let mut mime = None::<String>;
    for step in response
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
    {
        let output_items = step
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                GenerationError::new(
                    "model_response_invalid",
                    "gemini-3-1-flash-tts-preview model_output omitted content.",
                )
            })?;
        for item in output_items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("audio"))
        {
            let item_mime = item
                .get("mime_type")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("audio/"))
                .ok_or_else(|| {
                    GenerationError::new(
                        "model_response_invalid",
                        "gemini-3-1-flash-tts-preview audio omitted mime_type.",
                    )
                })?;
            if mime.as_deref().is_some_and(|mime| mime != item_mime) {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    "gemini-3-1-flash-tts-preview returned mixed audio MIME types.",
                ));
            }
            mime.get_or_insert_with(|| item_mime.to_owned());
            let data = item
                .get("data")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    GenerationError::new(
                        "model_response_invalid",
                        "gemini-3-1-flash-tts-preview audio omitted data.",
                    )
                })?;
            bytes.extend(decode_base64(data, "Gemini TTS audio")?);
        }
    }
    let mime = mime.ok_or_else(|| {
        GenerationError::new(
            "model_response_invalid",
            "gemini-3-1-flash-tts-preview response contained no audio.",
        )
    })?;
    Ok((bytes, mime))
}
