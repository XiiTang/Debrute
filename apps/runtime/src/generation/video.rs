use std::time::Duration;

use serde_json::{Value, json};

use crate::project::{
    CanvasMediaKind, GeneratedArtifactRole, project_media_kind_from_content_type,
};

use super::{
    common::{
        ExecutionContext, authorization, decode_data_url, execute_result, extension_for_mime,
        join_url, mime_from_path_or_bytes, mime_from_response, strip_output_arguments,
    },
    types::{GeneratedPayload, GenerationError, HttpBody, HttpMethod, ModelExecution},
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[allow(
    clippy::too_many_lines,
    reason = "the exact Seedance submit-poll-download flow is intentionally linear and no-retry"
)]
pub(crate) fn execute(
    mut context: ExecutionContext<'_>,
) -> Result<ModelExecution, GenerationError> {
    if !matches!(
        context.model.model_id.as_str(),
        "doubao-seedance-2-0-260128" | "doubao-seedance-2-0-fast-260128"
    ) {
        return Err(GenerationError::new(
            "video_model_unavailable",
            format!(
                "Video model adapter is unavailable: {}",
                context.model.model_id
            ),
        ));
    }
    let body = seedance_body(&context)?;
    let submit_url = join_url(&context.model.base_url, "contents/generations/tasks")?;
    let submit = context.json(
        HttpMethod::Post,
        submit_url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(body.clone()),
    )?;
    let task_id = submit
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "model_response_invalid",
                "Seedance response omitted a task id.",
            )
        })?
        .to_owned();
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
        let status = poll
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        match status.as_str() {
            "succeeded" => {
                let video_url = poll
                    .pointer("/content/video_url")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        GenerationError::new(
                            "model_response_invalid",
                            "Seedance completed without content.video_url.",
                        )
                    })?;
                let mut payloads = vec![download_video_artifact(
                    &mut context,
                    video_url,
                    GeneratedArtifactRole::PrimaryVideo,
                )?];
                if context
                    .arguments
                    .get("return_last_frame")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && let Some(last_frame_url) = poll
                        .pointer("/content/last_frame_url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                {
                    payloads.push(download_video_artifact(
                        &mut context,
                        last_frame_url,
                        GeneratedArtifactRole::LastFrame,
                    )?);
                }
                let safe_request = json!({
                    "method": "POST",
                    "url": submit_url,
                    "headers": authorization(&context.model.api_key),
                    "body": body,
                });
                return execute_result(payloads, safe_request, context);
            }
            "failed" | "expired" | "canceled" | "cancelled" => {
                return Err(GenerationError::new(
                    "generation_task_failed",
                    format!("Seedance video task ended with status {status}."),
                ));
            }
            "queued" | "pending" | "running" | "in_progress" => {
                context.sleep(POLL_INTERVAL)?;
            }
            _ => {
                return Err(GenerationError::new(
                    "model_response_invalid",
                    format!("Seedance returned unknown task status: {status}"),
                ));
            }
        }
    }
}

fn seedance_body(context: &ExecutionContext<'_>) -> Result<Value, GenerationError> {
    let mut args = strip_output_arguments(context.arguments);
    let prompt = args
        .remove("prompt")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                "Video arguments.prompt must be a non-empty string.",
            )
        })?;
    let intent = args
        .remove("intent")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "generate".to_owned());
    let references = args
        .remove("references")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let normalized = references
        .iter()
        .enumerate()
        .map(|(index, reference)| normalize_reference(context, reference, index))
        .collect::<Result<Vec<_>, _>>()?;
    validate_intent(&intent, &normalized)?;
    let mut request_content = vec![json!({"type": "text", "text": prompt})];
    for (index, reference) in normalized.iter().enumerate() {
        let role = reference_role(&intent, reference.media_type.as_str(), index);
        request_content.push(match reference.media_type.as_str() {
            "image" | "mask" => {
                json!({"type": "image_url", "image_url": {"url": reference.url}, "role": role})
            }
            "audio" => {
                json!({"type": "audio_url", "audio_url": {"url": reference.url}, "role": role})
            }
            "video" => {
                json!({"type": "video_url", "video_url": {"url": reference.url}, "role": role})
            }
            _ => unreachable!("validated media type"),
        });
    }
    args.insert("content".to_owned(), Value::Array(request_content));
    args.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    Ok(Value::Object(args))
}

