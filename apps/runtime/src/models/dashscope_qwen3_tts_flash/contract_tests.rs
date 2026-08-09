use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        ("voice".to_owned(), json!("Cherry")),
    ]);
    let sentinel_key = "future_contract_sentinel_dashscope_qwen3_tts_flash";
    let sentinel_value = "future-contract-sentinel::dashscope-qwen3-tts-flash";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "dashscope-qwen3-tts-flash",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-dashscope_qwen3_tts_flash-invalid-request",
                "message": "dashscope_qwen3_tts_flash exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-dashscope_qwen3_tts_flash-invalid-request",
            "dashscope_qwen3_tts_flash exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "dashscope-qwen3-tts-flash",
        &arguments,
        vec![
            fixture_json(&json!({"output": {"audio": {"url": "https://media.example/qwen.wav"}}})),
            fixture_media("audio/wav", b"RIFFaudio"),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"RIFFaudio");
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
    assert_public_download_request(&requests[1], "https://media.example/qwen.wav");
}
