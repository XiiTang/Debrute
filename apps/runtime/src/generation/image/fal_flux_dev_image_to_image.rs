use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{ImageResult, download_images};
use crate::generation::{
    common::{ExecutionContext, join_url},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = context.arguments.clone();
    if let Some(image) = body.remove("image_url") {
        let source = image.as_str().ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "fal-ai/flux/dev/image-to-image image_url must be a string.",
            )
        })?;
        let reference = context.resolve_media_reference(source)?;
        body.insert(
            "image_url".to_owned(),
            Value::String(reference.into_reference_string(context)?),
        );
    }
    let url = join_url(&context.model.base_url, &context.model.request_model_id)?;
    let headers = BTreeMap::from([
        (
            "authorization".to_owned(),
            format!("Key {}", context.model.api_key),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let images = response
        .get("images")
        .and_then(Value::as_array)
        .filter(|images| !images.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "fal-ai/flux/dev/image-to-image response omitted a non-empty images array.",
            )
        })?;
    let urls = images
        .iter()
        .map(|image| {
            image
                .get("url")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    GenerationError::new(
                        "model_response_invalid",
                        "fal-ai/flux/dev/image-to-image response image omitted url.",
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ImageResult {
        payloads: download_images(context, &urls)?,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]", "content-type": "application/json"},
            "body": body,
        }),
    })
}
