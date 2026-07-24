use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{AudioResult, single_audio_result_with_headers};
use crate::{
    generation::{
        common::{ExecutionContext, decode_base64, join_url},
        types::{GenerationError, HttpBody, HttpMethod},
    },
    project::GeneratedArtifactRole,
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut req_params = context.arguments.clone();
    let text = req_params.remove("text").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "doubao-seed-tts-2-0 requires text.",
        )
    })?;
    let speaker = req_params.remove("speaker").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "doubao-seed-tts-2-0 requires speaker.",
        )
    })?;
    let requested_format = req_params
        .get("audio_params")
        .and_then(Value::as_object)
        .and_then(|audio| audio.get("format"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    req_params.insert("text".to_owned(), text);
    req_params.insert("speaker".to_owned(), speaker);
    let body = json!({"req_params": req_params});
    let url = join_url(&context.model.base_url, "tts/unidirectional")?;
    let headers = BTreeMap::from([
        ("x-api-key".to_owned(), context.model.api_key.clone()),
        (
            "x-api-resource-id".to_owned(),
            context.model.request_model_id.clone(),
        ),
        (
            "x-api-request-id".to_owned(),
            uuid::Uuid::new_v4().to_string(),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.bytes(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(body.clone()),
    )?;
    let log_id = response.headers.get("x-tt-logid").cloned();
    let stream_text = std::str::from_utf8(&response.body)
        .map_err(|error| GenerationError::new("model_response_invalid", error.to_string()))?;
    let audio = decode_audio_frames(stream_text, log_id.as_deref())?;
    let mime = match requested_format.as_deref().unwrap_or("mp3") {
        "mp3" => "audio/mpeg",
        "ogg_opus" => "audio/ogg",
        "pcm" => "audio/pcm",
        format => {
            return Err(GenerationError::new(
                "generated_artifact_type_unsupported",
                format!("doubao-seed-tts-2-0 returned unsupported audio format {format}."),
            ));
        }
    };
    single_audio_result_with_headers(
        audio,
        mime,
        GeneratedArtifactRole::TtsAudio,
        &headers,
        &url,
        &body,
    )
}

fn decode_audio_frames(text: &str, log_id: Option<&str>) -> Result<Vec<u8>, GenerationError> {
    let mut audio = Vec::new();
    let mut completed = false;
    let stream = serde_json::Deserializer::from_str(text).into_iter::<Value>();
    for frame in stream {
        let frame = frame.map_err(|error| {
            GenerationError::new(
                "model_response_invalid",
                format!("doubao-seed-tts-2-0 returned malformed JSON frames: {error}"),
            )
        })?;
        let code = frame.get("code").and_then(Value::as_i64).ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "doubao-seed-tts-2-0 frame omitted code.",
            )
        })?;
        match code {
            0 => {
                if let Some(data) = frame.get("data").and_then(Value::as_str) {
                    audio.extend(decode_base64(data, "Doubao TTS frame")?);
                }
            }
            20_000_000 => completed = true,
            code => {
                let message = frame
                    .get("message")
                    .or_else(|| frame.get("msg"))
                    .and_then(Value::as_str)
                    .unwrap_or("Doubao returned no error message.");
                return Err(GenerationError::new(
                    "generation_task_failed",
                    format!(
                        "Doubao TTS rejected request (remote code {code}, log id {}): {message}",
                        log_id.unwrap_or("unavailable")
                    ),
                ));
            }
        }
    }
    if !completed || audio.is_empty() {
        return Err(GenerationError::new(
            "model_response_invalid",
            "doubao-seed-tts-2-0 response omitted complete audio frames.",
        ));
    }
    Ok(audio)
}
