use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("restyle")),
        (
            "image_url".to_owned(),
            json!("data:image/png;base64,iVBORw0KGgo="),
        ),
    ]);
    let sentinel_key = "future_contract_sentinel_fal_ai_flux_dev_image_to_image";
    let sentinel_value = "future-contract-sentinel::fal-ai/flux/dev/image-to-image";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "fal-ai/flux/dev/image-to-image",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-fal_ai_flux_dev_image_to_image-invalid-request",
                "message": "fal_ai_flux_dev_image_to_image exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-fal_ai_flux_dev_image_to_image-invalid-request",
            "fal_ai_flux_dev_image_to_image exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "fal-ai/flux/dev/image-to-image",
        &arguments,
        vec![
            fixture_json(&json!({"images": [{"url": "https://media.example/flux.png"}]})),
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
        "https://model.example/v1/fal-ai/flux/dev/image-to-image",
        "authorization",
        "Key live-secret",
    );
    assert_public_download_request(&requests[1], "https://media.example/flux.png");
}
