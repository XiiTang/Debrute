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
    if body.contains_key("model") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "image-01 arguments.model conflicts with the configured request model ID.",
        ));
    }
    if let Some(references) = body.remove("subject_reference") {
        let references = if is_string_array(&references) {
            resolve_subject_references(context, &references)?
        } else {
            references
        };
        body.insert("subject_reference".to_owned(), references);
    }
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                "image-01 requires materialized response_format.",
            )
        })?
        .to_owned();
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let url = join_url(&context.model.base_url, "v1/image_generation")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Json(Value::Object(body.clone())),
    )?;

    if let Some(code) = response
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
    {
        let message = response
            .pointer("/base_resp/status_msg")
            .and_then(Value::as_str)
            .unwrap_or("MiniMax returned no status message.");
        return Err(ModelRequestError::new(
            "model_request_task_failed",
            format!("MiniMax image request rejected (HTTP 200, remote code {code}): {message}"),
        ));
    }

    let payloads = response_payloads(context, &response, &response_format)?;

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

fn resolve_subject_references(
    context: &mut ExecutionContext<'_>,
    references: &Value,
) -> Result<Value, ModelRequestError> {
    let references = references
        .as_array()
        .expect("MiniMax subject references were inspected as a string array");
    Ok(Value::Array(
        references
            .iter()
            .map(|reference| {
                let source = reference
                    .as_str()
                    .expect("MiniMax subject reference was inspected as a string");
                let reference = context.resolve_media_reference(source)?;
                Ok(json!({
                    "type": "character",
                    "image_file": reference.into_reference_string(context)?,
                }))
            })
            .collect::<Result<Vec<_>, ModelRequestError>>()?,
    ))
}

fn response_payloads(
    context: &mut ExecutionContext<'_>,
    response: &Value,
    response_format: &str,
) -> Result<Vec<crate::model_request::types::ModelArtifactPayload>, ModelRequestError> {
    match response_format {
        "base64" => {
            let images = response
                .pointer("/data/image_base64")
                .and_then(Value::as_array)
                .filter(|images| !images.is_empty())
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "model_response_invalid",
                        "image-01 Base64 response omitted non-empty data.image_base64.",
                    )
                })?;
            images
                .iter()
                .map(|image| {
                    let encoded = image
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            ModelRequestError::new(
                                "model_response_invalid",
                                "image-01 Base64 response contained a malformed image.",
                            )
                        })?;
                    let bytes = decode_base64(encoded, "MiniMax image")?;
                    let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
                        ModelRequestError::new(
                            "model_artifact_type_unsupported",
                            "image-01 returned unsupported image bytes.",
                        )
                    })?;
                    image_payload(bytes, mime, Value::Null)
                })
                .collect::<Result<Vec<_>, _>>()
        }
        "url" => {
            let urls = response
                .pointer("/data/image_urls")
                .and_then(Value::as_array)
                .filter(|images| !images.is_empty())
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "model_response_invalid",
                        "image-01 URL response omitted non-empty data.image_urls.",
                    )
                })?
                .iter()
                .map(|url| {
                    url.as_str()
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            ModelRequestError::new(
                                "model_response_invalid",
                                "image-01 URL response contained a malformed URL.",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            download_images(context, &urls)
        }
        _ => Err(ModelRequestError::new(
            "model_response_invalid",
            format!("image-01 returned for unsupported response_format {response_format}."),
        )),
    }
}
