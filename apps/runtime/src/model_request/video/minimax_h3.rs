use std::time::Duration;

use serde_json::{Map, Value, json};

use super::{VideoResult, download_video};
use crate::model_request::{
    common::{ExecutionContext, authorization, join_url},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

const POLL_INTERVAL: Duration = Duration::from_secs(10);

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<VideoResult, ModelRequestError> {
    let body = request_body(context)?;
    let submit_url = join_url(&context.model.base_url, "v2/video_generation")?;
    let submit = context.json(
        HttpMethod::Post,
        submit_url.clone(),
        authorization(&context.model.api_key),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let task_id = exact_task_id(&submit)?;
    let poll_url = task_url(
        &context.model.base_url,
        "v2/query/video_generation",
        &task_id,
    )?;
    let cancel_url = task_url(&context.model.base_url, "v2/video_generation", &task_id)?;
    let mut remotely_cancellable = true;

    let result = (|| loop {
        let poll = context.json(
            HttpMethod::Get,
            poll_url.clone(),
            authorization(&context.model.api_key),
            HttpBody::Empty,
        )?;
        match poll.pointer("/task/status").and_then(Value::as_str) {
            Some("queued") => context.sleep(POLL_INTERVAL)?,
            Some("running") => {
                remotely_cancellable = false;
                context.sleep(POLL_INTERVAL)?;
            }
            Some("succeeded") => {
                remotely_cancellable = false;
                let video_url = exact_video_url(&poll)?;
                let payload = download_video(context, video_url)?;
                return Ok(VideoResult {
                    payloads: vec![payload],
                    safe_request: json!({
                        "method": "POST",
                        "url": submit_url,
                        "headers": {"authorization": "[REDACTED]"},
                        "body": body,
                        "taskId": task_id,
                    }),
                });
            }
            Some("failed") => return Err(task_failure(&poll)),
            Some("cancelled") => {
                return Err(ModelRequestError::new(
                    "model_request_task_failed",
                    "minimax-h3 task was cancelled by the remote endpoint.",
                ));
            }
            Some(status) => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    format!("minimax-h3 returned task status {status}."),
                ));
            }
            None => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    "minimax-h3 task response omitted task.status.",
                ));
            }
        }
    })();
    if result
        .as_ref()
        .is_err_and(|error| error.code() == "model_request_cancelled")
        && remotely_cancellable
    {
        context.best_effort_remote_cancellation(
            HttpMethod::Delete,
            cancel_url,
            authorization(&context.model.api_key),
            HttpBody::Empty,
        );
    }
    result
}

fn request_body(
    context: &mut ExecutionContext<'_>,
) -> Result<Map<String, Value>, ModelRequestError> {
    let mut body = context.arguments.clone();
    if body.contains_key("model") {
        return Err(ModelRequestError::new(
            "model_request_argument_collision",
            "minimax-h3 arguments.model conflicts with the Model Request model binding.",
        ));
    }
    resolve_project_media(context, &mut body)?;
    body.insert(
        "model".to_owned(),
        Value::String(context.model.request_model_id.clone()),
    );
    Ok(body)
}

fn resolve_project_media(
    context: &mut ExecutionContext<'_>,
    body: &mut Map<String, Value>,
) -> Result<(), ModelRequestError> {
    let Some(items) = body.get_mut("content").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for item in items {
        let Some(item) = item.as_object_mut() else {
            continue;
        };
        for field in ["image_url", "video_url", "audio_url"] {
            let Some(url) = item
                .get_mut(field)
                .and_then(Value::as_object_mut)
                .and_then(|container| container.get_mut("url"))
                .and_then(|value| value.as_str())
                .map(str::to_owned)
            else {
                continue;
            };
            if is_native_reference(&url) {
                continue;
            }
            let resolved = context.resolve_media_reference(&url)?;
            let encoded = resolved.into_reference_string(context)?;
            item.get_mut(field)
                .and_then(Value::as_object_mut)
                .expect("H3 media container was inspected as an object")
                .insert("url".to_owned(), Value::String(encoded));
        }
    }
    Ok(())
}

fn is_native_reference(value: &str) -> bool {
    value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("data:")
        || value.starts_with("mm_file://")
}

fn task_url(base_url: &str, prefix: &str, task_id: &str) -> Result<String, ModelRequestError> {
    let prefix = join_url(base_url, prefix)?;
    let mut url = url::Url::parse(&prefix).map_err(|error| {
        ModelRequestError::new("model_configuration_invalid", error.to_string())
    })?;
    url.path_segments_mut()
        .map_err(|()| {
            ModelRequestError::new(
                "model_configuration_invalid",
                "MiniMax H3 task endpoint cannot contain a task path segment.",
            )
        })?
        .push(task_id);
    Ok(url.into())
}

fn exact_task_id(response: &Value) -> Result<String, ModelRequestError> {
    response
        .get("task_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "minimax-h3 create response omitted task_id.",
            )
        })
}

fn exact_video_url(response: &Value) -> Result<&str, ModelRequestError> {
    response
        .pointer("/task/content/url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "minimax-h3 succeeded without task.content.url.",
            )
        })
}

fn task_failure(response: &Value) -> ModelRequestError {
    let code = response
        .pointer("/task/error/code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = response
        .pointer("/task/error/message")
        .and_then(Value::as_str)
        .unwrap_or("MiniMax H3 task failed without an explanatory message.");
    let request = response
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map_or_else(String::new, |value| format!("; request_id: {value}"));
    ModelRequestError::new(
        "model_request_task_failed",
        format!("minimax-h3 task failed ({code}): {message}{request}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_interval_matches_the_official_h3_guidance() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(10));
    }
}
