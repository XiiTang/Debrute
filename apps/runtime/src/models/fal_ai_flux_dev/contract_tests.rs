use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([("prompt".to_owned(), json!("product"))]);
    let sentinel_key = "future_contract_sentinel_fal_ai_flux_dev";
    let sentinel_value = "future-contract-sentinel::fal-ai/flux/dev";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "fal-ai/flux/dev",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-fal_ai_flux_dev-invalid-request",
                "message": "fal_ai_flux_dev exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-fal_ai_flux_dev-invalid-request",
            "fal_ai_flux_dev exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "fal-ai/flux/dev",
        &arguments,
        vec![
            fixture_json(&json!({"images": [{"url": "https://media.example/flux.jpg"}]})),
            fixture_media("image/jpeg", &[0xff, 0xd8, 0xff]),
        ],
    );

    assert!(!execution.payloads.is_empty());
    assert_eq!(execution.payloads[0].mime_type, "image/jpeg");
    assert_eq!(requests.len(), 2);
    assert_request_contains_unknown_sentinel(&requests[0], sentinel_key, sentinel_value);
    assert_primary_model_request(
        &execution,
        &requests[0],
        HttpMethod::Post,
        "https://model.example/v1/fal-ai/flux/dev",
        "authorization",
        "Key live-secret",
    );
    assert_public_download_request(&requests[1], "https://media.example/flux.jpg");
}
