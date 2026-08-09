use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "wan2.7-image",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({"prompt": "make an image", "watermark": false}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("concept"))]);
    let sentinel_key = "future_contract_sentinel_wan2_7_image";
    let sentinel_value = "future-contract-sentinel::wan2.7-image";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "wan2.7-image",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-wan2_7_image-invalid-request",
                "message": "wan2_7_image exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-wan2_7_image-invalid-request",
            "wan2_7_image exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "wan2.7-image",
        &arguments,
        vec![
            fixture_json(
                &json!({"output": {"choices": [{"message": {"content": [{"image": "https://media.example/wan.png"}]}}]}}),
            ),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].mime_type, "image/png");
    assert_eq!(requests.len(), 2);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/services/aigc/multimodal-generation/generation",
        "authorization",
        "Bearer live-secret",
    );
    assert_public_download_request(&requests[1], "https://media.example/wan.png");
}

#[test]
fn wan_2_7_uses_one_synchronous_model_request() {
    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "wan2.7-image",
        &Map::from_iter([
            ("prompt".to_owned(), json!("same cat in two seasons")),
            ("image".to_owned(), json!([])),
            ("watermark".to_owned(), json!(false)),
            ("future_parameter".to_owned(), json!("remote owns this")),
        ]),
        vec![
            fixture_json(&json!({
                "output": {"choices": [{"message": {"content": [
                    {"image": "https://media.example/wan-one"},
                    {"image": "https://media.example/wan-two"}
                ]}}]}
            })),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
        ],
    );
    assert_eq!(execution.payloads.len(), 2);
    assert_eq!(requests.len(), 3);
    assert!(
        requests[0]
            .url
            .ends_with("/services/aigc/multimodal-generation/generation")
    );
    assert!(!requests[0].headers.contains_key("x-dashscope-async"));
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Wan request must be JSON");
    };
    assert_eq!(
        body.pointer("/parameters/future_parameter"),
        Some(&json!("remote owns this"))
    );
}
