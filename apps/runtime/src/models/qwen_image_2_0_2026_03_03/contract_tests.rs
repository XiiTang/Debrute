use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "qwen-image-2.0-2026-03-03",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({"prompt": "make an image", "watermark": false}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("concept"))]);
    let sentinel_key = "future_contract_sentinel_qwen_image_2_0_2026_03_03";
    let sentinel_value = "future-contract-sentinel::qwen-image-2.0-2026-03-03";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "qwen-image-2.0-2026-03-03",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-qwen_image_2_0_2026_03_03-invalid-request",
                "message": "qwen_image_2_0_2026_03_03 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-qwen_image_2_0_2026_03_03-invalid-request",
            "qwen_image_2_0_2026_03_03 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "qwen-image-2.0-2026-03-03",
        &arguments,
        vec![
            fixture_json(
                &json!({"output": {"choices": [{"message": {"content": [{"image": "https://media.example/qwen.png"}]}}]}}),
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
    assert_public_download_request(&requests[1], "https://media.example/qwen.png");
}
