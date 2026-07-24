use serde_json::{Value, json};

use super::{ImageResult, download_images, image_payload};
use crate::generation::{
    common::{ExecutionContext, authorization, decode_base64, join_url, mime_from_path_or_bytes},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = context.arguments.clone();
    if let Some(images) = body.remove("image") {
        body.insert(
            "image".to_owned(),
            resolve_image_references(context, &images)?,
        );
    }
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "doubao-seedream-5-0-lite-260128 requires materialized response_format.",
            )
        })?
        .to_owned();
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );

    let url = join_url(&context.model.base_url, "images/generations")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let items = response
        .get("data")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "doubao-seedream-5-0-lite-260128 response omitted a non-empty data array.",
            )
        })?;

    let payloads = match response_format.as_str() {
        "url" => {
            let urls = items
                .iter()
                .map(|item| {
                    item.get("url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            GenerationError::new(
                                "model_response_invalid",
                                "doubao-seedream-5-0-lite-260128 URL response item omitted url.",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            download_images(context, &urls)?
        }
        "b64_json" => items
            .iter()
            .map(|item| {
                let encoded = item
                    .get("b64_json")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        GenerationError::new(
                            "model_response_invalid",
                            "doubao-seedream-5-0-lite-260128 Base64 response item omitted b64_json.",
                        )
                    })?;
                let bytes = decode_base64(encoded, "Seedream image")?;
                let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
                    GenerationError::new(
                        "generated_artifact_type_unsupported",
                        "doubao-seedream-5-0-lite-260128 returned unsupported image bytes.",
                    )
                })?;
                image_payload(bytes, mime, Value::Null)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(GenerationError::new(
                "model_response_invalid",
                format!(
                    "doubao-seedream-5-0-lite-260128 returned for unsupported response_format {response_format}."
                ),
            ));
        }
    };

    Ok(ImageResult {
        payloads,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}

fn resolve_image_references(
    context: &mut ExecutionContext<'_>,
    images: &Value,
) -> Result<Value, GenerationError> {
    let images = images.as_array().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "doubao-seedream-5-0-lite-260128 image must be an array of strings.",
        )
    })?;
    Ok(Value::Array(
        images
            .iter()
            .map(|image| {
                let source = image.as_str().ok_or_else(|| {
                    GenerationError::new(
                        "generation_argument_invalid",
                        "doubao-seedream-5-0-lite-260128 image values must be strings.",
                    )
                })?;
                let reference = context.resolve_media_reference(source)?;
                reference.into_reference_string(context).map(Value::String)
            })
            .collect::<Result<Vec<_>, _>>()?,
    ))
}
