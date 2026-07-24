use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{ImageResult, download_images};
use crate::generation::{
    common::{ExecutionContext, join_url},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let body = context.arguments.clone();
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
                "fal-ai/flux/dev response omitted a non-empty images array.",
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
                        "fal-ai/flux/dev response image omitted url.",
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
