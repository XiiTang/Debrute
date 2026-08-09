use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::model_request::image::{download_images, image_payload};
use crate::model_request::types::ModelExecutionDraft;
use crate::model_request::{
    common::{ExecutionContext, decode_base64, is_string_array, join_url, mime_from_path_or_bytes},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let mut body = context.arguments.clone();
    reject_model_collision(&body)?;
    if let Some(images) = body.remove("image") {
        body.insert(
            "image".to_owned(),
            transform_image_argument(context, images)?,
        );
    }
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
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
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let items = response
        .get("data")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
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
                            ModelRequestError::new(
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
                        ModelRequestError::new(
                            "model_response_invalid",
                            "doubao-seedream-5-0-lite-260128 Base64 response item omitted b64_json.",
                        )
                    })?;
                let bytes = decode_base64(encoded, "Seedream image")?;
                let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
                    ModelRequestError::new(
                        "model_artifact_type_unsupported",
                        "doubao-seedream-5-0-lite-260128 returned unsupported image bytes.",
                    )
                })?;
                image_payload(bytes, mime, Value::Null)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ModelRequestError::new(
                "model_response_invalid",
                format!(
                    "doubao-seedream-5-0-lite-260128 returned for unsupported response_format {response_format}."
                ),
            ));
        }
    };

    Ok(ModelExecutionDraft {
        payloads,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}

fn transform_image_argument(
    context: &mut ExecutionContext<'_>,
    images: Value,
) -> Result<Value, ModelRequestError> {
    if is_string_array(&images) {
        resolve_image_references(context, &images)
    } else {
        Ok(images)
    }
}

fn reject_model_collision(body: &serde_json::Map<String, Value>) -> Result<(), ModelRequestError> {
    if body.contains_key("model") {
        Err(ModelRequestError::new(
            "model_request_argument_collision",
            "doubao-seedream-5-0-lite-260128 arguments.model conflicts with the configured request model ID.",
        ))
    } else {
        Ok(())
    }
}

fn resolve_image_references(
    context: &mut ExecutionContext<'_>,
    images: &Value,
) -> Result<Value, ModelRequestError> {
    let images = images
        .as_array()
        .expect("Seedream image references were inspected as a string array");
    Ok(Value::Array(
        images
            .iter()
            .map(|image| {
                let source = image
                    .as_str()
                    .expect("Seedream image reference was inspected as a string");
                let reference = context.resolve_media_reference(source)?;
                reference.into_reference_string(context).map(Value::String)
            })
            .collect::<Result<Vec<_>, _>>()?,
    ))
}
