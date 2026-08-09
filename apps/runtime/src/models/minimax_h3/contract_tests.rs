use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([(
        "content".to_owned(),
        json!([{"type": "text", "text": "coast"}]),
    )]);
    let sentinel_key = "future_contract_sentinel_minimax_h3";
    let sentinel_value = "future-contract-sentinel::minimax-h3";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Video,
        "minimax-h3",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-minimax_h3-invalid-request",
                "message": "minimax_h3 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-minimax_h3-invalid-request",
            "minimax_h3 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Video,
        "minimax-h3",
        &arguments,
        vec![
            fixture_json(&json!({"task_id": "task"})),
            fixture_json(
                &json!({"task": {"status": "succeeded", "content": {"url": "https://media.example/out.mp4"}}}),
            ),
            fixture_media("video/mp4", b"video"),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"video");
    assert_eq!(requests.len(), 3);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/v2/video_generation",
        "authorization",
        "Bearer live-secret",
    );
    assert_model_endpoint_request(
        &requests[1],
        HttpMethod::Get,
        "https://model.example/v1/v2/query/video_generation/task",
        "authorization",
        "Bearer live-secret",
    );
    assert_public_download_request(&requests[2], "https://media.example/out.mp4");
}

#[test]
fn minimax_h3_uses_the_native_v2_contract_and_one_video_artifact() {
    let (execution, requests) = run_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::from_iter([
            (
                "content".to_owned(),
                json!([{
                    "type": "text",
                    "text": "A quiet coastal basketball scene",
                    "future_child": true
                }]),
            ),
            ("resolution".to_owned(), json!("2K")),
            ("duration".to_owned(), json!(5)),
            ("ratio".to_owned(), json!("16:9")),
            (
                "callback_url".to_owned(),
                json!("https://callback.example/h3"),
            ),
            ("aigc_watermark".to_owned(), json!(true)),
        ]),
        vec![
            fixture_json(&json!({"task_id": "h3/task?segment"})),
            fixture_json(&json!({
                "request_id": "h3-query-request",
                "task": {
                    "id": "h3/task?segment",
                    "status": "succeeded",
                    "content": {"url": "https://media.example/h3.mp4"}
                }
            })),
            fixture_media("video/mp4", b"h3-video"),
        ],
    );

    assert_eq!(execution.payloads.len(), 1);
    assert_eq!(execution.payloads[0].mime_type, "video/mp4");
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].method, HttpMethod::Post);
    assert_eq!(
        requests[0].url,
        "https://model.example/v1/v2/video_generation"
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("MiniMax H3 create request must be JSON");
    };
    assert_eq!(body.get("model"), Some(&json!("MiniMax-H3")));
    assert_eq!(body.get("aigc_watermark"), Some(&json!(true)));
    assert_eq!(body.pointer("/content/0/future_child"), Some(&json!(true)));
    assert_eq!(
        requests[1].url,
        "https://model.example/v1/v2/query/video_generation/h3%2Ftask%3Fsegment"
    );
    assert_eq!(requests[2].url, "https://media.example/h3.mp4");
}

