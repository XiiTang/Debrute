use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{AudioResult, audio_payload};
use crate::generation::{
    common::{ExecutionContext, join_url, mime_from_path_or_bytes, mime_from_response},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut body = context.arguments.clone();
    let output_format = body
        .remove("output_format")
        .and_then(|value| value.as_str().map(str::to_owned));
    body.insert(
        "model_id".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let mut url = url::Url::parse(&join_url(&context.model.base_url, "music")?)
        .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    if let Some(output_format) = &output_format {
        url.query_pairs_mut()
            .append_pair("output_format", output_format);
    }
    let headers = BTreeMap::from([
        ("xi-api-key".to_owned(), context.model.api_key.clone()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.bytes(
        HttpMethod::Post,
        url.to_string(),
        headers,
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let mime = mime_from_response(&response)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes("", &response.body).map(str::to_owned))
        .or_else(|| {
            output_format
                .as_deref()
                .and_then(output_format_mime)
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "elevenlabs-music response audio type could not be identified.",
            )
        })?;
    let mut payload = audio_payload(response.body, &mime, context)?;
    payload.model_output = json!({"songId": response.headers.get("song-id")});
    Ok(AudioResult {
        payloads: vec![payload],
        safe_request: json!({
            "method": "POST",
            "url": url.as_str(),
            "headers": {"xi-api-key": "[REDACTED]", "content-type": "application/json"},
            "body": body,
        }),
    })
}

fn output_format_mime(format: &str) -> Option<&'static str> {
    if format.starts_with("mp3_") {
        Some("audio/mpeg")
    } else if format.starts_with("pcm_") {
        Some("audio/pcm")
    } else if format.starts_with("opus_") {
        Some("audio/ogg")
    } else if format.starts_with("wav_") {
        Some("audio/wav")
    } else {
        None
    }
}
