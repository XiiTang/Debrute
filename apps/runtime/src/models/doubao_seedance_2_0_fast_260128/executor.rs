use std::{collections::BTreeMap, time::Duration};

use serde_json::{Value, json};

use crate::{
    model_request::{
        common::{ExecutionContext, ResolvedMediaReference, join_url},
        image::download_image,
        types::{HttpBody, HttpMethod, ModelExecutionDraft, ModelRequestError},
        video::download_video,
    },
    project::{CanvasMediaKind, project_media_kind_from_content_type},
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
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
                return Ok(ModelExecutionDraft {
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
                    format!("doubao-seedance-2-0-fast-260128 task failed ({code}): {message}"),
                ));
            }
            Some("cancelled") => {
                return Err(ModelRequestError::new(
                    "model_request_task_failed",
                    "doubao-seedance-2-0-fast-260128 task was cancelled by the remote endpoint.",
                ));
            }
            Some(status) => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    format!("doubao-seedance-2-0-fast-260128 returned task status {status}."),
                ));
            }
            None => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    "doubao-seedance-2-0-fast-260128 task response omitted status.",
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
    result: Result<ModelExecutionDraft, ModelRequestError>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
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
    let intent = arguments
        .remove("intent")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                "doubao-seedance-2-0-fast-260128 requires a materialized string intent.",
            )
        })?;
    let references = arguments
        .remove("references")
        .map(|value| {
            value.as_array().cloned().ok_or_else(|| {
                ModelRequestError::new(
                    "model_request_argument_invalid",
                    "doubao-seedance-2-0-fast-260128 references must be an array.",
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
    validate_intent(&intent, &references)?;
    let mut message_parts = Vec::new();
    if let Some(prompt) = prompt {
        message_parts.push(json!({"type": "text", "text": prompt}));
    }
    for (index, reference) in references.iter().enumerate() {
        let role = reference_role(&intent, &reference.media_type, index);
        message_parts.push(match reference.media_type.as_str() {
            "image" | "mask" => {
                json!({"type": "image_url", "image_url": {"url": reference.url}, "role": role})
            }
            "audio" => {
                json!({"type": "audio_url", "audio_url": {"url": reference.url}, "role": role})
            }
            "video" => {
                json!({"type": "video_url", "video_url": {"url": reference.url}, "role": role})
            }
            _ => unreachable!("validated Seedance 2.0 reference type"),
        });
    }
    for field in ["content", "model"] {
        if arguments.contains_key(field) {
            return Err(ModelRequestError::new(
                "model_request_argument_collision",
                format!(
                    "doubao-seedance-2-0-fast-260128 arguments.{field} conflicts with Debrute request mapping."
                ),
            ));
        }
    }
    arguments.insert("content".to_owned(), Value::Array(message_parts));
    arguments.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    Ok(Value::Object(arguments))
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
            format!("doubao-seedance-2-0-fast-260128 references[{index}] must be an object."),
        )
    })?;
    if let Some(unknown) = reference
        .keys()
        .find(|key| !matches!(key.as_str(), "source" | "media_type"))
    {
        return Err(ModelRequestError::new(
            "model_request_argument_invalid",
            format!(
                "doubao-seedance-2-0-fast-260128 references[{index}] contains unknown field {unknown}."
            ),
        ));
    }
    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_request_argument_invalid",
                format!(
                    "doubao-seedance-2-0-fast-260128 references[{index}].source must be a string for request mapping."
                ),
            )
        })?;
    let media_type = match reference.get("media_type") {
        Some(Value::String(media_type)) if !media_type.is_empty() => media_type.clone(),
        Some(_) => {
            return Err(ModelRequestError::new(
                "model_request_argument_invalid",
                format!(
                    "doubao-seedance-2-0-fast-260128 references[{index}].media_type must be a non-empty string."
                ),
            ));
        }
        None => infer_media_type(source).map(str::to_owned).ok_or_else(|| {
            ModelRequestError::new(
                "video_reference_type_unsupported",
                format!(
                    "doubao-seedance-2-0-fast-260128 cannot infer reference type for {source}."
                ),
            )
        })?,
    };
    if !matches!(media_type.as_str(), "image" | "video" | "audio" | "mask") {
        return Err(ModelRequestError::new(
            "video_reference_type_unsupported",
            format!("doubao-seedance-2-0-fast-260128 does not map reference type {media_type}."),
        ));
    }
    let url = if source.starts_with("asset://") {
        source.to_owned()
    } else if media_type == "video"
        && !source.starts_with("data:")
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
        "image" | "mask" => CanvasMediaKind::Image,
        "video" => CanvasMediaKind::Video,
        "audio" => CanvasMediaKind::Audio,
        _ => CanvasMediaKind::Unknown,
    };
    if actual == expected && actual != CanvasMediaKind::Unknown {
        Ok(())
    } else {
        Err(ModelRequestError::new(
            "model_request_argument_invalid",
            format!(
                "doubao-seedance-2-0-fast-260128 reference {media_type} does not match its data URL."
            ),
        ))
    }
}

fn validate_intent(intent: &str, references: &[VideoReference]) -> Result<(), ModelRequestError> {
    let valid = match intent {
        "generate" => references.iter().all(|item| item.media_type == "image"),
        "reference" | "audio_driven" => references
            .iter()
            .all(|item| matches!(item.media_type.as_str(), "image" | "video" | "audio")),
        "extend" => references.iter().all(|item| item.media_type == "video"),
        "edit" => true,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ModelRequestError::new(
            "model_request_argument_invalid",
            format!(
                "doubao-seedance-2-0-fast-260128 cannot map the supplied reference types for intent {intent}."
            ),
        ))
    }
}

fn reference_role(intent: &str, media_type: &str, index: usize) -> &'static str {
    match intent {
        "generate" if index == 0 => "first_frame",
        "generate" => "last_frame",
        "reference" if media_type == "image" => "reference_image",
        "reference" if media_type == "video" => "reference_video",
        "reference" => "reference_audio",
        "audio_driven" if media_type == "audio" => "driver_audio",
        "audio_driven" if media_type == "image" => "reference_image",
        "audio_driven" => "reference_video",
        "extend" => "segment",
        "edit" if media_type == "mask" => "mask",
        "edit" if media_type == "video" => "source_video",
        "edit" if media_type == "audio" => "reference_audio",
        _ => "reference_image",
    }
}

fn infer_media_type(source: &str) -> Option<&'static str> {
    let lower = source
        .split_once('?')
        .map_or(source, |(path, _)| path)
        .to_ascii_lowercase();
    if lower.starts_with("data:image/")
        || [".png", ".jpg", ".jpeg", ".webp"]
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        Some("image")
    } else if lower.starts_with("data:audio/")
        || [".mp3", ".wav", ".ogg", ".flac", ".aac"]
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        Some("audio")
    } else if lower.starts_with("data:video/")
        || std::path::Path::new(&lower)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
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
                "doubao-seedance-2-0-fast-260128 response omitted id.",
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
                "doubao-seedance-2-0-fast-260128 succeeded without content.video_url.",
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
                "doubao-seedance-2-0-fast-260128 failed without error.",
            )
        })?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "doubao-seedance-2-0-fast-260128 failed without error.code.",
            )
        })?;
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "doubao-seedance-2-0-fast-260128 failed without error.message.",
            )
        })?;
    Ok((code, message))
}

fn authorization(api_key: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("authorization".to_owned(), format!("Bearer {api_key}"))])
}
