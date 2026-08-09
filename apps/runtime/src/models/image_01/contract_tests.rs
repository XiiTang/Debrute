use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "image-01",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({"prompt": "make an image", "response_format": "base64"}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("character")),
        ("response_format".to_owned(), json!("base64")),
    ]);
    let sentinel_key = "future_contract_sentinel_image_01";
    let sentinel_value = "future-contract-sentinel::image-01";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "image-01",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-image_01-invalid-request",
                "message": "image_01 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-image_01-invalid-request",
            "image_01 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "image-01",
        &arguments,
        vec![fixture_json(
            &json!({"base_resp": {"status_code": 0}, "data": {"image_base64": ["iVBORw0KGgo="]}}),
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
        "https://model.example/v1/v1/image_generation",
        "authorization",
        "Bearer live-secret",
    );
}

#[test]
fn minimax_image_01_owns_both_formats_and_string_subject_references() {
    let (base64_execution, base64_requests) = run_fixture(
        ModelKind::Image,
        "image-01",
        &Map::from_iter([
            ("prompt".to_owned(), json!("character poster")),
            ("subject_reference".to_owned(), json!([])),
            ("response_format".to_owned(), json!("base64")),
        ]),
        vec![fixture_json(&json!({
            "base_resp": {"status_code": 0},
            "data": {"image_base64": ["iVBORw0KGgo="]}
        }))],
    );
    assert_eq!(base64_execution.payloads[0].mime_type, "image/png");
    let HttpBody::Json(base64_body) = &base64_requests[0].body else {
        panic!("MiniMax request must be JSON");
    };
    assert_eq!(base64_body.get("subject_reference"), Some(&json!([])));

    let (url_execution, url_requests) = run_fixture(
        ModelKind::Image,
        "image-01",
        &Map::from_iter([
            ("prompt".to_owned(), json!("character poster")),
            (
                "subject_reference".to_owned(),
                json!(["data:image/png;base64,iVBORw0KGgo="]),
            ),
            ("response_format".to_owned(), json!("url")),
        ]),
        vec![
            fixture_json(&json!({
                "base_resp": {"status_code": 0},
                "data": {"image_urls": ["https://media.example/minimax"]}
            })),
            fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
        ],
    );
    assert_eq!(url_execution.payloads[0].mime_type, "image/jpeg");
    assert_eq!(url_requests.len(), 2);
    let HttpBody::Json(url_body) = &url_requests[0].body else {
        panic!("MiniMax request must be JSON");
    };
    assert_eq!(
        url_body.pointer("/subject_reference/0/type"),
        Some(&json!("character"))
    );
    assert_eq!(
        url_body.pointer("/subject_reference/0/image_file"),
        Some(&json!("data:image/png;base64,iVBORw0KGgo="))
    );
}
