use std::time::Duration;

use serde_json::{Map, Value, json};

use super::{VideoResult, download_video_artifact};
use crate::{
    generation::{
        common::{ExecutionContext, ResolvedMediaReference, authorization, join_url},
        types::{GenerationError, HttpBody, HttpMethod},
    },
    project::{CanvasMediaKind, GeneratedArtifactRole, project_media_kind_from_content_type},
};

const MODEL_ID: &str = "doubao-seedance-2-0-mini-260615";
const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(super) fn execute(context: &mut ExecutionContext<'_>) -> Result<VideoResult, GenerationError> {
    let body = request_body(context)?;
    let submit_url = join_url(&context.model.base_url, "contents/generations/tasks")?;
    let submit = context.json(
        HttpMethod::Post,
        submit_url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(body.clone()),
    )?;
    let task_id = exact_task_id(&submit)?;
    let poll_url = join_url(
        &context.model.base_url,
        &format!("contents/generations/tasks/{task_id}"),
    )?;

    loop {
        let poll = context.json(
            HttpMethod::Get,
            poll_url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Empty,
        )?;
        match poll.get("status").and_then(Value::as_str) {
            Some("succeeded") => {
                let video_url = exact_video_url(&poll)?;
                let mut payloads = vec![download_video_artifact(
                    context,
                    video_url,
                    GeneratedArtifactRole::PrimaryVideo,
                )?];
                if context
                    .arguments
                    .get("return_last_frame")
                    .and_then(Value::as_bool)
                    == Some(true)
                    && let Some(last_frame_url) = poll
                        .pointer("/content/last_frame_url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                {
                    payloads.push(download_video_artifact(
                        context,
                        last_frame_url,
                        GeneratedArtifactRole::LastFrame,
                    )?);
                }
                return Ok(VideoResult {
                    payloads,
                    safe_request: json!({
                        "method": "POST",
                        "url": submit_url,
                        "headers": {"authorization": "[REDACTED]"},
                        "body": body,
                        "taskId": task_id,
                    }),
                });
            }
            Some("queued" | "pending" | "running" | "in_progress") => {
                context.sleep(POLL_INTERVAL)?;
            }
            Some("failed" | "expired" | "canceled" | "cancelled") => {
                return Err(remote_task_error(&poll));
            }
            Some(status) => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    format!("{MODEL_ID} returned task status {status}."),
                ));
            }
            None => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    format!("{MODEL_ID} task response omitted status."),
                ));
            }
        }
    }
}

fn request_body(context: &mut ExecutionContext<'_>) -> Result<Value, GenerationError> {
    let mut arguments = context.arguments.clone();
    let prompt = required_string(&mut arguments, "prompt")?;
    let intent = required_string(&mut arguments, "intent")?;
    validate_intent(&intent)?;
    let references = arguments
        .remove("references")
        .map(|value| {
            value.as_array().cloned().ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    format!("{MODEL_ID} references must be an array."),
                )
            })
        })
        .transpose()?
        .unwrap_or_default();
    let references = references
        .iter()
        .enumerate()
        .map(|(index, reference)| normalize_reference(context, reference, index))
        .collect::<Result<Vec<_>, _>>()?;

    let mut content_items = vec![json!({"type": "text", "text": prompt})];
    for (index, reference) in references.iter().enumerate() {
        let role = reference_role(&intent, &reference.media_type, index);
        content_items.push(match reference.media_type.as_str() {
            "image" => {
                json!({"type": "image_url", "image_url": {"url": reference.url}, "role": role})
            }
            "video" => {
                json!({"type": "video_url", "video_url": {"url": reference.url}, "role": role})
            }
            "audio" => {
                json!({"type": "audio_url", "audio_url": {"url": reference.url}, "role": role})
            }
            _ => unreachable!("validated Seedance 2.0 Mini reference type"),
        });
    }

    arguments.insert("content".to_owned(), Value::Array(content_items));
    arguments.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    Ok(Value::Object(arguments))
}

fn required_string(
    arguments: &mut Map<String, Value>,
    name: &str,
) -> Result<String, GenerationError> {
    arguments
        .remove(name)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                format!("{MODEL_ID} requires materialized {name}."),
            )
        })
}

struct VideoReference {
    media_type: String,
    url: String,
}

