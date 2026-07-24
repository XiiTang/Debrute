use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{AudioResult, audio_payload};
use crate::{
    generation::{
        common::{ExecutionContext, decode_base64, join_url},
        types::{GenerationError, HttpBody, HttpMethod},
    },
    project::{CanvasMediaKind, project_media_kind_from_content_type},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<AudioResult, GenerationError> {
    let mut arguments = context.arguments.clone();
    let prompt = arguments.remove("prompt").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "google-lyria-3-clip-preview requires prompt.",
        )
    })?;
    let mut input = vec![json!({"type": "text", "text": prompt})];
    if let Some(images) = arguments.remove("image") {
        let images = images.as_array().ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "google-lyria-3-clip-preview image must be an array of strings.",
            )
        })?;
        for image in images {
            let source = image.as_str().ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    "google-lyria-3-clip-preview image values must be strings.",
                )
            })?;
            input.push(resolve_image(context, source)?);
        }
    }
    let mut body = arguments;
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    body.insert("input".to_owned(), Value::Array(input));
    body.insert("store".to_owned(), Value::Bool(false));
    let body = Value::Object(body);
    let url = join_url(&context.model.base_url, "interactions")?;
    let headers = BTreeMap::from([
        ("x-goog-api-key".to_owned(), context.model.api_key.clone()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(body.clone()),
    )?;
    let (bytes, mime, texts) = parse_response(&response)?;
    let mut payload = audio_payload(bytes, &mime, context)?;
    payload.model_output = json!({"text": texts});
    Ok(AudioResult {
        payloads: vec![payload],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"x-goog-api-key": "[REDACTED]", "content-type": "application/json"},
            "body": body,
        }),
    })
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
            "google-lyria-3-clip-preview input is not image media.",
        ));
    }
    Ok(json!({"type": "image", "mime_type": mime, "data": encoded}))
}

fn parse_response(response: &Value) -> Result<(Vec<u8>, String, Vec<String>), GenerationError> {
    let steps = response
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "google-lyria-3-clip-preview response omitted steps.",
            )
        })?;
    let mut bytes = Vec::new();
    let mut mime = None::<String>;
    let mut texts = Vec::new();
    for step in steps
        .iter()
        .filter(|step| step.get("type").and_then(Value::as_str) == Some("model_output"))
    {
        let content = step
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                GenerationError::new(
                    "model_response_invalid",
                    "google-lyria-3-clip-preview model_output omitted content.",
                )
            })?;
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
                        GenerationError::new(
                            "model_response_invalid",
                            "google-lyria-3-clip-preview text block omitted text.",
                        )
                    })?;
                    texts.push(text.to_owned());
                }
                Some("audio") => {
                    let item_mime = item
                        .get("mime_type")
                        .and_then(Value::as_str)
                        .filter(|value| value.starts_with("audio/"))
                        .ok_or_else(|| {
                            GenerationError::new(
                                "model_response_invalid",
                                "google-lyria-3-clip-preview audio omitted mime_type.",
                            )
                        })?;
                    if mime.as_deref().is_some_and(|mime| mime != item_mime) {
                        return Err(GenerationError::new(
                            "model_response_invalid",
                            "google-lyria-3-clip-preview returned mixed audio MIME types.",
                        ));
                    }
                    mime.get_or_insert_with(|| item_mime.to_owned());
                    let data = item
                        .get("data")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            GenerationError::new(
                                "model_response_invalid",
                                "google-lyria-3-clip-preview audio omitted data.",
                            )
                        })?;
                    bytes.extend(decode_base64(data, "Lyria Clip audio")?);
                }
                _ => {}
            }
        }
    }
    let mime = mime.ok_or_else(|| {
        GenerationError::new(
            "model_response_invalid",
            "google-lyria-3-clip-preview response contained no audio.",
        )
    })?;
    Ok((bytes, mime, texts))
}
