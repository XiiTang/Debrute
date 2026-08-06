use serde_json::{Value, json};

use super::{ImageResult, download_images, image_payload};
use crate::model_request::{
    common::{
        ExecutionContext, authorization, decode_base64, is_string_array, join_url,
        mime_from_path_or_bytes,
    },
    types::{HttpBody, HttpMethod, ModelRequestError},
};

const MODEL_ID: &str = "doubao-seedream-5-0-pro-260628";

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ImageResult, ModelRequestError> {
    let mut body = context.arguments.clone();
    reject_model_collision(&body)?;
    if let Some(images) = body.remove("image") {
        let images = if is_string_array(&images) {
            resolve_image_references(context, &images)?
        } else {
            images
        };
        body.insert("image".to_owned(), images);
    }
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                format!("{MODEL_ID} requires materialized response_format."),
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
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} response omitted a non-empty data array."),
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
                                format!("{MODEL_ID} URL response item omitted url."),
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
                            format!("{MODEL_ID} Base64 response item omitted b64_json."),
                        )
                    })?;
                let bytes = decode_base64(encoded, "Seedream 5.0 Pro image")?;
                let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
                    ModelRequestError::new(
                        "model_artifact_type_unsupported",
                        format!("{MODEL_ID} returned unsupported image bytes."),
                    )
                })?;
                image_payload(bytes, mime, Value::Null)
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} returned for unsupported response_format {response_format}."),
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

fn reject_model_collision(body: &serde_json::Map<String, Value>) -> Result<(), ModelRequestError> {
    if body.contains_key("model") {
        Err(ModelRequestError::new(
            "model_request_argument_collision",
            format!("{MODEL_ID} arguments.model conflicts with the configured request model ID."),
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
