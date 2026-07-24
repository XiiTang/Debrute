use std::{collections::BTreeMap, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value, json};

use crate::project::{
    CanvasMediaKind, GeneratedArtifactRole, project_media_kind_from_content_type,
};

use super::{
    common::{
        ExecutionContext, authorization, decode_base64, decode_data_url, execute_result,
        extension_for_mime, join_url, mime_from_path_or_bytes, mime_from_response,
        strip_output_arguments, validate_generated_artifact_count,
    },
    types::{
        GeneratedPayload, GenerationError, HttpBody, HttpMethod, ModelExecution, MultipartFile,
    },
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    let model = context.model.model_id.as_str();
    let result = match model {
        "gpt-image-1" | "gpt-image-2" => execute_openai(&mut context),
        "doubao-seedream-5-0-lite-260128" => execute_doubao(&mut context),
        "wan2.7-image" => execute_wan(&mut context),
        "gemini-3-pro-image-preview"
        | "gemini-3.1-flash-image"
        | "gemini-3.1-flash-image-preview" => execute_gemini(&mut context),
        "fal-ai/flux/dev" | "fal-ai/flux/dev/image-to-image" => execute_fal(&mut context),
        "image-01" => execute_minimax(&mut context),
        "grok-imagine" => execute_vydra(&mut context),
        _ => Err(GenerationError::new(
            "image_model_unavailable",
            format!("Image model adapter is unavailable: {model}"),
        )),
    }?;
    execute_result(result.payloads, result.safe_request, context)
}

struct ImageResult {
    payloads: Vec<GeneratedPayload>,
    safe_request: Value,
}

