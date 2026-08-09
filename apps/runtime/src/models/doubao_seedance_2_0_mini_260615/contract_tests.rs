use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "doubao-seedance-2-0-mini-260615",
        Map::from_iter([("prompt".to_owned(), json!("make a video"))]),
        json!({"prompt": "make a video", "intent": "generate", "watermark": false}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("mini pan")),
        ("intent".to_owned(), json!("generate")),
    ]);
    let sentinel_key = "future_contract_sentinel_doubao_seedance_2_0_mini_260615";
    let sentinel_value = "future-contract-sentinel::doubao-seedance-2-0-mini-260615";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Video,
        "doubao-seedance-2-0-mini-260615",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-doubao_seedance_2_0_mini_260615-invalid-request",
                "message": "doubao_seedance_2_0_mini_260615 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-doubao_seedance_2_0_mini_260615-invalid-request",
            "doubao_seedance_2_0_mini_260615 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-mini-260615",
        &arguments,
        vec![
            fixture_json(&json!({"id": "task"})),
            fixture_json(
                &json!({"status": "succeeded", "content": {"video_url": "https://media.example/out.mp4"}}),
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
        "https://model.example/v1/contents/generations/tasks",
        "authorization",
        "Bearer live-secret",
    );
    assert_model_endpoint_request(
        &requests[1],
        HttpMethod::Get,
        "https://model.example/v1/contents/generations/tasks/task",
        "authorization",
        "Bearer live-secret",
    );
    assert_public_download_request(&requests[2], "https://media.example/out.mp4");
}

#[test]
fn seedance_mini_owns_current_roles_passthrough_and_optional_last_frame() {
    let (generate, generate_requests) = run_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-mini-260615",
        &Map::from_iter([
            ("prompt".to_owned(), json!("animate both keyframes")),
            ("intent".to_owned(), json!("generate")),
            (
                "references".to_owned(),
                json!([
                    {
                        "source": "data:image/png;base64,iVBORw0KGgo=",
                        "media_type": "image"
                    },
                    {
                        "source": "data:image/jpeg;base64,/9j/",
                        "media_type": "image"
                    }
                ]),
            ),
            ("tools".to_owned(), json!([{"type": "web_search"}])),
            ("return_last_frame".to_owned(), json!(true)),
            ("resolution".to_owned(), json!("720p")),
            ("watermark".to_owned(), json!(false)),
            ("future_parameter".to_owned(), json!("remote owns this")),
        ]),
        vec![
            fixture_json(&json!({"id": "mini-generate-task"})),
            fixture_json(&json!({
                "status": "succeeded",
                "content": {
                    "video_url": "https://media.example/mini.mp4",
                    "last_frame_url": "https://media.example/mini-last.png"
                }
            })),
            fixture_media("video/mp4", b"mini-video"),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
        ],
    );
    assert_eq!(generate.payloads.len(), 2);
    assert_eq!(generate_requests[0].method, HttpMethod::Post);
    assert_eq!(
        generate_requests[0].url,
        "https://model.example/v1/contents/generations/tasks"
    );
    assert_eq!(generate_requests[1].method, HttpMethod::Get);
    assert_eq!(
        generate_requests[1].url,
        "https://model.example/v1/contents/generations/tasks/mini-generate-task"
    );
    assert_eq!(generate.payloads[0].mime_type, "video/mp4");
    assert!(generate.payloads[1].mime_type.starts_with("image/"));
    let HttpBody::Json(generate_body) = &generate_requests[0].body else {
        panic!("Seedance Mini request must be JSON");
    };
    assert_eq!(
        generate_body.get("model"),
        Some(&json!("doubao-seedance-2-0-mini-260615"))
    );
    assert_eq!(
        generate_body.pointer("/content/1/role"),
        Some(&json!("first_frame"))
    );
    assert_eq!(
        generate_body.pointer("/content/2/role"),
        Some(&json!("last_frame"))
    );
    assert_eq!(
        generate_body.get("tools"),
        Some(&json!([{"type": "web_search"}]))
    );
    assert_eq!(
        generate_body.get("future_parameter"),
        Some(&json!("remote owns this"))
    );
    assert!(generate_body.get("intent").is_none());
    assert!(generate_body.get("references").is_none());
}