struct VideoReference {
    media_type: String,
    url: String,
}

fn normalize_reference(
    context: &ExecutionContext<'_>,
    reference: &Value,
    index: usize,
) -> Result<VideoReference, GenerationError> {
    let reference = reference.as_object().ok_or_else(|| {
        GenerationError::new(
            "generation_argument_invalid",
            format!("Video references[{index}] must be an object."),
        )
    })?;
    let source = reference
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            GenerationError::new(
                "generation_argument_invalid",
                format!("Video references[{index}].source must be non-empty."),
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
                format!("Video reference type cannot be inferred: {source}"),
            )
        })?;
    if !matches!(media_type.as_str(), "image" | "video" | "audio" | "mask") {
        return Err(GenerationError::new(
            "video_reference_type_unsupported",
            format!("Video reference type is unsupported: {media_type}"),
        ));
    }
    let url = if source.starts_with("asset://") {
        source.to_owned()
    } else if source.starts_with("http://") || source.starts_with("https://") {
        context.resolve_media_reference(source)?
    } else if media_type == "video" && !source.starts_with("data:") {
        return Err(GenerationError::new(
            "video_reference_upload_unavailable",
            format!(
                "Project-local video reference requires a model-reachable URL or asset reference: {source}"
            ),
        ));
    } else {
        context.resolve_media_reference(source)?
    };
    validate_data_reference_kind(&url, &media_type)?;
    Ok(VideoReference { media_type, url })
}

fn validate_data_reference_kind(url: &str, media_type: &str) -> Result<(), GenerationError> {
    if !url.starts_with("data:") {
        return Ok(());
    }
    let (mime, _) = decode_data_url(url, 64 * 1024 * 1024)?;
    let actual = project_media_kind_from_content_type(&mime);
    let expected = match media_type {
        "image" | "mask" => CanvasMediaKind::Image,
        "video" => CanvasMediaKind::Video,
        "audio" => CanvasMediaKind::Audio,
        _ => CanvasMediaKind::Unknown,
    };
    if actual != expected || actual == CanvasMediaKind::Unknown {
        return Err(GenerationError::new(
            "generation_argument_invalid",
            format!("Video reference {media_type} does not match its data URL media type."),
        ));
    }
    Ok(())
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
            format!("Video references are invalid for intent {intent}."),
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

fn download_video_artifact(
    context: &mut ExecutionContext<'_>,
    url: &str,
    role: GeneratedArtifactRole,
) -> Result<GeneratedPayload, GenerationError> {
    let response = context.download(url)?;
    let mime = mime_from_response(&response)
        .or_else(|| mime_from_path_or_bytes(url, &response.body).map(str::to_owned))
        .ok_or_else(|| {
            GenerationError::new(
                "generated_artifact_type_unsupported",
                "Generated video artifact omitted a supported MIME type.",
            )
        })?;
    let valid = match role {
        GeneratedArtifactRole::PrimaryVideo => mime == "video/mp4",
        GeneratedArtifactRole::LastFrame => mime.starts_with("image/"),
        _ => false,
    };
    if !valid {
        return Err(GenerationError::new(
            "generated_artifact_type_unsupported",
            format!("Generated video artifact has unsupported MIME type: {mime}"),
        ));
    }
    Ok(GeneratedPayload {
        bytes: response.body,
        mime_type: mime.clone(),
        role,
        suggested_extension: extension_for_mime(&mime)?,
        model_output: json!({"url": url}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_validation_is_explicit() {
        assert!(validate_intent("generate", &[]).is_ok());
        assert!(validate_intent("extend", &[]).is_err());
        assert_eq!(infer_media_type("frame.png"), Some("image"));
        assert_eq!(infer_media_type("clip.mp4"), Some("video"));
    }
}