#[test]
fn minimax_h3_transforms_local_media_and_preserves_native_references() {
    let invocation_cwd = std::env::temp_dir().join(format!(
        "debrute-minimax-h3-project-media-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&invocation_cwd).unwrap();
    std::fs::write(
        invocation_cwd.join("reference.png"),
        b"\x89PNG\r\n\x1a\nlocal-image",
    )
    .unwrap();

    let (execution, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
        ModelKind::Video,
        "minimax-h3",
        &Map::from_iter([(
            "content".to_owned(),
            json!([
                {"type": "image_url", "image_url": {"url": "reference.png"}},
                {"type": "video_url", "video_url": {"url": "https://media.example/input.mp4"}},
                {"type": "audio_url", "audio_url": {"url": "data:audio/mpeg;base64,AQID"}},
                {"type": "image_url", "image_url": {"url": "mm_file://official-reference"}}
            ]),
        )]),
        vec![
            fixture_json(&json!({"task_id": "h3-project-task"})),
            fixture_json(&json!({
                "task": {
                    "status": "succeeded",
                    "content": {"url": "https://media.example/h3-project.mp4"}
                }
            })),
            fixture_media("video/mp4", b"h3-project-video"),
        ],
        &invocation_cwd,
        ModelRequestResourceLimits::default(),
    );

    std::fs::remove_dir_all(&invocation_cwd).unwrap();
    assert!(execution.is_ok());
    assert_eq!(remaining, 0);
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("MiniMax H3 local media request must be JSON");
    };
    assert!(
        body.pointer("/content/0/image_url/url")
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with("data:image/png;base64,"))
    );
    assert_eq!(
        body.pointer("/content/1/video_url/url"),
        Some(&json!("https://media.example/input.mp4"))
    );
    assert_eq!(
        body.pointer("/content/2/audio_url/url"),
        Some(&json!("data:audio/mpeg;base64,AQID"))
    );
    assert_eq!(
        body.pointer("/content/3/image_url/url"),
        Some(&json!("mm_file://official-reference"))
    );
}

#[test]
fn minimax_h3_treats_every_other_media_string_as_a_local_path() {
    let invocation_cwd = std::env::temp_dir().join(format!(
        "debrute-minimax-h3-local-path-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&invocation_cwd).unwrap();

    let (execution, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
        ModelKind::Video,
        "minimax-h3",
        &Map::from_iter([(
            "content".to_owned(),
            json!([{
                "type": "video_url",
                "video_url": {"url": "provider-owned-reference"}
            }]),
        )]),
        Vec::new(),
        &invocation_cwd,
        ModelRequestResourceLimits::default(),
    );

    std::fs::remove_dir_all(&invocation_cwd).unwrap();
    assert_eq!(execution.unwrap_err().code(), "model_request_input_invalid");
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
}

#[test]
fn minimax_h3_uses_an_explicit_china_base_url_without_changing_its_contract() {
    let arguments = Map::from_iter([
        ("content".to_owned(), Value::Null),
        ("resolution".to_owned(), json!(42)),
        ("duration".to_owned(), json!("provider-decides")),
        ("ratio".to_owned(), json!(["invalid-shape"])),
        ("callback_url".to_owned(), json!(false)),
        ("aigc_watermark".to_owned(), json!(true)),
    ]);
    let (execution, requests, remaining) =
        execute_fixture_at_base_url_with_invocation_cwd_and_limits(
            ModelKind::Video,
            "minimax-h3",
            &arguments,
            vec![
                fixture_json(&json!({"task_id": "china-task"})),
                fixture_json(&json!({
                    "task": {
                        "status": "succeeded",
                        "content": {"url": "https://media.example/china-h3.mp4"}
                    }
                })),
                fixture_media("video/mp4", b"china-h3-video"),
            ],
            std::path::Path::new("."),
            ModelRequestResourceLimits::default(),
            "https://api.minimaxi.com",
        );
    let execution = execution.unwrap();
    assert_eq!(remaining, 0);
    assert_eq!(execution.payloads.len(), 1);
    assert_eq!(
        requests[0].url,
        "https://api.minimaxi.com/v2/video_generation"
    );
    assert_eq!(
        requests[1].url,
        "https://api.minimaxi.com/v2/query/video_generation/china-task"
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("MiniMax H3 China request must be JSON");
    };
    assert_eq!(body.get("model"), Some(&json!("MiniMax-H3")));
    assert_eq!(body.get("content"), Some(&Value::Null));
    assert_eq!(body.get("resolution"), Some(&json!(42)));
    assert_eq!(body.get("duration"), Some(&json!("provider-decides")));
    assert_eq!(body.get("ratio"), Some(&json!(["invalid-shape"])));
    assert_eq!(body.get("callback_url"), Some(&json!(false)));
    assert_eq!(body.get("aigc_watermark"), Some(&json!(true)));
}

#[test]
fn minimax_h3_preserves_remote_task_failure_details_and_rejects_unknown_states() {
    let (failed, failed_requests, failed_remaining) = execute_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::new(),
        vec![
            fixture_json(&json!({"task_id": "failed-task"})),
            fixture_json(&json!({
                "request_id": "request-42",
                "task": {
                    "status": "failed",
                    "error": {"code": "1026", "message": "sensitive content"}
                }
            })),
        ],
    );
    let failed = failed.unwrap_err();
    assert_eq!(failed.code(), "model_request_task_failed");
    assert!(failed.message().contains("1026"));
    assert!(failed.message().contains("sensitive content"));
    assert!(failed.message().contains("request-42"));
    assert_eq!(failed_requests.len(), 2);
    assert_eq!(failed_remaining, 0);

    for (poll, expected_code) in [
        (
            json!({"task": {"status": "cancelled"}}),
            "model_request_task_failed",
        ),
        (
            json!({"task": {"status": "future-state"}}),
            "model_response_invalid",
        ),
        (
            json!({"task": {"status": "succeeded"}}),
            "model_response_invalid",
        ),
        (json!({"task": {}}), "model_response_invalid"),
    ] {
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "minimax-h3",
            &Map::new(),
            vec![
                fixture_json(&json!({"task_id": "terminal-task"})),
                fixture_json(&poll),
            ],
        );
        assert_eq!(result.unwrap_err().code(), expected_code);
        assert_eq!(requests.len(), 2);
        assert_eq!(remaining, 0);
    }

    let (missing_id, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::new(),
        vec![fixture_json(&json!({}))],
    );
    assert_eq!(missing_id.unwrap_err().code(), "model_response_invalid");
    assert_eq!(requests.len(), 1);
    assert_eq!(remaining, 0);

    let (collision, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::from_iter([("model".to_owned(), json!("caller-model"))]),
        Vec::new(),
    );
    assert_eq!(
        collision.unwrap_err().code(),
        "model_request_argument_collision"
    );
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
}