#[test]
fn seedance_mini_accepts_inline_audio_and_model_reachable_video() {
    let (_, audio_requests) = run_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-mini-260615",
        &Map::from_iter([
            ("prompt".to_owned(), json!("follow the supplied narration")),
            ("intent".to_owned(), json!("audio_driven")),
            (
                "references".to_owned(),
                json!([
                    {
                        "source": "data:audio/mpeg;base64,AQID",
                        "media_type": "audio"
                    },
                    {
                        "source": "asset://source-video",
                        "media_type": "video"
                    }
                ]),
            ),
        ]),
        vec![
            fixture_json(&json!({"id": "mini-audio-task"})),
            fixture_json(&json!({
                "status": "succeeded",
                "content": {"video_url": "https://media.example/audio-driven.mp4"}
            })),
            fixture_media("video/mp4", b"audio-driven-video"),
        ],
    );
    let HttpBody::Json(audio_body) = &audio_requests[0].body else {
        panic!("Seedance Mini audio-driven request must be JSON");
    };
    assert_eq!(
        audio_body.pointer("/content/1/role"),
        Some(&json!("reference_audio"))
    );
    assert_eq!(
        audio_body.pointer("/content/2/role"),
        Some(&json!("reference_video"))
    );
}

#[test]
fn seedance_mini_submits_web_search_with_references_and_preserves_remote_failure() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("")),
        ("intent".to_owned(), json!("generate")),
        (
            "references".to_owned(),
            json!([{
                "source": "",
                "media_type": "audio"
            }]),
        ),
        ("tools".to_owned(), json!([{"type": "web_search"}])),
    ]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-mini-260615",
        &arguments,
        vec![
            fixture_json(&json!({"id": "mini-rejected-task"})),
            fixture_json(&json!({
                "status": "failed",
                "error": {
                    "code": "InvalidParameter",
                    "message": "web_search requires a pure-text request"
                }
            })),
        ],
    );

    assert_eq!(remaining, 0);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].method, HttpMethod::Post);
    assert_eq!(
        requests[0].url,
        "https://model.example/v1/contents/generations/tasks"
    );
    assert_eq!(requests[1].method, HttpMethod::Get);
    assert_eq!(
        requests[1].url,
        "https://model.example/v1/contents/generations/tasks/mini-rejected-task"
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Seedance Mini rejected request must be JSON");
    };
    assert_eq!(body.get("tools"), Some(&json!([{"type": "web_search"}])));
    assert_eq!(body.pointer("/content/0/text"), Some(&json!("")));
    assert_eq!(body.pointer("/content/1/audio_url/url"), Some(&json!("")));
    assert_eq!(
        body.pointer("/content/1/role"),
        Some(&json!("reference_audio"))
    );
    let error = result.expect_err("remote Mini rejection must remain an error");
    assert_eq!(error.code(), "model_request_task_failed");
    assert!(error.message().contains("InvalidParameter"));
    assert!(
        error
            .message()
            .contains("web_search requires a pure-text request")
    );
}

#[test]
fn seedance_mini_rejects_unreachable_local_video_and_unknown_reference_children() {
    for (arguments, expected_code) in [
        (
            Map::from_iter([
                ("prompt".to_owned(), json!("extend this clip")),
                ("intent".to_owned(), json!("extend")),
                (
                    "references".to_owned(),
                    json!([{"source": "local/source.mp4", "media_type": "video"}]),
                ),
            ]),
            "video_reference_upload_unavailable",
        ),
        (
            Map::from_iter([
                ("prompt".to_owned(), json!("animate this image")),
                ("intent".to_owned(), json!("generate")),
                (
                    "references".to_owned(),
                    json!([{
                        "source": "data:image/png;base64,iVBORw0KGgo=",
                        "media_type": "image",
                        "label": "unsupported child"
                    }]),
                ),
            ]),
            "model_request_argument_invalid",
        ),
        (
            Map::from_iter([
                ("prompt".to_owned(), json!("animate")),
                ("intent".to_owned(), json!("unknown-intent")),
            ]),
            "model_request_argument_invalid",
        ),
    ] {
        let (result, requests, remaining) = execute_fixture(
            ModelKind::Video,
            "doubao-seedance-2-0-mini-260615",
            &arguments,
            Vec::new(),
        );
        assert_eq!(result.unwrap_err().code(), expected_code);
        assert!(requests.is_empty());
        assert_eq!(remaining, 0);
    }
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
        "doubao-seedance-2-0-mini-260615",
        &Map::from_iter([("intent".to_owned(), json!("generate"))]),
        vec![
            fixture_json(&json!({"id": "owned-cancel-task"})),
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
            .ends_with("/contents/generations/tasks/owned-cancel-task")
    );
}
