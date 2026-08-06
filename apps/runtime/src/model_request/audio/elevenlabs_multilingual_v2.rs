use std::collections::BTreeMap;

use serde_json::Value;

use super::{AudioResult, single_audio_result_with_headers};
use crate::model_request::{
    common::{ExecutionContext, mime_from_path_or_bytes, mime_from_response},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, ModelRequestError> {
    let mut body = context.arguments.clone();
    let voice_id = body
        .remove("voice_id")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                "elevenlabs-multilingual-v2 requires voice_id.",
            )
        })?;
    let output_format = match body.remove("output_format") {
        Some(Value::String(value)) => Some(value),
        Some(_) => {
            return Err(ModelRequestError::new(
                "model_request_argument_invalid",
                "elevenlabs-multilingual-v2 output_format must be a string for query mapping.",
            ));
        }
        None => None,
    };
    if body.contains_key("model_id") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "elevenlabs-multilingual-v2 arguments.model_id conflicts with the configured request model ID.",
        ));
    }
    body.insert(
        "model_id".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let mut url = url::Url::parse(&format!(
        "{}/",
        context.model.base_url.trim_end_matches('/')
    ))
    .map_err(|error| ModelRequestError::new("model_configuration_invalid", error.to_string()))?;
    url.path_segments_mut()
        .map_err(|()| {
            ModelRequestError::new(
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
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "elevenlabs-multilingual-v2 response audio type could not be identified.",
            )
        })?;
    single_audio_result_with_headers(
        response.body,
        &mime,
        &headers,
        url.as_str(),
        &Value::Object(body),
    )
}
