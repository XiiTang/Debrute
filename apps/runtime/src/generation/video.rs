use serde_json::{Value, json};

use crate::project::GeneratedArtifactRole;

use super::{
    common::{
        ExecutionContext, execute_result, extension_for_mime, mime_from_path_or_bytes,
        mime_from_response,
    },
    types::{GeneratedPayload, GenerationError, ModelExecution},
};

mod seedance_2;
mod seedance_2_fast;

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let model = context.model.model_id.as_str();
    let result = match model {
        "doubao-seedance-2-0-260128" => seedance_2::execute(&mut context),
        "doubao-seedance-2-0-fast-260128" => seedance_2_fast::execute(&mut context),
        _ => Err(GenerationError::new(
            "video_model_unavailable",
            format!("Video model adapter is unavailable: {model}"),
        )),
    }?;
    execute_result(result.payloads, result.safe_request, context)
}

struct VideoResult {
    payloads: Vec<GeneratedPayload>,
    safe_request: Value,
}

fn download_video_artifact(
    context: &mut ExecutionContext<'_>,
    url: &str,
    role: GeneratedArtifactRole,
) -> Result<GeneratedPayload, GenerationError> {
    let response = context.download_generated_media(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "Generated video artifact omitted a supported MIME type.",
            )
        })?;
    let valid = match role {
        GeneratedArtifactRole::PrimaryVideo => mime == "video/mp4",
        GeneratedArtifactRole::LastFrame => mime.starts_with("image/"),
        _ => false,
    };
    if !valid {
        return Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated video artifact has unsupported MIME type: {mime}"),
        ));
    }
    extension_for_mime(&mime)?;
    Ok(GeneratedPayload {
        bytes: response.body,
        mime_type: mime,
        role,
        model_output: json!({"url": url}),
    })
}
