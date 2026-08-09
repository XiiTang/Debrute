use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "doubao-seedream-5-0-lite-260128",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({
            "prompt": "make an image",
            "output_format": "png",
            "response_format": "url",
            "watermark": false
        }),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("poster")),
        ("response_format".to_owned(), json!("b64_json")),
    ]);
    let sentinel_key = "future_contract_sentinel_doubao_seedream_5_0_lite_260128";
    let sentinel_value = "future-contract-sentinel::doubao-seedream-5-0-lite-260128";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "doubao-seedream-5-0-lite-260128",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-doubao_seedream_5_0_lite_260128-invalid-request",
                "message": "doubao_seedream_5_0_lite_260128 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-doubao_seedream_5_0_lite_260128-invalid-request",
            "doubao_seedream_5_0_lite_260128 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-lite-260128",
        &arguments,
        vec![fixture_json(
            &json!({"data": [{"b64_json": "iVBORw0KGgo="}]}),
        )],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].mime_type, "image/png");
    assert_eq!(requests.len(), 1);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/images/generations",
        "authorization",
        "Bearer live-secret",
    );
}

#[test]
fn seedream_url_and_base64_contracts_are_exact() {
    let (_, url_requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-lite-260128",
        &Map::from_iter([
            ("prompt".to_owned(), json!("poster")),
            ("image".to_owned(), json!([])),
            ("response_format".to_owned(), json!("url")),
            ("output_format".to_owned(), json!("png")),
            ("watermark".to_owned(), json!(false)),
        ]),
        vec![
            fixture_json(&json!({
                "data": [{"url": "https://media.example/seedream"}]
            })),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
        ],
    );
    assert_eq!(url_requests.len(), 2);
    let HttpBody::Json(url_body) = &url_requests[0].body else {
        panic!("Seedream request must be JSON");
    };
    assert_eq!(url_body.get("image"), Some(&json!([])));

    let (base64_execution, base64_requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-lite-260128",
        &Map::from_iter([
            ("prompt".to_owned(), json!("poster")),
            ("response_format".to_owned(), json!("b64_json")),
        ]),
        vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))],
    );
    assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
    assert_eq!(base64_requests.len(), 1);
}
