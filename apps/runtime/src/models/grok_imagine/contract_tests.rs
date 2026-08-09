use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
    let sentinel_key = "future_contract_sentinel_grok_imagine";
    let sentinel_value = "future-contract-sentinel::grok-imagine";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "grok-imagine",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-grok_imagine-invalid-request",
                "message": "grok_imagine exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-grok_imagine-invalid-request",
            "grok_imagine exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "grok-imagine",
        &arguments,
        vec![
            fixture_json(
                &json!({"status": "completed", "imageUrl": "https://media.example/grok.png"}),
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
        "https://model.example/v1/models/grok-imagine",
        "authorization",
        "Bearer live-secret",
    );
    assert_public_download_request(&requests[1], "https://media.example/grok.png");
}

#[test]
fn vydra_grok_imagine_uses_one_synchronous_image_response() {
    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "grok-imagine",
        &Map::from_iter([
            ("prompt".to_owned(), json!("poster")),
            ("aspect_ratio".to_owned(), json!("16:9")),
        ]),
        vec![
            fixture_json(&json!({
                "jobId": "ignored-job",
                "status": "completed",
                "imageUrl": "https://media.example/vydra-output",
                "resultUrls": ["https://media.example/unused"]
            })),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
        ],
    );
    assert_eq!(execution.payloads.len(), 1);
    assert_eq!(requests.len(), 2);
    assert!(requests[0].url.ends_with("/v1/models/grok-imagine"));
    assert_eq!(requests[1].url, "https://media.example/vydra-output");
    assert!(
        !requests
            .iter()
            .any(|request| request.url.contains("/jobs/"))
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Vydra request must be JSON");
    };
    assert_eq!(body.get("model"), Some(&json!("text-to-image")));
}
