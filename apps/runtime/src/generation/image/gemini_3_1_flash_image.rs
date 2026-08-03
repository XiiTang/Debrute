use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::project::{CanvasMediaKind, project_media_kind_from_content_type};

use super::{ImageResult, image_payload};
use crate::generation::{
    common::{ExecutionContext, decode_base64, is_string_array, join_url, mime_from_path_or_bytes},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut arguments = context.arguments.clone();
    let prompt = arguments.remove("prompt");
    let images = resolve_images(context, &mut arguments)?;
    let delivery = arguments
        .remove("delivery")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "gemini-3.1-flash-image requires materialized delivery.",
            )
        })?;

    let mut input = Vec::new();
    if let Some(prompt) = prompt {
        input.push(json!({"type": "text", "text": prompt}));
    }
    input.extend(images);

    let mut response_format = Map::from_iter([
        ("type".to_owned(), Value::String("image".to_owned())),
        ("delivery".to_owned(), Value::String(delivery.clone())),
    ]);
    if let Some(aspect_ratio) = arguments.remove("aspect_ratio") {
        response_format.insert("aspect_ratio".to_owned(), aspect_ratio);
    }
    if let Some(image_size) = arguments.remove("image_size") {
        response_format.insert("image_size".to_owned(), image_size);
    }
    let mut body = arguments;
    for field in ["model", "response_format", "store"] {
        if body.contains_key(field) {
            return Err(GenerationError::new(
                "generation_argument_collision",
                format!(
                    "gemini-3.1-flash-image arguments.{field} conflicts with Debrute request framing."
                ),
            ));
        }
    }
    if !input.is_empty() && body.contains_key("input") {
        return Err(GenerationError::new(
            "generation_argument_collision",
            "gemini-3.1-flash-image cannot combine flattened prompt or image with arguments.input.",
        ));
    }
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    if !input.is_empty() {
        body.insert("input".to_owned(), Value::Array(input));
    }
    body.insert("response_format".to_owned(), Value::Object(response_format));
    body.insert("store".to_owned(), Value::Bool(false));
    let body = Value::Object(body);
    let url = join_url(&context.model.base_url, "interactions")?;
    let headers = BTreeMap::from([
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-goog-api-key".to_owned(), context.model.api_key.clone()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(body.clone()),
    )?;
    let payloads = parse_response(context, &response, &delivery)?;
    Ok(ImageResult {
        payloads,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {
                "content-type": "application/json",
                "x-goog-api-key": "[REDACTED]",
            },
            "body": body,
        }),
    })
}

fn resolve_images(
    context: &mut ExecutionContext<'_>,
    arguments: &mut Map<String, Value>,
) -> Result<Vec<Value>, GenerationError> {
    let Some(value) = arguments.remove("image") else {
        return Ok(Vec::new());
    };
    if !is_string_array(&value) {
        arguments.insert("image".to_owned(), value);
        return Ok(Vec::new());
    }
    value
        .as_array()
        .expect("Gemini image references were inspected as a string array")
        .iter()
        .map(|value| {
            resolve_image(
                context,
                value
                    .as_str()
                    .expect("Gemini image reference was inspected as a string"),
            )
        })
        .collect()
}

fn resolve_image(
    context: &mut ExecutionContext<'_>,
    source: &str,
) -> Result<Value, GenerationError> {
    let resolved = context.resolve_media_reference(source)?;
    if resolved.is_public_url() {
        let uri = resolved.into_reference_string(context)?;
        return Ok(json!({"type": "image", "uri": uri}));
    }
    let (mime, encoded) = resolved.into_inline_base64(context)?;
    if project_media_kind_from_content_type(&mime) != CanvasMediaKind::Image {
        return Err(GenerationError::new(
            "generation_input_invalid",
            "gemini-3.1-flash-image input is not image media.",
        ));
    }
    Ok(json!({
        "type": "image",
        "mime_type": mime,
        "data": encoded,
    }))
}

fn parse_response(
    context: &mut ExecutionContext<'_>,
    response: &Value,
    delivery: &str,
) -> Result<Vec<crate::generation::types::GeneratedPayload>, GenerationError> {
    let steps = response
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "gemini-3.1-flash-image response omitted steps.",
            )
        })?;
    let mut payloads = Vec::new();
    for step in steps
        .iter()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
    {
        let output_items = step
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                GenerationError::new(
                    "model_response_invalid",
                    "gemini-3.1-flash-image model_output step omitted content.",
                )
            })?;
        for item in output_items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("image"))
        {
            payloads.push(match delivery {
                "uri" => payload_from_uri(context, item)?,
                "inline" => payload_from_inline(item)?,
                _ => {
                    return Err(GenerationError::new(
                        "generation_argument_invalid",
                        "gemini-3.1-flash-image delivery must be inline or uri.",
                    ));
                }
            });
        }
    }
    if payloads.is_empty() {
        return Err(GenerationError::new(
            "model_response_invalid",
            "gemini-3.1-flash-image response contained no images.",
        ));
    }
    Ok(payloads)
}

fn payload_from_uri(
    context: &mut ExecutionContext<'_>,
    item: &Value,
) -> Result<crate::generation::types::GeneratedPayload, GenerationError> {
    let uri = item
        .get("uri")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "gemini-3.1-flash-image URI image omitted uri.",
            )
        })?;
    let response = context.download_generated_media(uri)?;
    let mime = mime_from_path_or_bytes("", &response.body).ok_or_else(|| {
        GenerationError::new(
            "generated_artifact_type_unsupported",
            "gemini-3.1-flash-image returned unsupported image bytes.",
        )
    })?;
    image_payload(response.body, mime, json!({"uri": uri}))
}

fn payload_from_inline(
    item: &Value,
) -> Result<crate::generation::types::GeneratedPayload, GenerationError> {
    let data = item
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "gemini-3.1-flash-image inline image omitted data.",
            )
        })?;
    let bytes = decode_base64(data, "gemini-3.1-flash-image image")?;
    let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
        GenerationError::new(
            "generated_artifact_type_unsupported",
            "gemini-3.1-flash-image returned unsupported image bytes.",
        )
    })?;
    image_payload(bytes, mime, Value::Null)
}
