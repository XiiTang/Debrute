use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::model_request::audio::audio_payload;
use crate::model_request::types::ModelExecutionDraft;
use crate::model_request::{
    common::{ExecutionContext, decode_base64, join_url},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let body = build_body(context.arguments.clone(), &context.model.request_model_id)?;
    let url = join_url(&context.model.base_url, "interactions")?;
    let headers = BTreeMap::from([("x-goog-api-key".to_owned(), context.model.api_key.clone())]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(body.clone()),
    )?;
    let (bytes, mime) = audio_response(&response)?;
    Ok(ModelExecutionDraft {
        payloads: vec![audio_payload(bytes, &mime)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"x-goog-api-key": "[REDACTED]"},
            "body": body,
        }),
    })
}

fn build_body(
    mut arguments: Map<String, Value>,
    request_model_id: &str,
) -> Result<Value, ModelRequestError> {
    let text = arguments.remove("text");
    let speech_config = arguments.remove("speech_config");
    let mut generation_config = Map::new();
    if let Some(speech_config) = speech_config {
        generation_config.insert("speech_config".to_owned(), speech_config);
    }
    let mut body = arguments;
    for field in ["model", "response_format", "store"] {
        if body.contains_key(field) {
            return Err(ModelRequestError::new(
                "model_request_argument_collision",
                format!(
                    "gemini-3-1-flash-tts-preview arguments.{field} conflicts with Debrute request framing."
                ),
            ));
        }
    }
    if text.is_some() && body.contains_key("input") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "gemini-3-1-flash-tts-preview cannot map both text and input.",
        ));
    }
    if !generation_config.is_empty() && body.contains_key("generation_config") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "gemini-3-1-flash-tts-preview cannot merge flattened speech_config with generation_config.",
        ));
    }
    body.insert(
        "model".to_owned(),
        Value::String(request_model_id.to_owned()),
    );
    if let Some(text) = text {
        body.insert("input".to_owned(), text);
    }
    body.insert("response_format".to_owned(), json!({"type": "audio"}));
    if !generation_config.is_empty() {
        body.insert(
            "generation_config".to_owned(),
            Value::Object(generation_config),
        );
    }
    body.insert("store".to_owned(), Value::Bool(false));
    Ok(Value::Object(body))
}

fn audio_response(response: &Value) -> Result<(Vec<u8>, String), ModelRequestError> {
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
                ModelRequestError::new(
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
                    ModelRequestError::new(
                        "model_response_invalid",
                        "gemini-3-1-flash-tts-preview audio omitted mime_type.",
                    )
                })?;
            if mime.as_deref().is_some_and(|mime| mime != item_mime) {
                return Err(ModelRequestError::new(
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
                    ModelRequestError::new(
                        "model_response_invalid",
                        "gemini-3-1-flash-tts-preview audio omitted data.",
                    )
                })?;
            bytes.extend(decode_base64(data, "Gemini TTS audio")?);
        }
    }
    let mime = mime.ok_or_else(|| {
        ModelRequestError::new(
            "model_response_invalid",
            "gemini-3-1-flash-tts-preview response contained no audio.",
        )
    })?;
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_stays_inside_each_speech_config_item() {
        let body = build_body(
            Map::from_iter([
                ("text".to_owned(), json!("Hello")),
                (
                    "speech_config".to_owned(),
                    json!([{"speaker": "Narrator", "voice": "Kore", "language": "en-US"}]),
                ),
            ]),
            "gemini-3-1-flash-tts-preview",
        )
        .expect("valid Gemini TTS body");

        assert_eq!(
            body.pointer("/generation_config/speech_config/0/language"),
            Some(&json!("en-US"))
        );
        assert!(body.pointer("/generation_config/language").is_none());
        assert!(body.get("language").is_none());
    }
}
