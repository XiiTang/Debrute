use serde_json::Value;

use super::{AudioResult, decode_hex, single_audio_result};
use crate::generation::{
    common::{
        ExecutionContext, authorization, join_url, mime_from_path_or_bytes, mime_from_response,
    },
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut body = context.arguments.clone();
    let output_format = body
        .get("output_format")
        .and_then(Value::as_str)
        .unwrap_or("hex")
        .to_owned();
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let url = join_url(&context.model.base_url, "v1/music_generation")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    reject_business_error(&response)?;
    let audio = response
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "minimax-music-3-0 response omitted data.audio.",
            )
        })?;
    match output_format.as_str() {
        "hex" => {
            let format = response
                .pointer("/extra_info/audio_format")
                .and_then(Value::as_str)
                .or_else(|| {
                    body.get("audio_setting")
                        .and_then(Value::as_object)
                        .and_then(|audio| audio.get("format"))
                        .and_then(Value::as_str)
                })
                .unwrap_or("mp3");
            single_audio_result(
                decode_hex(audio)?,
                format_mime(format)?,
                context,
                &url,
                &Value::Object(body),
            )
        }
        "url" => {
            let downloaded = context.download_generated_media(audio)?;
            let mime = mime_from_response(&downloaded)
                .filter(|mime| mime.starts_with("audio/"))
                .or_else(|| mime_from_path_or_bytes(audio, &downloaded.body).map(str::to_owned))
                .ok_or_else(|| {
                    GenerationError::new(
                        "generated_artifact_type_unsupported",
                        "minimax-music-3-0 URL audio type could not be identified.",
                    )
                })?;
            single_audio_result(downloaded.body, &mime, context, &url, &Value::Object(body))
        }
        _ => Err(GenerationError::new(
            "model_response_invalid",
            format!("minimax-music-3-0 returned for unsupported output_format {output_format}."),
        )),
    }
}

fn reject_business_error(response: &Value) -> Result<(), GenerationError> {
    let Some(code) = response
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
    else {
        return Ok(());
    };
    let message = response
        .pointer("/base_resp/status_msg")
        .and_then(Value::as_str)
        .unwrap_or("MiniMax returned no status message.");
    let trace = response
        .get("trace_id")
        .or_else(|| response.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    Err(GenerationError::new(
        "generation_task_failed",
        format!("MiniMax Music rejected request (remote code {code}, trace {trace}): {message}"),
    ))
}

fn format_mime(format: &str) -> Result<&'static str, GenerationError> {
    match format {
        "mp3" => Ok("audio/mpeg"),
        "pcm" => Ok("audio/pcm"),
        "flac" => Ok("audio/flac"),
        "wav" => Ok("audio/wav"),
        "opus" => Ok("audio/ogg"),
        _ => Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("minimax-music-3-0 returned unsupported audio format {format}."),
        )),
    }
}
