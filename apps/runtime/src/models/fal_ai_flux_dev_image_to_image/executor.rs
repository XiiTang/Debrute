use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::model_request::image::{download_image, image_payload};
use crate::model_request::types::ModelExecutionDraft;
use crate::model_request::{
    common::{ExecutionContext, decode_base64, join_url},
    types::{HttpBody, HttpMethod, ModelArtifactPayload, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let mut body = context.arguments.clone();
    if let Some(image) = body.remove("image_url") {
        if let Some(source) = image.as_str() {
            let reference = context.resolve_media_reference(source)?;
            body.insert(
                "image_url".to_owned(),
                Value::String(reference.into_reference_string(context)?),
            );
        } else {
            body.insert("image_url".to_owned(), image);
        }
    }
    let url = join_url(&context.model.base_url, &context.model.request_model_id)?;
    let headers = BTreeMap::from([(
        "authorization".to_owned(),
        format!("Key {}", context.model.api_key),
    )]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers,
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let images = response
        .get("images")
        .and_then(Value::as_array)
        .filter(|images| !images.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "fal-ai/flux/dev/image-to-image response omitted a non-empty images array.",
            )
        })?;
    let urls = images
        .iter()
        .map(|image| {
            image
                .get("url")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    ModelRequestError::new(
                        "model_response_invalid",
                        "fal-ai/flux/dev/image-to-image response image omitted url.",
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ModelExecutionDraft {
        payloads: urls
            .iter()
            .map(|url| image_from_reference(context, url))
            .collect::<Result<_, _>>()?,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {"authorization": "[REDACTED]"},
            "body": body,
        }),
    })
}

fn image_from_reference(
    context: &mut ExecutionContext<'_>,
    reference: &str,
) -> Result<ModelArtifactPayload, ModelRequestError> {
    let Some((mime, encoded)) = inline_file(reference)? else {
        return download_image(context, reference);
    };
    let bytes = decode_base64(encoded, "fal-ai/flux/dev/image-to-image inline image")?;
    image_payload(bytes, mime, json!({"delivery": "inline"}))
}

fn inline_file(reference: &str) -> Result<Option<(&str, &str)>, ModelRequestError> {
    let Some(value) = reference.strip_prefix("data:") else {
        return Ok(None);
    };
    let (metadata, encoded) = value.split_once(',').ok_or_else(|| {
        ModelRequestError::new(
            "model_response_invalid",
            "fal-ai/flux/dev/image-to-image returned a malformed data URI.",
        )
    })?;
    let mime = metadata
        .strip_suffix(";base64")
        .filter(|mime| mime.starts_with("image/"))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "fal-ai/flux/dev/image-to-image returned a non-image or non-base64 data URI.",
            )
        })?;
    Ok(Some((mime, encoded)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_mode_data_uri_has_an_image_mime_and_base64_payload() {
        assert_eq!(
            inline_file("data:image/png;base64,AQID").expect("valid data URI"),
            Some(("image/png", "AQID"))
        );
        assert!(inline_file("data:text/plain;base64,AQID").is_err());
    }
}
