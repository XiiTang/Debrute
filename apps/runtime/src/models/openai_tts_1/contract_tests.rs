use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        ("voice".to_owned(), json!("alloy")),
    ]);
    let sentinel_key = "future_contract_sentinel_openai_tts_1";
    let sentinel_value = "future-contract-sentinel::openai-tts-1";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "openai-tts-1",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-openai_tts_1-invalid-request",
                "message": "openai_tts_1 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-openai_tts_1-invalid-request",
            "openai_tts_1 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "openai-tts-1",
        &arguments,
        vec![fixture_media("audio/mpeg", b"audio")],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"audio");
    assert_eq!(requests.len(), 1);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/audio/speech",
        "authorization",
        "Bearer live-secret",
    );
}
