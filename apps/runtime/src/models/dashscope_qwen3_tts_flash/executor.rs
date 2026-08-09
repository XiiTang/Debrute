use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::model_request::audio::audio_payload;
use crate::model_request::types::ModelExecutionDraft;
use crate::model_request::{
    common::{ExecutionContext, join_url, mime_from_path_or_bytes, mime_from_response},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let mut arguments = context.arguments.clone();
    let mut input = Map::new();
    if let Some(text) = arguments.remove("text") {
        input.insert("text".to_owned(), text);
    }
    if let Some(voice) = arguments.remove("voice") {
        input.insert("voice".to_owned(), voice);
    }
    if let Some(language_type) = arguments.remove("language_type") {
        input.insert("language_type".to_owned(), language_type);
    }
    input.extend(arguments);
    let body = json!({
        "model": context.model.request_model_id,
        "input": input,
    });
    let url = join_url(
        &context.model.base_url,
        "services/aigc/multimodal-generation/generation",
    )?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Json(body.clone()),
    )?;
    let audio_url = response
        .pointer("/output/audio/url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "dashscope-qwen3-tts-flash response omitted output.audio.url.",
            )
        })?;
    let audio = context.download_model_output_media(audio_url)?;
    let mime = mime_from_response(&audio)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes(audio_url, &audio.body).map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "dashscope-qwen3-tts-flash output audio type could not be identified.",
            )
        })?;
    Ok(ModelExecutionDraft {
        payloads: vec![audio_payload(audio.body, &mime)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}
