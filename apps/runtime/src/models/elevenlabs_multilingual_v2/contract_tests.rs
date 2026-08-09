use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        ("voice_id".to_owned(), json!("voice")),
    ]);
    let sentinel_key = "future_contract_sentinel_elevenlabs_multilingual_v2";
    let sentinel_value = "future-contract-sentinel::elevenlabs-multilingual-v2";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "elevenlabs-multilingual-v2",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-elevenlabs_multilingual_v2-invalid-request",
                "message": "elevenlabs_multilingual_v2 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-elevenlabs_multilingual_v2-invalid-request",
            "elevenlabs_multilingual_v2 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "elevenlabs-multilingual-v2",
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
        "https://model.example/v1/text-to-speech/voice",
        "xi-api-key",
        "live-secret",
    );
}
