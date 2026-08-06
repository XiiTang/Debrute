use std::time::Duration;

use serde_json::{Map, Value, json};

use super::{VideoResult, download_image, download_video};
use crate::{
    model_request::{
        common::{ExecutionContext, ResolvedMediaReference, authorization, join_url},
        types::{HttpBody, HttpMethod, ModelRequestError},
    },
    project::{CanvasMediaKind, project_media_kind_from_content_type},
};

const MODEL_ID: &str = "doubao-seedance-2-0-mini-260615";
const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<VideoResult, ModelRequestError> {
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
    let mut remotely_cancellable = true;
    let result = (|| loop {
        let poll = context.json(
            HttpMethod::Get,
            poll_url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Empty,
        )?;
        match poll.get("status").and_then(Value::as_str) {
            Some("succeeded") => {
                remotely_cancellable = false;
                let video_url = exact_video_url(&poll)?;
                let mut payloads = vec![download_video(context, video_url)?];
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
                    payloads.push(download_image(context, last_frame_url)?);
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
            Some("queued") => {
                context.sleep(POLL_INTERVAL)?;
            }
            Some("running") => {
                remotely_cancellable = false;
                context.sleep(POLL_INTERVAL)?;
            }
            Some("failed") => {
                let (code, message) = exact_task_failure(&poll)?;
                return Err(ModelRequestError::new(
                    "model_request_task_failed",
                    format!("{MODEL_ID} task failed ({code}): {message}"),
                ));
            }
            Some("cancelled") => {
                return Err(ModelRequestError::new(
                    "model_request_task_failed",
                    format!("{MODEL_ID} task was cancelled by the remote endpoint."),
                ));
            }
            Some(status) => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    format!("{MODEL_ID} returned task status {status}."),
                ));
            }
            None => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    format!("{MODEL_ID} task response omitted status."),
                ));
            }
        }
    })();
    finish_poll(context, poll_url, remotely_cancellable, result)
}

fn finish_poll(
    context: &ExecutionContext<'_>,
    poll_url: String,
    remotely_cancellable: bool,
    result: Result<VideoResult, ModelRequestError>,
) -> Result<VideoResult, ModelRequestError> {
    if result
        .as_ref()
        .is_err_and(|error| error.code() == "model_request_cancelled")
        && remotely_cancellable
    {
        context.best_effort_remote_cancellation(
            HttpMethod::Delete,
            poll_url,
            authorization(&context.model.api_key),
            HttpBody::Empty,
        );
    }
    result
}

fn request_body(context: &mut ExecutionContext<'_>) -> Result<Value, ModelRequestError> {
    let mut arguments = context.arguments.clone();
    let prompt = arguments.remove("prompt");
    let intent = required_string(&mut arguments, "intent")?;
    validate_intent(&intent)?;
    let references = arguments
        .remove("references")
        .map(|value| {
            value.as_array().cloned().ok_or_else(|| {
                ModelRequestError::new(
                    "model_request_argument_invalid",
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

    let mut content_items = Vec::new();
    if let Some(prompt) = prompt {
        content_items.push(json!({"type": "text", "text": prompt}));
    }
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

    for field in ["content", "model"] {
        if arguments.contains_key(field) {
            return Err(ModelRequestError::new(
                "model_request_argument_collision",
                format!("{MODEL_ID} arguments.{field} conflicts with Debrute request mapping."),
            ));
        }
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
) -> Result<String, ModelRequestError> {
    arguments
        .remove(name)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
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
) -> Result<VideoReference, ModelRequestError> {
    let reference = reference.as_object().ok_or_else(|| {
        ModelRequestError::new(
            "model_request_argument_invalid",
            format!("{MODEL_ID} references[{index}] must be an object."),
        )
    })?;
    if let Some(unknown) = reference
        .keys()
        .find(|key| !matches!(key.as_str(), "source" | "media_type"))
    {
        return Err(ModelRequestError::new(
            "model_request_argument_invalid",
            format!("{MODEL_ID} references[{index}] contains unknown field {unknown}."),
        ));
    }

    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                format!("{MODEL_ID} references[{index}].source must be a string."),
            )
        })?;
    let media_type = match reference.get("media_type") {
        Some(Value::String(media_type)) if !media_type.is_empty() => media_type.clone(),
        Some(_) => {
            return Err(ModelRequestError::new(
                "model_request_argument_invalid",
                format!("{MODEL_ID} references[{index}].media_type must be a non-empty string."),
            ));
        }
        None => infer_media_type(source).map(str::to_owned).ok_or_else(|| {
            ModelRequestError::new(
                "video_reference_type_unsupported",
                format!("{MODEL_ID} cannot infer reference type for {source}."),
            )
        })?,
    };
    if !matches!(media_type.as_str(), "image" | "video" | "audio") {
        return Err(ModelRequestError::new(
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
        return Err(ModelRequestError::new(
            "video_reference_upload_unavailable",
            format!("Local video reference needs a model-reachable URL: {source}"),
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
) -> Result<(), ModelRequestError> {
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
        Err(ModelRequestError::new(
            "model_request_argument_invalid",
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

fn validate_intent(intent: &str) -> Result<(), ModelRequestError> {
    if matches!(
        intent,
        "generate" | "reference" | "audio_driven" | "extend" | "edit"
    ) {
        Ok(())
    } else {
        Err(ModelRequestError::new(
            "model_request_argument_invalid",
            format!("{MODEL_ID} cannot transform intent {intent}."),
        ))
    }
}

fn infer_media_type(source: &str) -> Option<&'static str> {
    let lower = source
        .split_once('?')
        .map_or(source, |(path, _)| path)
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

fn exact_task_id(response: &Value) -> Result<String, ModelRequestError> {
    response
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} response omitted id."),
            )
        })
}

fn exact_video_url(response: &Value) -> Result<&str, ModelRequestError> {
    response
        .pointer("/content/video_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} succeeded without content.video_url."),
            )
        })
}

fn exact_task_failure(response: &Value) -> Result<(&str, &str), ModelRequestError> {
    let error = response
        .get("error")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} failed without error."),
            )
        })?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} failed without error.code."),
            )
        })?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("{MODEL_ID} failed without error.message."),
            )
        })?;
    Ok((code, message))
}
