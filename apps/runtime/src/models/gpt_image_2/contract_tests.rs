use crate::models::testing::*;

#[test]
fn owns_request_response_error_and_artifact_contract() {
    let mut arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,iVBORw0KGgo="]),
        ),
    ]);
    let sentinel_key = "future_contract_sentinel_gpt_image_2";
    let sentinel_value = "future-contract-sentinel::gpt-image-2";
    arguments.insert(sentinel_key.to_owned(), json!(sentinel_value));
    assert_first_request_preserves_remote_error(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        fixture_remote_json_error(
            422,
            &json!({
                "code": "fixture-gpt_image_2-invalid-request",
                "message": "gpt_image_2 exact Model rejected the fixture request"
            }),
        ),
        &[
            "fixture-gpt_image_2-invalid-request",
            "gpt_image_2 exact Model rejected the fixture request",
        ],
    );

    let (execution, requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-2",
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
        "https://model.example/v1/images/edits",
        "authorization",
        "Bearer live-secret",
    );
    assert!(matches!(requests[0].body, HttpBody::Multipart { .. }));
}

#[test]
fn gpt_image_two_data_url_edits_use_multipart() {
    let (_, requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-2",
        &Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/png;base64,iVBORw0KGgo="]),
            ),
        ]),
        vec![fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))],
    );
    assert!(matches!(requests[0].body, HttpBody::Multipart { .. }));
}

#[test]
fn gpt_image_edits_submit_empty_images_mask_only_and_generic_image_mime() {
    let response = || {
        fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        }))
    };

    let (_, empty_requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-2",
        &Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            ("image".to_owned(), json!([])),
        ]),
        vec![response()],
    );
    let HttpBody::Json(empty_body) = &empty_requests[0].body else {
        panic!("URL-only GPT edit must be JSON");
    };
    assert_eq!(empty_body.get("images"), Some(&json!([])));

    let (_, mask_requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-2",
        &Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "mask".to_owned(),
                json!("data:image/png;base64,iVBORw0KGgo="),
            ),
        ]),
        vec![response()],
    );
    assert!(matches!(mask_requests[0].body, HttpBody::Multipart { .. }));

    let (_, gif_requests) = run_fixture(
        ModelKind::Image,
        "gpt-image-2",
        &Map::from_iter([
            ("prompt".to_owned(), json!("edit")),
            (
                "image".to_owned(),
                json!(["data:image/gif;base64,R0lGODlh"]),
            ),
        ]),
        vec![response()],
    );
    assert!(matches!(gif_requests[0].body, HttpBody::Multipart { .. }));
}

#[test]
fn input_media_item_limit_is_inclusive() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQIDBA=="]),
        ),
    ]);
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 4096,
        },
    );

    assert!(result.is_ok());
    assert_eq!(requests.len(), 1);
    assert_eq!(remaining, 0);
}

#[test]
fn input_media_item_limit_rejects_before_transport() {
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQIDBAU="]),
        ),
    ]);

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 1024,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn local_input_uses_the_same_media_item_limit_before_transport() {
    let invocation_cwd = std::env::temp_dir().join(format!(
        "debrute-model-request-input-limit-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&invocation_cwd).unwrap();
    std::fs::write(invocation_cwd.join("input.png"), b"12345").unwrap();
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        ("image".to_owned(), json!(["input.png"])),
    ]);

    let (result, requests, remaining) = execute_fixture_with_invocation_cwd_and_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        &invocation_cwd,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 1024,
        },
    );
    std::fs::remove_dir_all(invocation_cwd).unwrap();

    assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn model_request_budget_rejects_later_media_before_transport() {
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!([
                "data:image/png;base64,AQIDBA==",
                "data:image/png;base64,AQIDBA==",
                "data:image/png;base64,AQIDBA=="
            ]),
        ),
    ]);

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 38,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn known_inline_request_lower_bound_rejects_before_base64_decode() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!([format!("data:{};base64,!!!!", "x".repeat(64))]),
        ),
    ]);
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 32,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn downloaded_multipart_input_uses_the_input_item_limit() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
        ),
    ]);
    let responses = vec![
        fixture_media("image/png", b"12345"),
        fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        })),
    ];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 1024,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_input_too_large");
    assert_eq!(
        requests.len(),
        1,
        "only the input download may reach transport"
    );
    assert_eq!(
        requests[0].method,
        crate::model_request::types::HttpMethod::Get
    );
    assert_eq!(remaining, 1);
}

