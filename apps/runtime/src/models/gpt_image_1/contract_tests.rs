use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
    let sentinel_key = "future_contract_sentinel_gpt_image_1";
    let sentinel_value = "future-contract-sentinel::gpt-image-1";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "gpt-image-1",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-gpt_image_1-invalid-request",
                "message": "gpt_image_1 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-gpt_image_1-invalid-request",
            "gpt_image_1 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-1",
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
fn gpt_image_response_requires_b64_json_for_every_item() {
    let arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Image,
        "gpt-image-1",
        &arguments,
        vec![fixture_json(&json!({
            "data": [
                {"b64_json": "iVBORw0KGgo="},
                {"url": "https://media.example/url-only.png"}
            ]
        }))],
    );
    assert_eq!(result.unwrap_err().code(), "model_response_invalid");
    assert_eq!(requests.len(), 1);
    assert_eq!(remaining, 0);
}

#[test]
fn image_response_cardinality_has_no_generic_sixteen_artifact_ceiling() {
    let images = (0..17)
        .map(|_| json!({"b64_json": "iVBORw0KGgo="}))
        .collect::<Vec<_>>();
    let arguments = Map::from_iter([("prompt".to_owned(), json!("poster"))]);
    let (result, requests, remaining) = execute_fixture(
        ModelKind::Image,
        "gpt-image-1",
        &arguments,
        vec![fixture_json(&json!({"data": images}))],
    );
    assert_eq!(result.unwrap().payloads.len(), 17);
    assert_eq!(requests.len(), 1);
    assert_eq!(remaining, 0);
}
