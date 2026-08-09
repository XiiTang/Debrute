use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("text".to_owned(), json!("thunder"))]);
    let sentinel_key = "future_contract_sentinel_elevenlabs_sound_effects";
    let sentinel_value = "future-contract-sentinel::elevenlabs-sound-effects";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::SoundEffect,
        "elevenlabs-sound-effects",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-elevenlabs_sound_effects-invalid-request",
                "message": "elevenlabs_sound_effects exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-elevenlabs_sound_effects-invalid-request",
            "elevenlabs_sound_effects exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::SoundEffect,
        "elevenlabs-sound-effects",
        &arguments,
        vec![fixture_media("audio/mpeg", b"effect")],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"effect");
    assert_eq!(requests.len(), 1);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/sound-generation",
        "xi-api-key",
        "live-secret",
    );
}
