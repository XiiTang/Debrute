use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        ("voice_id".to_owned(), json!("voice")),
        ("output_format".to_owned(), json!("wav_44100")),
        ("language_code".to_owned(), json!("ja")),
        ("voice_settings".to_owned(), json!({"stability": 0.5})),
        (
            "pronunciation_dictionary_locators".to_owned(),
            json!([{
                "pronunciation_dictionary_id": "dictionary",
                "version_id": "version"
            }]),
        ),
        ("seed".to_owned(), json!(42)),
        ("previous_text".to_owned(), json!("before")),
        ("next_text".to_owned(), json!("after")),
        ("previous_request_ids".to_owned(), json!(["previous"])),
        ("next_request_ids".to_owned(), json!(["next"])),
        ("apply_text_normalization".to_owned(), json!("on")),
        ("apply_language_text_normalization".to_owned(), json!(true)),
        ("use_pvc_as_ivc".to_owned(), json!(false)),
    ]);
    let sentinel_key = "future_contract_sentinel_elevenlabs_v3_tts";
    let sentinel_value = "future-contract-sentinel::elevenlabs-v3-tts";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "elevenlabs-v3-tts",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-elevenlabs_v3_tts-invalid-request",
                "message": "elevenlabs_v3_tts exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-elevenlabs_v3_tts-invalid-request",
            "elevenlabs_v3_tts exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "elevenlabs-v3-tts",
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
        "https://model.example/v1/text-to-speech/voice?output_format=wav_44100",
        "xi-api-key",
        "live-secret",
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("ElevenLabs Create Speech request must be JSON");
    };
    for field in [
        "language_code",
        "voice_settings",
        "pronunciation_dictionary_locators",
        "seed",
        "previous_text",
        "next_text",
        "previous_request_ids",
        "next_request_ids",
        "apply_text_normalization",
        "apply_language_text_normalization",
        "use_pvc_as_ivc",
    ] {
        assert_eq!(body.get(field), arguments.get(field), "{field}");
    }
    assert_eq!(body.pointer("/model_id"), Some(&json!("eleven_v3")));
    assert!(body.get("voice_id").is_none());
    assert!(body.get("output_format").is_none());
}
