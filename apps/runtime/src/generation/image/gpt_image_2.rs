use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::{ImageResult, form_value, image_payload};
use crate::generation::{
    common::{
        ExecutionContext, ResolvedMediaReference, authorization, decode_base64, join_url,
        mime_from_path_or_bytes, mime_from_response,
    },
    types::{GenerationError, HttpBody, HttpMethod, MultipartFile},
};

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut arguments = context.arguments.clone();
    let image_present = arguments.contains_key("image");
    let mask_present = arguments.contains_key("mask");
    let images = resolve_images(context, arguments.remove("image"))?;
    let mask = resolve_mask(context, arguments.remove("mask"))?;
    let editing = image_present || mask_present;

    let (url, safe_body, response) = if !editing {
        generation_request(context, arguments)?
    } else if images.iter().all(ImageReference::is_public_url)
        && mask.as_ref().is_none_or(ImageReference::is_public_url)
    {
        json_edit_request(context, arguments, &images, mask.as_ref())?
    } else {
        multipart_edit_request(context, arguments, images, mask)?
    };

    parse_response(&url, &safe_body, &response)
}

fn generation_request(
    context: &mut ExecutionContext<'_>,
    mut body: Map<String, Value>,
) -> Result<(String, Value, Value), GenerationError> {
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
    Ok((url, Value::Object(body), response))
}

fn json_edit_request(
    context: &mut ExecutionContext<'_>,
    mut body: Map<String, Value>,
    images: &[ImageReference],
    mask: Option<&ImageReference>,
) -> Result<(String, Value, Value), GenerationError> {
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    body.insert(
        "images".to_owned(),
        Value::Array(
            images
                .iter()
                .map(|image| {
                    image
                        .public_url(context)
                        .map(|url| json!({"image_url": url}))
                })
                .collect::<Result<Vec<_>, _>>()?,
        ),
    );
    if let Some(mask) = mask {
        body.insert(
            "mask".to_owned(),
            json!({"image_url": mask.public_url(context)?}),
        );
    }
    let url = join_url(&context.model.base_url, "images/edits")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    Ok((url, Value::Object(body), response))
}

fn multipart_edit_request(
    context: &mut ExecutionContext<'_>,
    arguments: Map<String, Value>,
    images: Vec<ImageReference>,
    mask: Option<ImageReference>,
) -> Result<(String, Value, Value), GenerationError> {
    let mut fields = arguments
        .into_iter()
        .map(|(key, value)| (key, form_value(&value)))
        .collect::<BTreeMap<_, _>>();
    fields.insert("model".to_owned(), context.model.request_model_id.clone());
    let mut files = Vec::new();
    for (index, image) in images.into_iter().enumerate() {
        let (mime, bytes) = image.bytes(context)?;
        files.push(MultipartFile {
            name: "image[]".to_owned(),
            filename: format!("image-{index}"),
            content_type: mime,
            bytes,
        });
    }
    if let Some(mask) = mask {
        let (mime, bytes) = mask.bytes(context)?;
        files.push(MultipartFile {
            name: "mask".to_owned(),
            filename: "mask".to_owned(),
            content_type: mime,
            bytes,
        });
    }
    let safe_body = json!({
        "fields": fields,
        "files": files.iter().map(|file| json!({
            "name": file.name,
            "filename": file.filename,
            "contentType": file.content_type,
            "bytes": file.bytes.len(),
        })).collect::<Vec<_>>()
    });
    let url = join_url(&context.model.base_url, "images/edits")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        BTreeMap::from([(
            "authorization".to_owned(),
            format!("Bearer {}", context.model.api_key),
        )]),
        HttpBody::Multipart { fields, files },
    )?;
    Ok((url, safe_body, response))
}

fn parse_response(
    url: &str,
    safe_body: &Value,
    response: &Value,
) -> Result<ImageResult, GenerationError> {
    let items = response
        .get("data")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "gpt-image-2 response omitted a non-empty data array.",
            )
        })?;
    let mut payloads = Vec::with_capacity(items.len());
    for item in items {
        let encoded = item
            .get("b64_json")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                GenerationError::new(
                    "model_response_invalid",
                    "gpt-image-2 response item omitted b64_json.",
                )
            })?;
        let bytes = decode_base64(encoded, "gpt-image-2 image")?;
        let mime = mime_from_path_or_bytes("", &bytes).ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "gpt-image-2 returned an unsupported image encoding.",
            )
        })?;
        payloads.push(image_payload(
            bytes,
            mime,
            json!({"revisedPrompt": item.get("revised_prompt")}),
        )?);
    }
    Ok(ImageResult {
        payloads,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "body": safe_body,
        }),
    })
}

struct ImageReference {
    reference: ResolvedMediaReference,
}

impl ImageReference {
    fn is_public_url(&self) -> bool {
        self.reference.is_public_url()
    }

    fn public_url<'b>(
        &'b self,
        context: &mut ExecutionContext<'_>,
    ) -> Result<&'b str, GenerationError> {
        Ok(self
            .reference
            .accounted_public_url(context)?
            .expect("public URL edit branch checked every image reference"))
    }

    fn bytes(
        self,
        context: &mut ExecutionContext<'_>,
    ) -> Result<(String, Vec<u8>), GenerationError> {
        let (mime, bytes) = match self.reference {
            ResolvedMediaReference::PublicUrl(url) => {
                let response = context.download_input_media(&url)?;
                let mime = mime_from_response(&response)
                    .filter(|mime| mime.starts_with("image/"))
                    .or_else(|| mime_from_path_or_bytes(&url, &response.body).map(str::to_owned))
                    .ok_or_else(|| {
                        GenerationError::new(
                            "generation_input_invalid",
                            "gpt-image-2 edit input is not a supported image.",
                        )
                    })?;
                (mime, response.body)
            }
            ResolvedMediaReference::Inline {
                mime_type, bytes, ..
            } => (mime_type, bytes),
        };
        if !mime.starts_with("image/") {
            return Err(GenerationError::new(
                "generation_input_invalid",
                "gpt-image-2 edit input is not an image data URI.",
            ));
        }
        Ok((mime, bytes))
    }
}

fn resolve_images(
    context: &mut ExecutionContext<'_>,
    value: Option<Value>,
) -> Result<Vec<ImageReference>, GenerationError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "gpt-image-2 image must be an array of strings.",
            )
        })?
        .iter()
        .map(|value| resolve_image(context, value, "image"))
        .collect()
}

fn resolve_mask(
    context: &mut ExecutionContext<'_>,
    value: Option<Value>,
) -> Result<Option<ImageReference>, GenerationError> {
    value
        .map(|value| resolve_image(context, &value, "mask"))
        .transpose()
}

fn resolve_image(
    context: &mut ExecutionContext<'_>,
    value: &Value,
    field: &str,
) -> Result<ImageReference, GenerationError> {
    let source = value.as_str().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            format!("gpt-image-2 {field} values must be strings."),
        )
    })?;
    Ok(ImageReference {
        reference: context.resolve_media_reference(source)?,
    })
}
