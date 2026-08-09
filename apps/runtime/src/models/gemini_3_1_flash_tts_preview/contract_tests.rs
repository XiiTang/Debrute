use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("Speaker A: Hello")),
        (
            "speech_config".to_owned(),
            json!([{"speaker": "Speaker A", "voice": "Kore", "language": "en-US"}]),
        ),
    ]);
    let sentinel_key = "future_contract_sentinel_gemini_3_1_flash_tts_preview";
    let sentinel_value = "future-contract-sentinel::gemini-3-1-flash-tts-preview";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "gemini-3-1-flash-tts-preview",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-gemini_3_1_flash_tts_preview-invalid-request",
                "message": "gemini_3_1_flash_tts_preview exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-gemini_3_1_flash_tts_preview-invalid-request",
            "gemini_3_1_flash_tts_preview exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "gemini-3-1-flash-tts-preview",
        &arguments,
        vec![fixture_json(
            &json!({"steps": [{"type": "model_output", "content": [{"type": "audio", "mime_type": "audio/pcm;rate=24000;channels=1;bits=16", "data": "AAEC"}]}]}),
        )],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, &[0, 1, 2]);
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