#[allow(
    clippy::too_many_lines,
    reason = "OpenAI generation, JSON edits, and multipart edits share one exact response contract"
)]
fn execute_openai(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut args = strip_output_arguments(context.arguments);
    let output_mime = match args.get("output_format").and_then(Value::as_str) {
        Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    let inputs = resolve_image_values(context, args.remove("image"))?;
    let masks = resolve_image_values(context, args.remove("mask"))?;
    if !masks.is_empty() && inputs.is_empty() {
        return Err(GenerationError::new(
            "generation_argument_invalid",
            "Image input field mask requires non-empty image input.",
        ));
    }
    let (url, body, response) = if inputs.is_empty() {
        let url = join_url(&context.model.base_url, "images/generations")?;
        let mut body = args;
        body.insert(
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        );
        let response = context.json(
            HttpMethod::Post,
            url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Json(Value::Object(body.clone())),
        )?;
        (url, Value::Object(body), response)
    } else if context.model.model_id == "gpt-image-2"
        && inputs.iter().chain(&masks).all(ImageInput::is_public_url)
    {
        let url = join_url(&context.model.base_url, "images/edits")?;
        let mut body = args;
        body.insert(
            "model".to_owned(),
            Value::String(context.model.request_model_id.clone()),
        );
        body.insert(
            "images".to_owned(),
            Value::Array(
                inputs
                    .iter()
                    .map(|input| json!({"image_url": input.uri}))
                    .collect(),
            ),
        );
        if let Some(mask) = masks.first() {
            body.insert("mask".to_owned(), json!({"image_url": mask.uri}));
        }
        let response = context.json(
            HttpMethod::Post,
            url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Json(Value::Object(body.clone())),
        )?;
        (url, Value::Object(body), response)
    } else {
        let url = join_url(&context.model.base_url, "images/edits")?;
        let mut fields = args
            .into_iter()
            .map(|(key, value)| (key, form_value(&value)))
            .collect::<BTreeMap<_, _>>();
        fields.insert("model".to_owned(), context.model.request_model_id.clone());
        let mut files = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let (mime, bytes) = input_bytes(context, input)?;
            files.push(MultipartFile {
                name: "image[]".to_owned(),
                filename: format!("image-{index}.{}", extension_for_mime(&mime)?),
                content_type: mime,
                bytes,
            });
        }
        if let Some(mask) = masks.first() {
            let (mime, bytes) = input_bytes(context, mask)?;
            files.push(MultipartFile {
                name: "mask".to_owned(),
                filename: format!("mask.{}", extension_for_mime(&mime)?),
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
        let response = context.json(
            HttpMethod::Post,
            url.clone(),
            BTreeMap::from([(
                "authorization".to_owned(),
                format!("Bearer {}", context.model.api_key),
            )]),
            HttpBody::Multipart { fields, files },
        )?;
        (url, safe_body, response)
    };
    let mut payloads = Vec::new();
    let mut revised_prompts = Vec::new();
    let items = response
        .get("data")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    validate_generated_artifact_count(items.len())?;
    for item in items {
        if let Some(encoded) = item.get("b64_json").and_then(Value::as_str) {
            payloads.push(image_payload(
                decode_base64(encoded, "OpenAI image")?,
                output_mime,
                json!({"revisedPrompt": item.get("revised_prompt")}),
            )?);
        } else if let Some(url) = item.get("url").and_then(Value::as_str) {
            payloads.push(download_image(context, url)?);
        }
        if let Some(prompt) = item.get("revised_prompt").and_then(Value::as_str) {
            revised_prompts.push(prompt.to_owned());
        }
    }
    Ok(ImageResult {
        payloads,
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": authorization(&context.model.api_key),
            "body": body,
            "parsed": {"revisedPrompts": revised_prompts},
        }),
    })
}

fn execute_doubao(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = strip_output_arguments(context.arguments);
    normalize_string_or_array_media(context, &mut body, "image")?;
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
    let urls = response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let payloads = download_images(context, &urls)?;
    Ok(ImageResult {
        payloads,
        safe_request: request_log(&url, &body, context),
    })
}

fn execute_wan(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut args = strip_output_arguments(context.arguments);
    let prompt = args.remove("prompt");
    let images = resolve_image_values(context, args.remove("image"))?;
    if images.len() > 9 {
        return Err(GenerationError::new(
            "generation_argument_invalid",
            "wan2.7-image supports at most 9 reference images.",
        ));
    }
    let mut message_content = images
        .into_iter()
        .map(|image| json!({"image": image.as_uri()}))
        .collect::<Vec<_>>();
    if let Some(prompt) = prompt {
        message_content.push(json!({"text": prompt}));
    }
    let body = json!({
        "model": context.model.request_model_id,
        "input": {"messages": [{"role": "user", "content": message_content}]},
        "parameters": args,
    });
    let submit_url = join_url(
        &context.model.base_url,
        "services/aigc/image-generation/generation",
    )?;
    let mut headers = authorization(&context.model.api_key);
    headers.insert("x-dashscope-async".to_owned(), "enable".to_owned());
    let submit = context.json(
        HttpMethod::Post,
        submit_url.clone(),
        headers,
        HttpBody::Json(body.clone()),
    )?;
    let task_id = submit
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new("model_response_invalid", "Wan response omitted task_id.")
        })?;
    let poll_url = join_url(&context.model.base_url, &format!("tasks/{task_id}"))?;
    loop {
        let poll = context.json(
            HttpMethod::Get,
            poll_url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Empty,
        )?;
        match poll.pointer("/output/task_status").and_then(Value::as_str) {
            Some("SUCCEEDED") => {
                let urls = poll
                    .pointer("/output/choices")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .flat_map(|choice| {
                        choice
                            .pointer("/message/content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                    })
                    .filter_map(|item| item.get("image").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                return Ok(ImageResult {
                    payloads: download_images(context, &urls)?,
                    safe_request: request_log_value(&submit_url, &body, context),
                });
            }
            Some("FAILED" | "CANCELED") => {
                return Err(GenerationError::new(
                    "generation_task_failed",
                    "Wan image task failed or was cancelled by the model service.",
                ));
            }
            Some("PENDING" | "RUNNING") | None => context.sleep(POLL_INTERVAL)?,
            Some(status) => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    format!("Wan returned unknown task status: {status}"),
                ));
            }
        }
    }
}

