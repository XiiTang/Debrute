use serde_json::{Value, json};

use super::{ImageResult, download_images, image_payload};
use crate::generation::{
    common::{ExecutionContext, authorization, decode_base64, join_url, mime_from_path_or_bytes},
    types::{GenerationError, HttpBody, HttpMethod},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = context.arguments.clone();
    if let Some(references) = body.remove("subject_reference") {
        body.insert(
            "subject_reference".to_owned(),
            resolve_subject_references(context, &references)?,
        );
    }
    let response_format = body
        .get("response_format")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
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
        authorization(&context.model.api_key),
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
        return Err(GenerationError::new(
            "generation_task_failed",
            format!("MiniMax image request rejected (HTTP 200, remote code {code}): {message}"),
        ));
    }

    let payloads = response_payloads(context, &response, &response_format)?;

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

fn resolve_subject_references(
    context: &mut ExecutionContext<'_>,
    references: &Value,
) -> Result<Value, GenerationError> {
    let references = references.as_array().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "image-01 subject_reference must be an array of strings.",
        )
    })?;
    Ok(Value::Array(
        references
            .iter()
            .map(|reference| {
                let source = reference.as_str().ok_or_else(|| {
                    GenerationError::new(
                        "generation_argument_invalid",
                        "image-01 subject_reference values must be strings.",
                    )
                })?;
                let reference = context.resolve_media_reference(source)?;
                Ok(json!({
                    "type": "character",
                    "image_file": reference.into_reference_string(context)?,
                }))
            })
            .collect::<Result<Vec<_>, GenerationError>>()?,
    ))
}

fn response_payloads(
    context: &mut ExecutionContext<'_>,
    response: &Value,
    response_format: &str,
) -> Result<Vec<crate::generation::types::GeneratedPayload>, GenerationError> {
    match response_format {
        "base64" => {
            let images = response
                .pointer("/data/image_base64")
                .and_then(Value::as_array)
                .filter(|images| !images.is_empty())
                .ok_or_else(|| {
                    GenerationError::new(
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
                            GenerationError::new(
                                "model_response_invalid",
                                "image-01 Base64 response contained a malformed image.",
                            )
                        })?;
                    let bytes = decode_base64(encoded, "MiniMax image")?;
                    let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
                        GenerationError::new(
                            "generated_artifact_type_unsupported",
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
                    GenerationError::new(
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
                            GenerationError::new(
                                "model_response_invalid",
                                "image-01 URL response contained a malformed URL.",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            download_images(context, &urls)
        }
        _ => Err(GenerationError::new(
            "model_response_invalid",
            format!("image-01 returned for unsupported response_format {response_format}."),
        )),
    }
}
