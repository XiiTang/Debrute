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
    let output_format = match body.remove("output_format") {
        Some(Value::String(value)) => Some(value),
        Some(_) => {
            return Err(ModelRequestError::new(
                "model_request_argument_invalid",
                "elevenlabs-music output_format must be a string for query mapping.",
            ));
        }
        None => None,
    };
    if body.contains_key("model_id") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "elevenlabs-music arguments.model_id conflicts with the configured request model ID.",
        ));
    }
    body.insert(
        "model_id".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let mut url =
        url::Url::parse(&join_url(&context.model.base_url, "music")?).map_err(|error| {
            ModelRequestError::new("model_configuration_invalid", error.to_string())
        })?;
    if let Some(output_format) = &output_format {
        url.query_pairs_mut()
            .append_pair("output_format", output_format);
    }
    let headers = BTreeMap::from([("xi-api-key".to_owned(), context.model.api_key.clone())]);
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
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "elevenlabs-music response audio type could not be identified.",
            )
        })?;
    let mut payload = audio_payload(response.body, &mime)?;
    payload.model_output = json!({"songId": response.headers.get("song-id")});
    Ok(ModelExecutionDraft {
        payloads: vec![payload],
        safe_request: json!({
            "method": "POST",
            "url": url.as_str(),
            "headers": {"xi-api-key": "[REDACTED]"},
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