#[test]
fn minimax_h3_preserves_query_and_download_transport_failures() {
    let (query, query_requests, query_remaining) = execute_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::new(),
        vec![
            fixture_json(&json!({"task_id": "query-error-task"})),
            fixture_remote_json_error(
                503,
                &json!({
                    "code": "fixture-minimax-h3-query-failed",
                    "message": "minimax-h3 fixture query failed"
                }),
            ),
        ],
    );
    assert!(query.is_err());
    assert_eq!(query_requests.len(), 2);
    assert_eq!(query_remaining, 0);

    let (download, download_requests, download_remaining) = execute_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::new(),
        vec![
            fixture_json(&json!({"task_id": "download-error-task"})),
            fixture_json(&json!({
                "task": {
                    "status": "succeeded",
                    "content": {"url": "https://media.example/download-error.mp4"}
                }
            })),
            fixture_remote_json_error(
                503,
                &json!({
                    "code": "fixture-minimax-h3-download-failed",
                    "message": "minimax-h3 fixture download failed"
                }),
            ),
        ],
    );
    assert!(download.is_err());
    assert_eq!(download_requests.len(), 3);
    assert_eq!(download_remaining, 0);
}

#[test]
fn owns_remote_cancellation_contract() {
    let cleanup_response = ModelHttpResponse {
        status: 503,
        headers: std::collections::BTreeMap::new(),
        body: b"remote cleanup failed".to_vec(),
    };
    let (result, requests, remaining) = execute_cancelling_fixture(
        ModelKind::Video,
        "minimax-h3",
        &Map::from_iter([("content".to_owned(), json!([]))]),
        vec![
            fixture_json(&json!({"task_id": "owned-cancel-task"})),
            cleanup_response,
        ],
        2,
    );

    assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
    assert_eq!(remaining, 0);
    assert_eq!(
        requests
            .iter()
            .map(|request| request.method)
            .collect::<Vec<_>>(),
        vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Delete],
    );
    assert!(
        requests[2]
            .url
            .ends_with("/v2/video_generation/owned-cancel-task")
    );
}
