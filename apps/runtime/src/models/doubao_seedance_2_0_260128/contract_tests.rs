use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "doubao-seedance-2-0-260128",
        Map::from_iter([("prompt".to_owned(), json!("make a video"))]),
        json!({"prompt": "make a video", "intent": "generate", "watermark": false}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("slow pan")),
        ("intent".to_owned(), json!("generate")),
    ]);
    let sentinel_key = "future_contract_sentinel_doubao_seedance_2_0_260128";
    let sentinel_value = "future-contract-sentinel::doubao-seedance-2-0-260128";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Video,
        "doubao-seedance-2-0-260128",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-doubao_seedance_2_0_260128-invalid-request",
                "message": "doubao_seedance_2_0_260128 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-doubao_seedance_2_0_260128-invalid-request",
            "doubao_seedance_2_0_260128 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-260128",
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
fn video_data_references_must_match_their_declared_media_type() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("animate")),
        ("intent".to_owned(), json!("generate")),
        (
            "references".to_owned(),
            json!([{
                "source": "data:audio/mpeg;base64,AQID",
                "media_type": "image"
            }]),
        ),
    ]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-260128",
        &arguments,
        Vec::new(),
    );
    assert_eq!(result.unwrap_err().code(), "model_request_argument_invalid");
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
}

#[test]
fn unknown_reference_children_are_rejected_before_request_mapping() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("animate")),
        ("intent".to_owned(), json!("generate")),
        (
            "references".to_owned(),
            json!([{
                "source": "data:image/png;base64,iVBORw0KGgo=",
                "media_type": "image",
                "future_reference_field": "must-not-be-discarded"
            }]),
        ),
    ]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-260128",
        &arguments,
        Vec::new(),
    );
    let error = result.expect_err("unknown reference child must be rejected");

    assert_eq!(error.code(), "model_request_argument_invalid");
    assert!(error.message().contains("references[0]"));
    assert!(error.message().contains("future_reference_field"));
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
}

#[test]
fn explicit_non_string_media_type_is_rejected_before_request_mapping() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("animate")),
        ("intent".to_owned(), json!("generate")),
        (
            "references".to_owned(),
            json!([{
                "source": "data:image/png;base64,iVBORw0KGgo=",
                "media_type": 7
            }]),
        ),
    ]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Video,
        "doubao-seedance-2-0-260128",
        &arguments,
        Vec::new(),
    );

    assert_eq!(
        result
            .expect_err("non-string media_type must be rejected")
            .code(),
        "model_request_argument_invalid"
    );
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
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
        "doubao-seedance-2-0-260128",
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