fn execute_gemini(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut args = strip_output_arguments(context.arguments);
    let prompt = args.remove("prompt");
    let contents = normalize_gemini_contents(context, args.remove("contents"), prompt)?;
    let aspect_ratio = args.remove("aspect_ratio");
    let image_size = args.remove("image_size");
    let mut image_config = Map::new();
    if let Some(value) = aspect_ratio {
        image_config.insert("aspectRatio".to_owned(), value);
    }
    if let Some(value) = image_size {
        image_config.insert("imageSize".to_owned(), value);
    }
    let mut generation_config =
        Map::from_iter([("responseModalities".to_owned(), json!(["TEXT", "IMAGE"]))]);
    if !image_config.is_empty() {
        generation_config.insert("responseFormat".to_owned(), json!({"image": image_config}));
    }
    let mut body = args;
    body.insert("contents".to_owned(), Value::Array(contents));
    body.insert(
        "generationConfig".to_owned(),
        Value::Object(generation_config),
    );
    let mut url = url::Url::parse(&join_url(
        &context.model.base_url,
        &format!("models/{}:generateContent", context.model.request_model_id),
    )?)
    .map_err(|error| GenerationError::new("model_configuration_invalid", error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("key", &context.model.api_key);
    let response = context.json(
        HttpMethod::Post,
        url.to_string(),
        BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let image_parts = response
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|candidate| {
            candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|part| part.get("inlineData").or_else(|| part.get("inline_data")))
        .collect::<Vec<_>>();
    validate_generated_artifact_count(image_parts.len())?;
    let mut payloads = Vec::with_capacity(image_parts.len());
    for inline in image_parts {
        let data = inline.get("data").and_then(Value::as_str).ok_or_else(|| {
            GenerationError::new("model_response_invalid", "Gemini image part omitted data.")
        })?;
        let mime = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        payloads.push(image_payload(
            decode_base64(data, "Gemini image")?,
            mime,
            Value::Null,
        )?);
    }
    Ok(ImageResult {
        payloads,
        safe_request: request_log_value(url.as_str(), &Value::Object(body), context),
    })
}

fn execute_fal(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = strip_output_arguments(context.arguments);
    normalize_string_or_array_media(context, &mut body, "image_url")?;
    let url = join_url(&context.model.base_url, &context.model.request_model_id)?;
    let headers = BTreeMap::from([
        (
            "authorization".to_owned(),
            format!("Key {}", context.model.api_key),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
    ]);
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let urls = response
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(ImageResult {
        payloads: download_images(context, &urls)?,
        safe_request: json!({"method": "POST", "url": url, "headers": headers, "body": body}),
    })
}

fn execute_minimax(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut args = strip_output_arguments(context.arguments);
    if let Some(Value::Array(references)) = args.get_mut("subject_reference") {
        for reference in references {
            let object = reference.as_object_mut().ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    "MiniMax subject_reference entries must be objects.",
                )
            })?;
            let source = object
                .get("image_file")
                .or_else(|| object.get("image_url"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    GenerationError::new(
                        "generation_argument_invalid",
                        "MiniMax subject reference omitted image_file.",
                    )
                })?;
            object.insert(
                "image_file".to_owned(),
                Value::String(context.resolve_media_reference(source)?),
            );
            object.remove("image_url");
        }
    }
    args.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    let url = join_url(&context.model.base_url, "v1/image_generation")?;
    let response = context.json(
        HttpMethod::Post,
        url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(args.clone())),
    )?;
    if response
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0)
    {
        return Err(GenerationError::new(
            "generation_task_failed",
            "MiniMax image request returned a business error.",
        ));
    }
    let encoded_images = response
        .pointer("/data/image_base64")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    validate_generated_artifact_count(encoded_images.len())?;
    let mut payloads = Vec::with_capacity(encoded_images.len());
    for encoded in encoded_images.iter().filter_map(Value::as_str) {
        payloads.push(image_payload(
            decode_base64(encoded, "MiniMax image")?,
            "image/png",
            Value::Null,
        )?);
    }
    Ok(ImageResult {
        payloads,
        safe_request: request_log(&url, &args, context),
    })
}

fn execute_vydra(context: &mut ExecutionContext<'_>) -> Result<ImageResult, GenerationError> {
    let mut body = strip_output_arguments(context.arguments);
    body.insert(
        "model".to_owned(),
        Value::String("text-to-image".to_owned()),
    );
    let submit_url = join_url(
        &context.model.base_url,
        &format!("models/{}", context.model.request_model_id),
    )?;
    let submit = context.json(
        HttpMethod::Post,
        submit_url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let job_id = submit
        .get("jobId")
        .or_else(|| submit.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new("model_response_invalid", "Vydra response omitted job id.")
        })?;
    let poll_url = join_url(&context.model.base_url, &format!("jobs/{job_id}"))?;
    loop {
        let poll = context.json(
            HttpMethod::Get,
            poll_url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Empty,
        )?;
        let status = poll
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        if status == "completed" {
            let url = [Some(&poll), poll.get("output"), poll.get("result")]
                .into_iter()
                .flatten()
                .find_map(|value| {
                    value
                        .get("url")
                        .or_else(|| value.get("imageUrl"))
                        .and_then(Value::as_str)
                })
                .ok_or_else(|| {
                    GenerationError::new(
                        "model_response_invalid",
                        "Vydra completed without an image URL.",
                    )
                })?;
            return Ok(ImageResult {
                payloads: vec![download_image(context, url)?],
                safe_request: request_log(&submit_url, &body, context),
            });
        }
        if matches!(
            status.as_str(),
            "failed" | "error" | "cancelled" | "canceled"
        ) {
            return Err(GenerationError::new(
                "generation_task_failed",
                format!("Vydra image task ended with status {status}."),
            ));
        }
        context.sleep(POLL_INTERVAL)?;
    }
}

