use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{AudioResult, audio_payload};
use crate::{
    model_request::{
        common::{ExecutionContext, decode_base64, is_string_array, join_url},
        types::{HttpBody, HttpMethod, ModelRequestError},
    },
    project::{CanvasMediaKind, project_media_kind_from_content_type},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, ModelRequestError> {
    let mut arguments = context.arguments.clone();
    let prompt = arguments.remove("prompt");
    let format = arguments.remove("format");
    let mut input = Vec::new();
    if let Some(prompt) = prompt {
        input.push(json!({"type": "text", "text": prompt}));
    }
    if let Some(images) = arguments.remove("image") {
        if is_string_array(&images) {
            for image in images
                .as_array()
                .expect("Lyria image references were inspected as a string array")
            {
                let source = image
                    .as_str()
                    .expect("Lyria image reference was inspected as a string");
                input.push(resolve_image(context, source)?);
            }
        } else {
            arguments.insert("image".to_owned(), images);
        }
    }
    let mut body = arguments;
    for field in ["model", "store"] {
        if body.contains_key(field) {
            return Err(ModelRequestError::new(
                "model_request_argument_collision",
                format!(
                    "google-lyria-3-pro-preview arguments.{field} conflicts with Debrute request framing."
                ),
            ));
        }
    }
    if !input.is_empty() && body.contains_key("input") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "google-lyria-3-pro-preview cannot combine flattened prompt or image with arguments.input.",
        ));
    }
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    if !input.is_empty() {
        body.insert("input".to_owned(), Value::Array(input));
    }
    body.insert("store".to_owned(), Value::Bool(false));
    match format {
        Some(Value::String(format)) if format == "wav" => {
            if body.contains_key("response_format") {
                return Err(ModelRequestError::new(
                    "model_request_argument_collision",
                    "google-lyria-3-pro-preview cannot map both format=wav and response_format.",
                ));
            }
            body.insert("response_format".to_owned(), json!({"type": "audio"}));
        }
        None => {}
        Some(Value::String(format)) if format == "mp3" => {}
        Some(format) => {
            body.insert("format".to_owned(), format);
        }
    }
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
) -> Result<Value, ModelRequestError> {
    let resolved = context.resolve_media_reference(source)?;
    if resolved.is_public_url() {
        let uri = resolved.into_reference_string(context)?;
        return Ok(json!({"type": "image", "uri": uri}));
    }
    let (mime, encoded) = resolved.into_inline_base64(context)?;
    if project_media_kind_from_content_type(&mime) != CanvasMediaKind::Image {
        return Err(ModelRequestError::new(
            "model_request_input_invalid",
            "google-lyria-3-pro-preview input is not image media.",
        ));
    }
    Ok(json!({"type": "image", "mime_type": mime, "data": encoded}))
}

fn parse_response(response: &Value) -> Result<(Vec<u8>, String, Vec<String>), ModelRequestError> {
    let steps = response
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "google-lyria-3-pro-preview response omitted steps.",
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
                ModelRequestError::new(
                    "model_response_invalid",
                    "google-lyria-3-pro-preview model_output omitted content.",
                )
            })?;
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
                        ModelRequestError::new(
                            "model_response_invalid",
                            "google-lyria-3-pro-preview text block omitted text.",
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
                            ModelRequestError::new(
                                "model_response_invalid",
                                "google-lyria-3-pro-preview audio omitted mime_type.",
                            )
                        })?;
                    if mime.as_deref().is_some_and(|mime| mime != item_mime) {
                        return Err(ModelRequestError::new(
                            "model_response_invalid",
                            "google-lyria-3-pro-preview returned mixed audio MIME types.",
                        ));
                    }
                    mime.get_or_insert_with(|| item_mime.to_owned());
                    let data = item
                        .get("data")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            ModelRequestError::new(
                                "model_response_invalid",
                                "google-lyria-3-pro-preview audio omitted data.",
                            )
                        })?;
                    bytes.extend(decode_base64(data, "Lyria Pro audio")?);
                }
                _ => {}
            }
        }
    }
    let mime = mime.ok_or_else(|| {
        ModelRequestError::new(
            "model_response_invalid",
            "google-lyria-3-pro-preview response contained no audio.",
        )
    })?;
    Ok((bytes, mime, texts))
}
