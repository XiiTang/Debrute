use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("motif"))]);
    let sentinel_key = "future_contract_sentinel_google_lyria_3_clip_preview";
    let sentinel_value = "future-contract-sentinel::google-lyria-3-clip-preview";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Music,
        "google-lyria-3-clip-preview",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-google_lyria_3_clip_preview-invalid-request",
                "message": "google_lyria_3_clip_preview exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-google_lyria_3_clip_preview-invalid-request",
            "google_lyria_3_clip_preview exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Music,
        "google-lyria-3-clip-preview",
        &arguments,
        vec![fixture_json(
            &json!({"steps": [{"type": "model_output", "content": [{"type": "audio", "mime_type": "audio/mpeg", "data": "SUQz"}]}]}),
        )],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"ID3");
    assert_eq!(requests.len(), 1);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/interactions",
        "x-goog-api-key",
        "live-secret",
    );
}
