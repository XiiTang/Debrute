use serde_json::Value;

use super::{
    common::extension_for_mime,
    types::{ModelArtifactPayload, ModelRequestError},
};

pub(crate) fn audio_payload(
    bytes: Vec<u8>,
    mime: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    if !mime.starts_with("audio/") {
        return Err(ModelRequestError::new(
            "model_artifact_type_unsupported",
            format!("Model audio output has non-audio MIME type: {mime}"),
        ));
    }
    extension_for_mime(mime)?;
    Ok(ModelArtifactPayload {
        bytes,
        mime_type: mime.to_owned(),
        model_output: Value::Null,
    })
}

pub(crate) fn assert_same_origin(base: &str, candidate: &str) -> Result<(), ModelRequestError> {
    let base = url::Url::parse(base).map_err(|error| {
        ModelRequestError::new("model_configuration_invalid", error.to_string())
    })?;
    let candidate = url::Url::parse(candidate)
        .map_err(|error| ModelRequestError::new("model_response_invalid", error.to_string()))?;
    if base.scheme() == candidate.scheme()
        && base.host_str() == candidate.host_str()
        && base.port_or_known_default() == candidate.port_or_known_default()
    {
        Ok(())
    } else {
        Err(ModelRequestError::new(
            "model_response_invalid",
            "Model task URL changed origin.",
        ))
    }
}
