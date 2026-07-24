use std::time::Duration;

use serde_json::{Value, json};

use super::{VideoResult, download_video_artifact};
use crate::{
    generation::{
        common::{ExecutionContext, ResolvedMediaReference, authorization, join_url},
        types::{GenerationError, HttpBody, HttpMethod},
    },
    project::{CanvasMediaKind, GeneratedArtifactRole, project_media_kind_from_content_type},
};

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
                    format!("doubao-seedance-2-0-260128 returned task status {status}."),
                ));
            }
            None => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    "doubao-seedance-2-0-260128 task response omitted status.",
                ));
            }
        }
    }
}

fn request_body(context: &mut ExecutionContext<'_>) -> Result<Value, GenerationError> {
    let mut arguments = context.arguments.clone();
    let prompt = arguments.remove("prompt").ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            "doubao-seedance-2-0-260128 requires prompt.",
        )
    })?;
    let intent = arguments
        .remove("intent")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "generate".to_owned());
    let references = arguments
        .remove("references")
        .map(|value| {
            value.as_array().cloned().ok_or_else(|| {
                GenerationError::new(
                    "generation_argument_invalid",
                    "doubao-seedance-2-0-260128 references must be an array.",
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
    let mut message_parts = vec![json!({"type": "text", "text": prompt})];
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
) -> Result<VideoReference, GenerationError> {
    let reference = reference.as_object().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            format!("doubao-seedance-2-0-260128 references[{index}] must be an object."),
        )
    })?;
    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                format!("doubao-seedance-2-0-260128 references[{index}].source must be non-empty."),
            )
        })?;
    let media_type = reference
        .get("media_type")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| infer_media_type(source).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "video_reference_type_unsupported",
                format!("doubao-seedance-2-0-260128 cannot infer reference type for {source}."),
            )
        })?;
    if !matches!(media_type.as_str(), "image" | "video" | "audio" | "mask") {
        return Err(GenerationError::new(
            "video_reference_type_unsupported",
            format!("doubao-seedance-2-0-260128 does not map reference type {media_type}."),
        ));
    }
    let url = if source.starts_with("asset://") {
        source.to_owned()
    } else if media_type == "video"
        && !source.starts_with("data:")
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
        "image" | "mask" => CanvasMediaKind::Image,
        "video" => CanvasMediaKind::Video,
        "audio" => CanvasMediaKind::Audio,
        _ => CanvasMediaKind::Unknown,
    };
    if actual == expected && actual != CanvasMediaKind::Unknown {
        Ok(())
    } else {
        Err(GenerationError::new(
            "generation_argument_invalid",
            format!(
                "doubao-seedance-2-0-260128 reference {media_type} does not match its data URL."
            ),
        ))
    }
}

fn validate_intent(intent: &str, references: &[VideoReference]) -> Result<(), GenerationError> {
    let valid = match intent {
        "generate" => {
            references.len() <= 2 && references.iter().all(|item| item.media_type == "image")
        }
        "reference" => {
            !references.is_empty()
                && references
                    .iter()
                    .all(|item| matches!(item.media_type.as_str(), "image" | "video" | "audio"))
        }
        "audio_driven" => {
            references
                .iter()
                .filter(|item| item.media_type == "audio")
                .count()
                == 1
                && references
                    .iter()
                    .filter(|item| matches!(item.media_type.as_str(), "image" | "video"))
                    .count()
                    <= 1
                && references
                    .iter()
                    .all(|item| matches!(item.media_type.as_str(), "image" | "video" | "audio"))
        }
        "extend" => {
            !references.is_empty() && references.iter().all(|item| item.media_type == "video")
        }
        "edit" => !references.is_empty(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(GenerationError::new(
            "video_reference_count_invalid",
            format!("doubao-seedance-2-0-260128 references are invalid for intent {intent}."),
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
        .split('?')
        .next()
        .unwrap_or(source)
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

fn exact_task_id(response: &Value) -> Result<String, GenerationError> {
    response
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "doubao-seedance-2-0-260128 response omitted id.",
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
                "doubao-seedance-2-0-260128 succeeded without content.video_url.",
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
        format!("doubao-seedance-2-0-260128 task {status}: {detail}"),
    )
}
