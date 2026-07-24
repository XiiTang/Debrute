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
mod doubao_seedream_5_pro;
mod fal_flux_dev;
mod fal_flux_dev_image_to_image;
mod gemini_3_1_flash_image;
mod gemini_3_pro_image;
mod gpt_image_1;
mod gpt_image_2;
mod minimax_image_01;
mod qwen_image_2_0_2026_03_03;
mod qwen_image_2_0_pro_2026_06_22;
mod vydra_grok_imagine;
mod wan_2_7_image;

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let model = context.model.model_id.as_str();
    let adapter = adapter_for(model).ok_or_else(|| {
        GenerationError::new(
            "image_model_unavailable",
            format!("Image model adapter is unavailable: {model}"),
        )
    })?;
    let result = adapter(&mut context)?;
    execute_result(result.payloads, result.safe_request, context)
}

type ImageAdapter = for<'a> fn(&mut ExecutionContext<'a>) -> Result<ImageResult, GenerationError>;

fn adapter_for(model: &str) -> Option<ImageAdapter> {
    match model {
        "gpt-image-1" => Some(gpt_image_1::execute),
        "gpt-image-2" => Some(gpt_image_2::execute),
        "doubao-seedream-5-0-lite-260128" => Some(doubao_seedream_5_lite::execute),
        "doubao-seedream-5-0-pro-260628" => Some(doubao_seedream_5_pro::execute),
        "qwen-image-2.0-pro-2026-06-22" => Some(qwen_image_2_0_pro_2026_06_22::execute),
        "qwen-image-2.0-2026-03-03" => Some(qwen_image_2_0_2026_03_03::execute),
        "wan2.7-image" => Some(wan_2_7_image::execute),
        "gemini-3.1-flash-image" => Some(gemini_3_1_flash_image::execute),
        "gemini-3-pro-image" => Some(gemini_3_pro_image::execute),
        "fal-ai/flux/dev" => Some(fal_flux_dev::execute),
        "fal-ai/flux/dev/image-to-image" => Some(fal_flux_dev_image_to_image::execute),
        "image-01" => Some(minimax_image_01::execute),
        "grok-imagine" => Some(vydra_grok_imagine::execute),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn has_adapter(model: &str) -> bool {
    adapter_for(model).is_some()
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
