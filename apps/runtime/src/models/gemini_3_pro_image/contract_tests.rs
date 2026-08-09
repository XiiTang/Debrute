use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "gemini-3-pro-image",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({"prompt": "make an image", "delivery": "uri"}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("render")),
        ("delivery".to_owned(), json!("uri")),
    ]);
    let sentinel_key = "future_contract_sentinel_gemini_3_pro_image";
    let sentinel_value = "future-contract-sentinel::gemini-3-pro-image";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "gemini-3-pro-image",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-gemini_3_pro_image-invalid-request",
                "message": "gemini_3_pro_image exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-gemini_3_pro_image-invalid-request",
            "gemini_3_pro_image exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gemini-3-pro-image",
        &arguments,
        vec![
            fixture_json(
                &json!({"steps": [{"type": "model_output", "content": [{"type": "image", "uri": "https://media.example/pro.png"}]}]}),
            ),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].mime_type, "image/png");
    assert_eq!(requests.len(), 2);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/interactions",
        "x-goog-api-key",
        "live-secret",
    );
    assert_public_download_request(&requests[1], "https://media.example/pro.png");
}

#[test]
fn gemini_pro_uses_its_independent_uri_response_contract() {
    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gemini-3-pro-image",
        &Map::from_iter([
            ("prompt".to_owned(), json!("render")),
            ("delivery".to_owned(), json!("uri")),
            ("future_parameter".to_owned(), json!(9)),
        ]),
        vec![
            fixture_json(&json!({
                "steps": [{
                    "type": "model_output",
                    "content": [{
                        "type": "image",
                        "uri": "https://media.example/pro-output"
                    }]
                }]
            })),
            fixture_media("application/octet-stream", b"\x89PNG\r\n\x1a\n"),
        ],
    );
    assert_eq!(execution.payloads.len(), 1);
    assert_eq!(requests.len(), 2);
    assert!(requests[0].url.ends_with("/v1/interactions"));
    assert_eq!(requests[1].url, "https://media.example/pro-output");
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Gemini Interactions request must be JSON");
    };
    assert_eq!(body.get("model"), Some(&json!("gemini-3-pro-image")));
    assert_eq!(body.get("future_parameter"), Some(&json!(9)));
    assert_eq!(
        body.get("response_format"),
        Some(&json!({
            "type": "image",
            "delivery": "uri"
        }))
    );
}
