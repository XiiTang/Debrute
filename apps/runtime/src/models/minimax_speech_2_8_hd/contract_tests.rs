use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        (
            "voice_setting".to_owned(),
            json!({"voice_id": "male-qn-qingse"}),
        ),
        ("output_format".to_owned(), json!("hex")),
    ]);
    let sentinel_key = "future_contract_sentinel_minimax_speech_2_8_hd";
    let sentinel_value = "future-contract-sentinel::minimax-speech-2-8-hd";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "minimax-speech-2-8-hd",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-minimax_speech_2_8_hd-invalid-request",
                "message": "minimax_speech_2_8_hd exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-minimax_speech_2_8_hd-invalid-request",
            "minimax_speech_2_8_hd exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "minimax-speech-2-8-hd",
        &arguments,
        vec![fixture_json(
            &json!({"base_resp": {"status_code": 0}, "data": {"audio": "494433"}, "extra_info": {"audio_format": "mp3"}}),
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
        "https://model.example/v1/v1/t2a_v2",
        "authorization",
        "Bearer live-secret",
    );
}