#[test]
fn downloaded_input_rejects_non_success_response_before_model_request() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
        ),
    ]);
    let responses = vec![
        ModelHttpResponse {
            status: 404,
            headers: std::collections::BTreeMap::from([(
                "content-type".to_owned(),
                "image/png".to_owned(),
            )]),
            body: b"\x89PNG\r\n\x1a\n".to_vec(),
        },
        fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        })),
    ];

    let (result, requests, remaining) =
        execute_fixture(ModelKind::Image, "gpt-image-2", &arguments, responses);

    assert_eq!(result.unwrap_err().code(), "input_media_download_failed");
    assert_eq!(requests.len(), 1, "only the failed input download may run");
    assert_eq!(
        remaining, 1,
        "the model request must not consume a response"
    );
}

#[test]
fn downloaded_input_is_bounded_by_the_remaining_request_budget() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQ==", "https://1.1.1.1/input.png"]),
        ),
    ]);
    let responses = vec![
        fixture_media("image/png", b"123"),
        fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        })),
    ];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 12,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].maximum_response_bytes, 2);
    assert_eq!(remaining, 1);
}

#[test]
fn direct_public_url_contributes_its_text_to_the_request_budget() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        ("image".to_owned(), json!(["https://1.1.1.1/input.png"])),
    ]);
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 8,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn downloaded_input_does_not_temporarily_consume_the_direct_url_budget() {
    let long_url = format!("https://1.1.1.1/{}.png", "x".repeat(5000));
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        (
            "image".to_owned(),
            json!(["data:image/png;base64,AQ==", long_url]),
        ),
    ]);
    let responses = vec![
        fixture_media("image/png", b"1"),
        fixture_json(&json!({
            "data": [{"b64_json": "iVBORw0KGgo="}]
        })),
    ];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 4096,
        },
    );

    assert!(result.is_ok());
    assert_eq!(requests.len(), 2);
    assert_eq!(remaining, 0);
}

#[test]
fn final_json_request_size_is_enforced_before_transport() {
    let arguments = Map::from_iter([("prompt".to_owned(), json!("x".repeat(64)))]);
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 32,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn final_multipart_request_size_is_enforced_before_transport() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        ("image".to_owned(), json!(["data:image/png;base64,AQ=="])),
    ]);
    let responses = vec![fixture_json(&json!({
        "data": [{"b64_json": "iVBORw0KGgo="}]
    }))];

    let (result, requests, remaining) = execute_fixture_with_limits(
        ModelKind::Image,
        "gpt-image-2",
        &arguments,
        responses,
        ModelRequestResourceLimits {
            input_media_item_bytes: 4,
            model_request_bytes: 16,
        },
    );

    assert_eq!(result.unwrap_err().code(), "model_request_too_large");
    assert!(requests.is_empty());
    assert_eq!(remaining, 1);
}

#[test]
fn provider_side_media_urls_are_publicly_validated_before_submission() {
    let arguments = Map::from_iter([
        ("prompt".to_owned(), json!("edit")),
        ("image".to_owned(), json!(["http://127.0.0.1/private.png"])),
    ]);
    let (result, requests, remaining) =
        execute_fixture(ModelKind::Image, "gpt-image-2", &arguments, Vec::new());
    assert_eq!(result.unwrap_err().code(), "remote_media_host_blocked");
    assert!(requests.is_empty());
    assert_eq!(remaining, 0);
}