#[derive(Clone)]
struct ImageInput {
    uri: Option<String>,
    mime: String,
    bytes: Option<Vec<u8>>,
}

impl ImageInput {
    fn as_uri(&self) -> String {
        self.uri.clone().unwrap_or_else(|| {
            format!(
                "data:{};base64,{}",
                self.mime,
                BASE64.encode(self.bytes.as_deref().unwrap_or_default())
            )
        })
    }
}

fn resolve_image_values(
    context: &ExecutionContext<'_>,
    value: Option<Value>,
) -> Result<Vec<ImageInput>, GenerationError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = match value {
        Value::Array(values) if values.is_empty() => {
            return Err(GenerationError::new(
                "generation_argument_invalid",
                "Image input arrays must be non-empty.",
            ));
        }
        Value::Array(values) => values,
        value => vec![value],
    };
    values
        .into_iter()
        .map(|value| resolve_image_value(context, &value))
        .collect()
}

fn resolve_image_value(
    context: &ExecutionContext<'_>,
    value: &Value,
) -> Result<ImageInput, GenerationError> {
    if let Some(reference) = value.as_str() {
        let resolved = context.resolve_media_reference(reference)?;
        return input_from_uri(&resolved);
    }
    let object = value.as_object().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "Image input must be a string or supported image object.",
        )
    })?;
    if let Some(uri) = object
        .get("image_url")
        .or_else(|| object.get("image_file"))
        .and_then(Value::as_str)
    {
        let resolved = context.resolve_media_reference(uri)?;
        return input_from_uri(&resolved);
    }
    let data = object.get("data").and_then(Value::as_str).ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "Image input object omitted image_url or data.",
        )
    })?;
    let mime = object
        .get("mime_type")
        .and_then(Value::as_str)
        .filter(|value| project_media_kind_from_content_type(value) == CanvasMediaKind::Image)
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "Image input data omitted an image MIME type.",
            )
        })?;
    Ok(ImageInput {
        uri: None,
        mime: mime.to_owned(),
        bytes: Some(decode_base64(data, "Image input")?),
    })
}

fn input_from_uri(uri: &str) -> Result<ImageInput, GenerationError> {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        let mime = mime_from_path_or_bytes(uri, &[]).ok_or_else(|| {
            GenerationError::new(
                "generation_input_invalid",
                "Remote image URL must have a supported image extension.",
            )
        })?;
        Ok(ImageInput {
            uri: Some(uri.to_owned()),
            mime: mime.to_owned(),
            bytes: None,
        })
    } else {
        let (mime, bytes) = decode_data_url(uri, 64 * 1024 * 1024)?;
        if project_media_kind_from_content_type(&mime) != CanvasMediaKind::Image {
            return Err(GenerationError::new(
                "generation_input_invalid",
                "Image input data URL did not contain image media.",
            ));
        }
        Ok(ImageInput {
            uri: Some(uri.to_owned()),
            mime,
            bytes: Some(bytes),
        })
    }
}

impl ImageInput {
    fn is_public_url(&self) -> bool {
        self.uri
            .as_deref()
            .is_some_and(|uri| uri.starts_with("http://") || uri.starts_with("https://"))
    }
}

fn input_bytes(
    context: &mut ExecutionContext<'_>,
    input: &ImageInput,
) -> Result<(String, Vec<u8>), GenerationError> {
    if let Some(bytes) = &input.bytes {
        return Ok((input.mime.clone(), bytes.clone()));
    }
    let uri = input.uri.as_deref().ok_or_else(|| {
        GenerationError::new(
            "generation_input_invalid",
            "Image input omitted bytes and URL.",
        )
    })?;
    let response = context.download(uri)?;
    let mime = mime_from_response(&response).unwrap_or_else(|| input.mime.clone());
    Ok((mime, response.body))
}

