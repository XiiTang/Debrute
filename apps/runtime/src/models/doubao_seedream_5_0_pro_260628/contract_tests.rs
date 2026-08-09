use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "doubao-seedream-5-0-pro-260628",
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
    let sentinel_key = "future_contract_sentinel_doubao_seedream_5_0_pro_260628";
    let sentinel_value = "future-contract-sentinel::doubao-seedream-5-0-pro-260628";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "doubao-seedream-5-0-pro-260628",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-doubao_seedream_5_0_pro_260628-invalid-request",
                "message": "doubao_seedream_5_0_pro_260628 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-doubao_seedream_5_0_pro_260628-invalid-request",
            "doubao_seedream_5_0_pro_260628 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-pro-260628",
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
fn seedream_5_pro_owns_ordered_editing_and_both_response_transports() {
    let (url_execution, url_requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-pro-260628",
        &Map::from_iter([
            (
                "prompt".to_owned(),
                json!("turn both references into a poster"),
            ),
            (
                "image".to_owned(),
                json!([
                    "data:image/png;base64,iVBORw0KGgo=",
                    "data:image/jpeg;base64,/9j/"
                ]),
            ),
            ("output_format".to_owned(), json!("png")),
            ("response_format".to_owned(), json!("url")),
            ("watermark".to_owned(), json!(false)),
            ("future_parameter".to_owned(), json!("remote owns this")),
        ]),
        vec![
            fixture_json(&json!({
                "data": [
                    {"url": "https://media.example/pro-one.png"},
                    {"url": "https://media.example/pro-two.png"}
                ]
            })),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\n"),
            fixture_media("image/png", b"\x89PNG\r\n\x1a\nsecond"),
        ],
    );
    assert_eq!(url_execution.payloads.len(), 2);
    assert_eq!(url_requests.len(), 3);
    assert_eq!(url_requests[0].method, HttpMethod::Post);
    assert_eq!(
        url_requests[0].url,
        "https://model.example/v1/images/generations"
    );
    assert_eq!(url_requests[1].url, "https://media.example/pro-one.png");
    assert_eq!(url_requests[2].url, "https://media.example/pro-two.png");
    let HttpBody::Json(url_body) = &url_requests[0].body else {
        panic!("Seedream 5.0 Pro request must be JSON");
    };
    assert_eq!(
        url_body.get("model"),
        Some(&json!("doubao-seedream-5-0-pro-260628"))
    );
    assert_eq!(
        url_body.get("image"),
        Some(&json!([
            "data:image/png;base64,iVBORw0KGgo=",
            "data:image/jpeg;base64,/9j/"
        ]))
    );
    assert_eq!(
        url_body.get("future_parameter"),
        Some(&json!("remote owns this"))
    );

    let (base64_execution, base64_requests) = run_fixture(
        ModelKind::Image,
        "doubao-seedream-5-0-pro-260628",
        &Map::from_iter([
            ("prompt".to_owned(), json!("make a transparent icon")),
            ("response_format".to_owned(), json!("b64_json")),
        ]),
        vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))],
    );
    assert_eq!(base64_execution.payloads.len(), 1);
    assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
    assert_eq!(base64_requests.len(), 1);
}
