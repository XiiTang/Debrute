use crate::models::testing::*;

#[test]
fn owns_debrute_defaults() {
    assert_materialized_defaults(
        "gemini-3.1-flash-image",
        Map::from_iter([("prompt".to_owned(), json!("make an image"))]),
        json!({"prompt": "make an image", "delivery": "uri"}),
    );
}

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("render")),
        ("delivery".to_owned(), json!("inline")),
    ]);
    let sentinel_key = "future_contract_sentinel_gemini_3_1_flash_image";
    let sentinel_value = "future-contract-sentinel::gemini-3.1-flash-image";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "gemini-3.1-flash-image",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-gemini_3_1_flash_image-invalid-request",
                "message": "gemini_3_1_flash_image exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-gemini_3_1_flash_image-invalid-request",
            "gemini_3_1_flash_image exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gemini-3.1-flash-image",
        &arguments,
        vec![fixture_json(
            &json!({"steps": [{"type": "model_output", "content": [{"type": "image", "data": "iVBORw0KGgo="}]}]}),
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
        "https://model.example/v1/interactions",
        "x-goog-api-key",
        "live-secret",
    );
}

#[test]
fn gemini_flash_uses_interactions_inline_contract() {
    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gemini-3.1-flash-image",
        &Map::from_iter([
            ("prompt".to_owned(), json!("restyle")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,iVBORw0KGgo="]),
            ),
            ("aspect_ratio".to_owned(), json!("16:9")),
            ("image_size".to_owned(), json!("2K")),
            ("delivery".to_owned(), json!("inline")),
            ("future_parameter".to_owned(), json!("remote validates")),
        ]),
        vec![fixture_json(&json!({
            "steps": [{
                "type": "model_output",
                "content": [
                    {"type": "text", "text": "done"},
                    {"type": "image", "data": "iVBORw0KGgo="}
                ]
            }]
        }))],
    );
    assert_eq!(execution.payloads.len(), 1);
    assert!(requests[0].url.ends_with("/v1/interactions"));
    assert_eq!(
        requests[0]
            .headers
            .get("x-goog-api-key")
            .map(String::as_str),
        Some("live-secret")
    );
    let HttpBody::Json(body) = &requests[0].body else {
        panic!("Gemini Interactions request must be JSON");
    };
    assert_eq!(body.get("model"), Some(&json!("gemini-3.1-flash-image")));
    assert_eq!(body.get("store"), Some(&json!(false)));
    assert_eq!(
        body.get("future_parameter"),
        Some(&json!("remote validates"))
    );
    assert_eq!(
        body.pointer("/input/0"),
        Some(&json!({
            "type": "text",
            "text": "restyle"
        }))
    );
    assert_eq!(
        body.pointer("/input/1"),
        Some(&json!({
            "type": "image",
            "mime_type": "image/png",
            "data": "iVBORw0KGgo="
        }))
    );
    assert_eq!(
        body.get("response_format"),
        Some(&json!({
            "type": "image",
            "delivery": "inline",
            "aspect_ratio": "16:9",
            "image_size": "2K"
        }))
    );
}
