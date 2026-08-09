use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("piano")),
        ("output_format".to_owned(), json!("hex")),
    ]);
    let sentinel_key = "future_contract_sentinel_minimax_music_3_0";
    let sentinel_value = "future-contract-sentinel::minimax-music-3-0";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Music,
        "minimax-music-3-0",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-minimax_music_3_0-invalid-request",
                "message": "minimax_music_3_0 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-minimax_music_3_0-invalid-request",
            "minimax_music_3_0 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Music,
        "minimax-music-3-0",
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
        "https://model.example/v1/v1/music_generation",
        "authorization",
        "Bearer live-secret",
    );
}

#[test]
fn minimax_music_three_owns_hex_and_url_contracts_without_added_defaults() {
    let (hex, hex_requests) = run_fixture(
        ModelKind::Music,
        "minimax-music-3-0",
        &Map::from_iter([
            ("prompt".to_owned(), json!("minimal piano")),
            ("output_format".to_owned(), json!("hex")),
        ]),
        vec![fixture_json(&json!({
            "base_resp": {"status_code": 0},
            "data": {"audio": "494433"},
            "extra_info": {"audio_format": "mp3"}
        }))],
    );
    assert_eq!(hex.payloads[0].bytes, b"ID3");
    let HttpBody::Json(hex_body) = &hex_requests[0].body else {
        panic!("MiniMax Music request must be JSON");
    };
    assert_eq!(hex_body.get("model"), Some(&json!("music-3.0")));
    assert_eq!(hex_body.get("output_format"), Some(&json!("hex")));
    assert!(hex_body.get("audio_setting").is_none());
    assert!(hex_body.get("is_instrumental").is_none());

    let (url, url_requests) = run_fixture(
        ModelKind::Music,
        "minimax-music-3-0",
        &Map::from_iter([
            ("lyrics".to_owned(), json!("one clear line")),
            ("output_format".to_owned(), json!("url")),
        ]),
        vec![
            fixture_json(&json!({
                "base_resp": {"status_code": 0},
                "data": {"audio": "https://media.example/minimax-music"}
            })),
            fixture_media("audio/flac", b"fLaC"),
        ],
    );
    assert_eq!(url.payloads[0].bytes, b"fLaC");
    assert_eq!(url_requests.len(), 2);
    let HttpBody::Json(url_body) = &url_requests[0].body else {
        panic!("MiniMax Music URL request must be JSON");
    };
    assert!(url_body.get("prompt").is_none());
    assert_eq!(url_body.get("lyrics"), Some(&json!("one clear line")));
}
