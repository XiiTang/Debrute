use serde_json::{Value, json};

use crate::project::GeneratedArtifactRole;

use super::{
    common::{
        ExecutionContext, execute_result, extension_for_mime, mime_from_path_or_bytes,
        mime_from_response,
    },
    types::{GeneratedPayload, GenerationError, ModelExecution},
};

mod doubao_seedream_5_lite;
mod fal_flux_dev;
mod fal_flux_dev_image_to_image;
mod gemini_3_1_flash_image;
mod gemini_3_pro_image;
mod gpt_image_1;
mod gpt_image_2;
mod minimax_image_01;
mod vydra_grok_imagine;
mod wan_2_7_image;

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let model = context.model.model_id.as_str();
    let result = match model {
        "gpt-image-1" => gpt_image_1::execute(&mut context),
        "gpt-image-2" => gpt_image_2::execute(&mut context),
        "doubao-seedream-5-0-lite-260128" => doubao_seedream_5_lite::execute(&mut context),
        "wan2.7-image" => wan_2_7_image::execute(&mut context),
        "gemini-3.1-flash-image" => gemini_3_1_flash_image::execute(&mut context),
        "gemini-3-pro-image" => gemini_3_pro_image::execute(&mut context),
        "fal-ai/flux/dev" => fal_flux_dev::execute(&mut context),
        "fal-ai/flux/dev/image-to-image" => fal_flux_dev_image_to_image::execute(&mut context),
        "image-01" => minimax_image_01::execute(&mut context),
        "grok-imagine" => vydra_grok_imagine::execute(&mut context),
        _ => Err(GenerationError::new(
            "image_model_unavailable",
            format!("Image model adapter is unavailable: {model}"),
        )),
    }?;
    execute_result(result.payloads, result.safe_request, context)
}

struct ImageResult {
    payloads: Vec<GeneratedPayload>,
    safe_request: Value,
}

fn download_images(
    context: &mut ExecutionContext<'_>,
    urls: &[String],
) -> Result<Vec<GeneratedPayload>, GenerationError> {
    urls.iter()
        .map(|url| download_image(context, url))
        .collect()
}

fn download_image(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<GeneratedPayload, GenerationError> {
    let response = context.download_generated_media(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "Generated image response has no supported MIME type.",
            )
        })?;
    image_payload(response.body, &mime, json!({"url": url}))
}

fn image_payload(
    bytes: Vec<u8>,
    mime: &str,
    output: Value,
) -> Result<GeneratedPayload, GenerationError> {
    if !mime.starts_with("image/") {
        return Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated image has non-image MIME type: {mime}"),
        ));
    }
    extension_for_mime(mime)?;
    Ok(GeneratedPayload {
        bytes,
        mime_type: mime.to_owned(),
        role: GeneratedArtifactRole::PrimaryImage,
        model_output: output,
    })
}

fn form_value(value: &Value) -> String {
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
