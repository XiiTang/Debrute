use std::collections::BTreeMap;

use serde_json::Value;

use super::{AudioResult, single_audio_result_with_headers};
use crate::{
    generation::{
        common::{ExecutionContext, mime_from_path_or_bytes, mime_from_response},
        types::{GenerationError, HttpBody, HttpMethod},
    },
    project::GeneratedArtifactRole,
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut body = context.arguments.clone();
    let voice_id = body
        .remove("voice_id")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "elevenlabs-v3-tts requires voice_id.",
            )
        })?;
    let output_format = body
        .remove("output_format")
        .and_then(|value| value.as_str().map(str::to_owned));
    body.insert(
        "model_id".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let mut url = url::Url::parse(&format!(
        "{}/",
        context.model.base_url.trim_end_matches('/')
    ))
    .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    url.path_segments_mut()
        .map_err(|()| {
            GenerationError::new(
                "model_configuration_invalid",
                "ElevenLabs base URL cannot contain path segments.",
            )
        })?
        .extend(["text-to-speech", voice_id.as_str()]);
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
        headers.clone(),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let mime = mime_from_response(&response)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes("", &response.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "elevenlabs-v3-tts response audio type could not be identified.",
            )
        })?;
    single_audio_result_with_headers(
        response.body,
        &mime,
        GeneratedArtifactRole::TtsAudio,
        &headers,
        url.as_str(),
        &Value::Object(body),
    )
}
