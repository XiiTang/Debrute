use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{AudioResult, POLL_INTERVAL, assert_same_origin, audio_payload};
use crate::model_request::{
    common::{ExecutionContext, join_url, mime_from_path_or_bytes, mime_from_response},
    types::{HttpBody, HttpMethod, ModelRequestError},
};

pub(super) fn execute(
    context: &mut ExecutionContext<'_>,
) -> Result<AudioResult, ModelRequestError> {
    let body = context.arguments.clone();
    let url = join_url(&context.model.base_url, &context.model.request_model_id)?;
    let headers = BTreeMap::from([
        (
            "authorization".to_owned(),
            format!("Key {}", context.model.api_key),
        ),
        ("content-type".to_owned(), "application/json".to_owned()),
        ("x-fal-no-retry".to_owned(), "1".to_owned()),
    ]);
    let submit = context.json(
        HttpMethod::Post,
        url.clone(),
        headers.clone(),
        HttpBody::Json(Value::Object(body.clone())),
    )?;
    let request_id = exact_string(&submit, "request_id")?;
    let status_url = exact_string(&submit, "status_url")?;
    assert_same_origin(&context.model.base_url, &status_url)?;
    let cancel_url = submit
        .get("cancel_url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .filter(|value| assert_same_origin(&context.model.base_url, value).is_ok())
        .map(str::to_owned);
    let mut remotely_cancellable = cancel_url.is_some();
    let poll_result = poll_task(context, &status_url, &headers, &mut remotely_cancellable);
    let result = match poll_result {
        Ok(result) => result,
        Err(error) => {
            if error.code() == "model_request_cancelled"
                && remotely_cancellable
                && let Some(cancel_url) = cancel_url
            {
                context.best_effort_remote_cancellation(
                    HttpMethod::Put,
                    cancel_url,
                    headers.clone(),
                    HttpBody::Empty,
                );
            }
            return Err(error);
        }
    };
    let audio_url = result
        .pointer("/audio/url")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                "fal Stable Audio 2.5 result omitted audio.url.",
            )
        })?;
    let audio = context.download_model_output_media(audio_url)?;
    let mime = mime_from_response(&audio)
        .filter(|mime| mime.starts_with("audio/"))
        .or_else(|| mime_from_path_or_bytes(audio_url, &audio.body).map(str::to_owned))
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_artifact_type_unsupported",
                "fal Stable Audio 2.5 output audio type could not be identified.",
            )
        })?;
    Ok(AudioResult {
        payloads: vec![audio_payload(audio.body, &mime, context)?],
        safe_request: json!({
            "method": "POST",
            "url": url,
            "headers": {
                "authorization": "[REDACTED]",
                "content-type": "application/json",
                "x-fal-no-retry": "1"
            },
            "body": body,
            "requestId": request_id,
        }),
    })
}

fn poll_task(
    context: &mut ExecutionContext<'_>,
    status_url: &str,
    headers: &BTreeMap<String, String>,
    remotely_cancellable: &mut bool,
) -> Result<Value, ModelRequestError> {
    loop {
        let status = context.json(
            HttpMethod::Get,
            status_url.to_owned(),
            headers.clone(),
            HttpBody::Empty,
        )?;
        match status.get("status").and_then(Value::as_str) {
            Some("IN_QUEUE" | "IN_PROGRESS") => context.sleep(POLL_INTERVAL)?,
            Some("COMPLETED") => {
                *remotely_cancellable = false;
                if let Some(error) = status
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    return Err(ModelRequestError::new(
                        "model_request_task_failed",
                        format!("fal Stable Audio 2.5 task failed: {error}"),
                    ));
                }
                let response_url = exact_string(&status, "response_url")?;
                assert_same_origin(&context.model.base_url, &response_url)?;
                return context.json(
                    HttpMethod::Get,
                    response_url,
                    headers.clone(),
                    HttpBody::Empty,
                );
            }
            Some(status) => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    format!("fal Stable Audio 2.5 task returned status {status}."),
                ));
            }
            None => {
                return Err(ModelRequestError::new(
                    "model_response_invalid",
                    "fal Stable Audio 2.5 status omitted status.",
                ));
            }
        }
    }
}

fn exact_string(value: &Value, key: &str) -> Result<String, ModelRequestError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            ModelRequestError::new(
                "model_response_invalid",
                format!("fal Stable Audio 2.5 response omitted {key}."),
            )
        })
}
