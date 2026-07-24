use serde_json::{Value, json};

use super::{ImageResult, download_image};
use crate::generation::{
    common::{ExecutionContext, authorization, join_url},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = context.arguments.clone();
    body.insert(
        "model".to_owned(),
        Value::String("text-to-image".to_owned()),
    );
    let url = join_url(
        &context.model.base_url,
        &format!("models/{}", context.model.request_model_id),
    )?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let status = response
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "grok-imagine response omitted status.",
            )
        })?;
    if status != "completed" {
        return Err(GenerationError::new(
            "generation_task_failed",
            format!("grok-imagine synchronous request returned status {status}."),
        ));
    }
    let image_url = response
        .get("imageUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "grok-imagine completed response omitted imageUrl.",
            )
        })?;
    Ok(ImageResult {
        payloads: vec![download_image(context, image_url)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}
