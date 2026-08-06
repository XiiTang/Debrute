use serde_json::{Value, json};

use super::{
    common::{
        ExecutionContext, execute_result, extension_for_mime, mime_from_path_or_bytes,
        mime_from_response,
    },
    types::{ModelArtifactPayload, ModelExecution, ModelRequestError},
};

mod minimax_h3;
mod seedance_2;
mod seedance_2_fast;
mod seedance_2_mini;

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, ModelRequestError> {
    let model = context.model.model_id.as_str();
    let adapter = adapter_for(model).ok_or_else(|| {
        ModelRequestError::new(
            "video_model_unavailable",
            format!("Video model adapter is unavailable: {model}"),
        )
    })?;
    let result = adapter(&mut context)?;
    execute_result(result.payloads, result.safe_request, context)
}

type VideoAdapter = for<'a> fn(&mut ExecutionContext<'a>) -> Result<VideoResult, ModelRequestError>;

fn adapter_for(model: &str) -> Option<VideoAdapter> {
    match model {
        "minimax-h3" => Some(minimax_h3::execute),
        "doubao-seedance-2-0-260128" => Some(seedance_2::execute),
        "doubao-seedance-2-0-fast-260128" => Some(seedance_2_fast::execute),
        "doubao-seedance-2-0-mini-260615" => Some(seedance_2_mini::execute),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn has_adapter(model: &str) -> bool {
    adapter_for(model).is_some()
}

struct VideoResult {
    payloads: Vec<ModelArtifactPayload>,
    safe_request: Value,
}

fn download_video(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    download_media(context, url, |mime| mime == "video/mp4")
}

fn download_image(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    download_media(context, url, |mime| mime.starts_with("image/"))
}

fn download_media(
    context: &mut ExecutionContext<'_>,
    url: &str,
    accepts: impl FnOnce(&str) -> bool,
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
    if !accepts(&mime) {
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
