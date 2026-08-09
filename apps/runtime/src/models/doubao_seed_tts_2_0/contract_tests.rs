use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("text".to_owned(), json!("hello")),
        ("speaker".to_owned(), json!("speaker-v2")),
    ]);
    let sentinel_key = "future_contract_sentinel_doubao_seed_tts_2_0";
    let sentinel_value = "future-contract-sentinel::doubao-seed-tts-2-0";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Tts,
        "doubao-seed-tts-2-0",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-doubao_seed_tts_2_0-invalid-request",
                "message": "doubao_seed_tts_2_0 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-doubao_seed_tts_2_0-invalid-request",
            "doubao_seed_tts_2_0 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "doubao-seed-tts-2-0",
        &arguments,
        vec![fixture_media(
            "application/json",
            br#"{"code":0,"data":"AAEC"}{"code":20000000}"#,
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
        "https://model.example/v1/tts/unidirectional",
        "x-api-key",
        "live-secret",
    );
    assert_eq!(
        requests[0]
            .headers
            .get("x-api-resource-id")
            .map(String::as_str),
        Some("seed-tts-2.0")
    );
    assert!(
        requests[0]
            .headers
            .get("x-api-request-id")
            .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
    );
}

#[test]
fn doubao_tts_uses_continuous_frames_without_defaults_or_pcm_wrapping() {
    let (execution, requests) = run_fixture(
        ModelKind::Tts,
        "doubao-seed-tts-2-0",
        &Map::from_iter([
            ("text".to_owned(), json!("hello")),
            ("speaker".to_owned(), json!("speaker-v2")),
            (
                "audio_params".to_owned(),
                json!({"format": "pcm", "sample_rate": 22_050}),
            ),
        ]),
        vec![fixture_media(
            "application/json",
            br#"{"code":0,"data":"AAEC"}{"code":0,"data":"AwQ="}{"code":20000000}"#,
        )],
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Doubao TTS request must be JSON");
    };
    assert!(body.get("user").is_none());
    assert_eq!(
        body.pointer("/req_params/speaker"),
        Some(&json!("speaker-v2"))
    );
    assert_eq!(
        body.pointer("/req_params/audio_params/sample_rate"),
        Some(&json!(22_050))
    );
    assert_eq!(execution.payloads[0].bytes, &[0, 1, 2, 3, 4]);
    assert_eq!(execution.payloads[0].mime_type, "audio/pcm");
}