fn normalize_reference(
    context: &mut ExecutionContext<'_>,
    reference: &Value,
    index: usize,
) -> Result<VideoReference, GenerationError> {
    let reference = reference.as_object().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            format!("{MODEL_ID} references[{index}] must be an object."),
        )
    })?;
    if let Some(unknown) = reference
        .keys()
        .find(|key| !matches!(key.as_str(), "source" | "media_type"))
    {
        return Err(GenerationError::new(
            "generation_argument_invalid",
            format!("{MODEL_ID} references[{index}] contains unknown field {unknown}."),
        ));
    }

    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                format!("{MODEL_ID} references[{index}].source must be a string."),
            )
        })?;
    let media_type = match reference.get("media_type") {
        Some(Value::String(media_type)) if !media_type.is_empty() => media_type.clone(),
        Some(_) => {
            return Err(GenerationError::new(
                "generation_argument_invalid",
                format!("{MODEL_ID} references[{index}].media_type must be a non-empty string."),
            ));
        }
        None => infer_media_type(source).map(str::to_owned).ok_or_else(|| {
            GenerationError::new(
                "video_reference_type_unsupported",
                format!("{MODEL_ID} cannot infer reference type for {source}."),
            )
        })?,
    };
    if !matches!(media_type.as_str(), "image" | "video" | "audio") {
        return Err(GenerationError::new(
            "video_reference_type_unsupported",
            format!("{MODEL_ID} does not map reference type {media_type}."),
        ));
    }

    let url = if source.is_empty() || source.starts_with("asset://") {
        source.to_owned()
    } else if media_type == "video"
        && !source.starts_with("http://")
        && !source.starts_with("https://")
    {
        return Err(GenerationError::new(
            "video_reference_upload_unavailable",
            format!("Project video reference needs a model-reachable URL: {source}"),
        ));
    } else {
        let resolved = context.resolve_media_reference(source)?;
        validate_reference_kind(&resolved, &media_type)?;
        resolved.into_reference_string(context)?
    };
    Ok(VideoReference { media_type, url })
}

fn validate_reference_kind(
    reference: &ResolvedMediaReference,
    media_type: &str,
) -> Result<(), GenerationError> {
    let ResolvedMediaReference::Inline { mime_type, .. } = reference else {
        return Ok(());
    };
    let actual = project_media_kind_from_content_type(mime_type);
    let expected = match media_type {
        "image" => CanvasMediaKind::Image,
        "video" => CanvasMediaKind::Video,
        "audio" => CanvasMediaKind::Audio,
        _ => CanvasMediaKind::Unknown,
    };
    if actual == expected && actual != CanvasMediaKind::Unknown {
        Ok(())
    } else {
        Err(GenerationError::new(
            "generation_argument_invalid",
            format!("{MODEL_ID} reference {media_type} does not match its data URL."),
        ))
    }
}

fn reference_role(intent: &str, media_type: &str, index: usize) -> &'static str {
    match (intent, media_type, index) {
        ("generate", "image", 0) => "first_frame",
        ("generate", "image", _) => "last_frame",
        (_, "image", _) => "reference_image",
        (_, "video", _) => "reference_video",
        (_, "audio", _) => "reference_audio",
        _ => unreachable!("validated Seedance 2.0 Mini intent and reference type"),
    }
}

fn validate_intent(intent: &str) -> Result<(), GenerationError> {
    if matches!(
        intent,
        "generate" | "reference" | "audio_driven" | "extend" | "edit"
    ) {
        Ok(())
    } else {
        Err(GenerationError::new(
            "generation_argument_invalid",
            format!("{MODEL_ID} cannot transform intent {intent}."),
        ))
    }
}

fn infer_media_type(source: &str) -> Option<&'static str> {
    let lower = source
        .split('?')
        .next()
        .unwrap_or(source)
        .to_ascii_lowercase();
    if lower.starts_with("data:image/")
        || [
            ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".heic", ".heif",
        ]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        Some("image")
    } else if lower.starts_with("data:audio/")
        || [".mp3", ".wav"]
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        Some("audio")
    } else if lower.starts_with("data:video/")
        || [".mp4", ".mov"]
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        Some("video")
    } else {
        None
    }
}

fn exact_task_id(response: &Value) -> Result<String, GenerationError> {
    response
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                format!("{MODEL_ID} response omitted id."),
            )
        })
}

fn exact_video_url(response: &Value) -> Result<&str, GenerationError> {
    response
        .pointer("/content/video_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                format!("{MODEL_ID} succeeded without content.video_url."),
            )
        })
}

fn remote_task_error(response: &Value) -> GenerationError {
    let status = response
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let detail = response
        .get("error")
        .or_else(|| response.get("failure_reason"))
        .map_or_else(
            || "remote endpoint returned no detail".to_owned(),
            Value::to_string,
        );
    GenerationError::new(
        "generation_task_failed",
        format!("{MODEL_ID} task {status}: {detail}"),
    )
}
