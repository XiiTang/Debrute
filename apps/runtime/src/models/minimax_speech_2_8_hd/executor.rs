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
    let output_format = match body.get("output_format") {
        Some(Value::String(value)) => value.clone(),
        Some(_) => {
            return Err(ModelRequestError::new(
                "model_request_argument_invalid",
                "minimax-speech-2-8-hd output_format must be a string because it controls response decoding.",
            ));
        }
        None => "hex".to_owned(),
    };
    if body.contains_key("model") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "minimax-speech-2-8-hd arguments.model conflicts with the configured request model ID.",
        ));
    }
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let url = join_url(&context.model.base_url, "v1/t2a_v2")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    reject_business_error(&response)?;
    let audio = response
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "minimax-speech-2-8-hd response omitted data.audio.",
            )
        })?;
    let (bytes, mime) = match output_format.as_str() {
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
            (decode_hex(audio)?, format_mime(format)?.to_owned())
        }
        "url" => {
            let downloaded = context.download_model_output_media(audio)?;
            let mime = mime_from_response(&downloaded)
                .filter(|mime| mime.starts_with("audio/"))
                .or_else(|| mime_from_path_or_bytes(audio, &downloaded.body).map(str::to_owned))
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "model_artifact_type_unsupported",
                        "minimax-speech-2-8-hd URL audio type could not be identified.",
                    )
                })?;
            (downloaded.body, mime)
        }
        _ => {
            return Err(ModelRequestError::new(
                "model_response_invalid",
                format!(
                    "minimax-speech-2-8-hd returned for unsupported output_format {output_format}."
                ),
            ));
        }
    };
    Ok(ModelExecutionDraft {
        payloads: vec![audio_payload(bytes, &mime)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": Value::Object(body),
        }),
    })
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ModelRequestError> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ModelRequestError::new(
            "model_response_invalid",
            "minimax-speech-2-8-hd audio was not an even-length hexadecimal string.",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|error| {
                ModelRequestError::new("model_response_invalid", error.to_string())
            })?;
            u8::from_str_radix(text, 16).map_err(|error| {
                ModelRequestError::new("model_response_invalid", error.to_string())
            })
        })
        .collect()
}

fn reject_business_error(response: &Value) -> Result<(), ModelRequestError> {
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
    Err(ModelRequestError::new(
        "model_request_task_failed",
        format!("MiniMax Speech rejected request (remote code {code}, trace {trace}): {message}"),
    ))
}

fn format_mime(format: &str) -> Result<&'static str, ModelRequestError> {
    match format {
        "mp3" => Ok("audio/mpeg"),
        "pcm" | "pcmu_raw" => Ok("audio/pcm"),
        "flac" => Ok("audio/flac"),
        "wav" | "pcmu_wav" => Ok("audio/wav"),
        "opus" => Ok("audio/ogg"),
        _ => Err(ModelRequestError::new(
            "model_artifact_type_unsupported",
            format!("minimax-speech-2-8-hd returned unsupported audio format {format}."),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::format_mime;

    #[test]
    fn maps_current_minimax_extended_audio_formats() {
        assert_eq!(
            format_mime("pcmu_raw").expect("raw G.711 format"),
            "audio/pcm"
        );
        assert_eq!(
            format_mime("pcmu_wav").expect("WAV-wrapped G.711 format"),
            "audio/wav"
        );
        assert_eq!(format_mime("opus").expect("Ogg Opus format"), "audio/ogg");
    }
}
