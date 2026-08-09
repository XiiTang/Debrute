use serde_json::{Value, json};

use super::{
    common::{ExecutionContext, extension_for_mime, mime_from_path_or_bytes, mime_from_response},
    types::{ModelArtifactPayload, ModelRequestError},
};

pub(crate) fn download_images(
    context: &mut ExecutionContext<'_>,
    urls: &[String],
) -> Result<Vec<ModelArtifactPayload>, ModelRequestError> {
    urls.iter()
        .map(|url| download_image(context, url))
        .collect()
}

pub(crate) fn download_image(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    let response = context.download_model_output_media(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "Model output image response has no supported MIME type.",
            )
        })?;
    image_payload(response.body, &mime, json!({"url": url}))
}

pub(crate) fn image_payload(
    bytes: Vec<u8>,
    mime: &str,
    output: Value,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    if !mime.starts_with("image/") {
        return Err(ModelRequestError::new(
            "model_artifact_type_unsupported",
            format!("Model output image has non-image MIME type: {mime}"),
        ));
    }
    extension_for_mime(mime)?;
    Ok(ModelArtifactPayload {
        bytes,
        mime_type: mime.to_owned(),
        model_output: output,
    })
}

pub(crate) fn form_value(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_mime_is_required_for_image_payloads() {
        assert!(image_payload(vec![1], "video/mp4", Value::Null).is_err());
        assert!(image_payload(vec![1], "image/png", Value::Null).is_ok());
    }
}
