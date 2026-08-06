use serde_json::{Value, json};

use super::{ImageResult, download_images};
use crate::model_request::{
    common::{ExecutionContext, authorization, is_string_array, join_url},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ImageResult, ModelRequestError> {
    let mut parameters = context.arguments.clone();
    let prompt = parameters.remove("prompt");
    let images = match parameters.remove("image") {
        Some(value) if is_string_array(&value) => value
            .as_array()
            .expect("Qwen image references were inspected as a string array")
            .iter()
            .map(|value| {
                let source = value
                    .as_str()
                    .expect("Qwen image reference was inspected as a string");
                let reference = context.resolve_media_reference(source)?;
                reference
                    .into_reference_string(context)
                    .map(|image| json!({"image": image}))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(value) => {
            parameters.insert("image".to_owned(), value);
            Vec::new()
        }
        None => Vec::new(),
    };
    let mut message_parts = images;
    if let Some(prompt) = prompt {
        message_parts.push(json!({"text": prompt}));
    }
    let body = json!({
        "model": context.model.request_model_id,
        "input": {"messages": [{"role": "user", "content": message_parts}]},
        "parameters": parameters,
    });
    let url = join_url(
        &context.model.base_url,
        "services/aigc/multimodal-generation/generation",
    )?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(body.clone()),
    )?;

    let choices = response
        .pointer("/output/choices")
        .and_then(Value::as_array)
        .filter(|choices| !choices.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "qwen-image-2.0-2026-03-03 response omitted non-empty output.choices.",
            )
        })?;
    let mut urls = Vec::new();
    for choice in choices {
        let items = choice
            .pointer("/message/content")
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
            .ok_or_else(|| {
                ModelRequestError::new(
                    "model_response_invalid",
                    "qwen-image-2.0-2026-03-03 response choice omitted non-empty message.content.",
                )
            })?;
        for item in items {
            urls.push(
                item.get("image")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        ModelRequestError::new(
                            "model_response_invalid",
                            "qwen-image-2.0-2026-03-03 response content item omitted image.",
                        )
                    })?,
            );
        }
    }

    Ok(ImageResult {
        payloads: download_images(context, &urls)?,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}
