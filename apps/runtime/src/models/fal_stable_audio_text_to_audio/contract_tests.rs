use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("texture"))]);
    let sentinel_key = "future_contract_sentinel_fal_stable_audio_text_to_audio";
    let sentinel_value = "future-contract-sentinel::fal-stable-audio-text-to-audio";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Music,
        "fal-stable-audio-text-to-audio",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-fal_stable_audio_text_to_audio-invalid-request",
                "message": "fal_stable_audio_text_to_audio exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-fal_stable_audio_text_to_audio-invalid-request",
            "fal_stable_audio_text_to_audio exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Music,
        "fal-stable-audio-text-to-audio",
        &arguments,
        vec![
            fixture_json(
                &json!({"request_id": "task", "status_url": "https://model.example/status/task"}),
            ),
            fixture_json(
                &json!({"status": "COMPLETED", "response_url": "https://model.example/result/task"}),
            ),
            fixture_json(&json!({"audio": {"url": "https://media.example/music.wav"}})),
            fixture_media("audio/wav", b"RIFFmusic"),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].bytes, b"RIFFmusic");
    assert_eq!(requests.len(), 4);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/fal-ai/stable-audio-25/text-to-audio",
        "authorization",
        "Key live-secret",
    );
    assert_model_endpoint_request(
        &requests[1],
        HttpMethod::Get,
        "https://model.example/status/task",
        "authorization",
        "Key live-secret",
    );
    assert_model_endpoint_request(
        &requests[2],
        HttpMethod::Get,
        "https://model.example/result/task",
        "authorization",
        "Key live-secret",
    );
    for request in &requests[..3] {
        assert_eq!(
            request.headers.get("x-fal-no-retry").map(String::as_str),
            Some("1")
        );
    }
    assert_public_download_request(&requests[3], "https://media.example/music.wav");
}

#[test]
fn owns_remote_cancellation_contract() {
    let cleanup_response = ModelHttpResponse {
        status: 503,
        headers: std::collections::BTreeMap::new(),
        body: b"remote cleanup failed".to_vec(),
    };
    let (result, requests, remaining) = execute_cancelling_fixture(
        ModelKind::Music,
        "fal-stable-audio-text-to-audio",
        &Map::new(),
        vec![
            fixture_json(
                &json!({"request_id": "owned-cancel-task", "status_url": "https://model.example/v1/status/owned-cancel-task", "cancel_url": "https://model.example/v1/cancel/owned-cancel-task"}),
            ),
            cleanup_response,
        ],
        2,
    );

    assert_eq!(result.unwrap_err().code(), "model_request_cancelled");
    assert_eq!(remaining, 0);
    assert_eq!(
        requests
            .iter()
            .map(|request| request.method)
            .collect::<Vec<_>>(),
        vec![HttpMethod::Post, HttpMethod::Get, HttpMethod::Put],
    );
    assert_eq!(
        requests[2].url,
        "https://model.example/v1/cancel/owned-cancel-task"
    );
}
