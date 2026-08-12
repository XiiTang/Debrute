use serde_json::json;

use super::{
    common::{ExecutionContext, extension_for_mime, mime_from_path_or_bytes, mime_from_response},
    types::{ModelArtifactPayload, ModelRequestError},
};

pub(crate) fn download_video(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    let response = context.download_model_output_media(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "Model video output omitted a supported MIME type.",
            )
        })?;
    if mime != "video/mp4" {
        return Err(ModelRequestError::new(
            "model_artifact_type_unsupported",
            format!("Model video output has unsupported MIME type: {mime}"),
        ));
    }
    extension_for_mime(&mime)?;
    Ok(ModelArtifactPayload {
        bytes: response.body,
        mime_type: mime,
        model_output: json!({"url": url}),
    })
}