fn normalize_string_or_array_media(
    context: &ExecutionContext<'_>,
    body: &mut Map<String, Value>,
    key: &str,
) -> Result<(), GenerationError> {
    let Some(value) = body.remove(key) else {
        return Ok(());
    };
    let array = value.is_array();
    let resolved = resolve_image_values(context, Some(value))?
        .into_iter()
        .map(|input| Value::String(input.as_uri()))
        .collect::<Vec<_>>();
    body.insert(
        key.to_owned(),
        if array {
            Value::Array(resolved)
        } else {
            resolved.into_iter().next().unwrap_or(Value::Null)
        },
    );
    Ok(())
}

fn normalize_gemini_contents(
    context: &ExecutionContext<'_>,
    contents: Option<Value>,
    prompt: Option<Value>,
) -> Result<Vec<Value>, GenerationError> {
    let mut contents = contents
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    if contents.is_empty() {
        contents.push(json!({"role": "user", "parts": []}));
    }
    for content in &mut contents {
        let parts = content
            .get_mut("parts")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    "Gemini content entries must contain parts arrays.",
                )
            })?;
        for part in parts {
            let Some(file_data) = part.get("fileData").and_then(Value::as_object) else {
                continue;
            };
            let reference = file_data
                .get("fileUri")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    GenerationError::new(
                        "generation_argument_invalid",
                        "Gemini fileData omitted fileUri.",
                    )
                })?;
            let resolved = context.resolve_media_reference(reference)?;
            if resolved.starts_with("http") {
                *part = json!({"fileData": {
                    "fileUri": resolved,
                    "mimeType": mime_from_path_or_bytes(reference, &[]).unwrap_or("image/png"),
                }});
            } else {
                let (mime, bytes) = decode_data_url(&resolved, 64 * 1024 * 1024)?;
                *part = json!({"inlineData": {"mimeType": mime, "data": BASE64.encode(bytes)}});
            }
        }
    }
    if let Some(Value::String(prompt)) = prompt
        && !prompt.trim().is_empty()
    {
        let first = contents[0].as_object_mut().ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "Gemini content entry must be an object.",
            )
        })?;
        let parts = first
            .entry("parts")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    "Gemini content parts must be an array.",
                )
            })?;
        parts.insert(0, json!({"text": prompt}));
    }
    Ok(contents)
}

fn download_images(
    context: &mut ExecutionContext<'_>,
    urls: &[String],
) -> Result<Vec<GeneratedPayload>, GenerationError> {
    validate_generated_artifact_count(urls.len())?;
    urls.iter()
        .map(|url| download_image(context, url))
        .collect()
}

fn download_image(
    context: &mut ExecutionContext<'_>,
    url: &str,
) -> Result<GeneratedPayload, GenerationError> {
    let response = context.download(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "Generated image response has no supported MIME type.",
            )
        })?;
    image_payload(response.body, &mime, json!({"url": url}))
}

fn image_payload(
    bytes: Vec<u8>,
    mime: &str,
    output: Value,
) -> Result<GeneratedPayload, GenerationError> {
    if !mime.starts_with("image/") {
        return Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated image has non-image MIME type: {mime}"),
        ));
    }
    Ok(GeneratedPayload {
        bytes,
        mime_type: mime.to_owned(),
        role: GeneratedArtifactRole::PrimaryImage,
        suggested_extension: extension_for_mime(mime)?,
        model_output: output,
    })
}

fn request_log(url: &str, body: &Map<String, Value>, context: &ExecutionContext<'_>) -> Value {
    request_log_value(url, &Value::Object(body.clone()), context)
}

fn request_log_value(url: &str, body: &Value, context: &ExecutionContext<'_>) -> Value {
    json!({
        "method": "POST",
        "url": url,
        "headers": authorization(&context.model.api_key),
        "body": body,
    })
}

fn form_value(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_mime_is_required_for_image_payloads() {
        assert!(image_payload(vec![1], "video/mp4", Value::Null).is_err());
        assert_eq!(
            image_payload(vec![1], "image/png", Value::Null)
                .unwrap()
                .suggested_extension,
            "png"
        );
    }
}
