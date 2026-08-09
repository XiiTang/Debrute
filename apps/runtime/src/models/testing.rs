use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::Mutex,
    time::Duration,
};

pub(crate) use serde_json::{Map, Value, json};

use crate::model_request::{
    common::{
        ExecutionContext, ModelExecutor, execute_model, join_url, materialize_argument_defaults,
    },
    types::{
        HttpBody as RawHttpBody, ModelArtifactPayload, ModelExecutionDraft, ModelHttpTransport,
        ModelRequestCancellation, ModelRequestDeadline, ModelRequestError,
        ResolvedModelRequestModel,
    },
};
pub(crate) use crate::{
    model_operation::ModelKind,
    model_request::{
        common::ModelRequestResourceLimits,
        types::{
            HttpMethod, ModelExecution, ModelHttpRequest, ModelHttpResponse,
            PreparedHttpBody as HttpBody,
        },
    },
};

use super::{DefinitionFile, ModelCatalog, ModelDefinition};

pub(crate) const FIXTURE_MODEL_ID: &str = "model-request-fixture";
pub(crate) const FIXTURE_API_KEY: &str = "live-secret";

pub(crate) fn fixture_model_catalog() -> ModelCatalog {
    ModelCatalog {
        definitions: vec![ModelDefinition {
            data: DefinitionFile {
                id: FIXTURE_MODEL_ID.to_owned(),
                kind: ModelKind::Image,
                summary: "Test-only model request fixture.".to_owned(),
                default_base_url: "https://fixture.example/v1".to_owned(),
                default_request_model_id: "fixture-request-model".to_owned(),
                arguments_schema: json!({
                    "type": "object",
                    "properties": {
                        "prompt": {},
                        "n": {},
                        "future_parameter": {}
                    }
                }),
            },
            manual: "# model-request-fixture",
            executor: fixture_model_executor,
        }],
    }
}

pub(crate) const fn fixture_model_executor_fn() -> ModelExecutor {
    fixture_model_executor
}

fn fixture_model_executor(
    context: &mut ExecutionContext<'_>,
) -> Result<ModelExecutionDraft, ModelRequestError> {
    let mut body = context.arguments.clone();
    body.insert(
        "fixture_request_model_id".to_owned(),
        json!(context.model.request_model_id),
    );
    let response = context.json(
        HttpMethod::Post,
        join_url(&context.model.base_url, "execute")?,
        BTreeMap::from([("authorization".to_owned(), context.model.api_key.clone())]),
        RawHttpBody::Json(Value::Object(body.clone())),
    )?;
    Ok(ModelExecutionDraft {
        payloads: vec![ModelArtifactPayload {
            bytes: b"fixture-artifact".to_vec(),
            mime_type: "application/octet-stream".to_owned(),
            model_output: response.clone(),
        }],
        safe_request: Value::Object(body),
    })
}

struct FixtureTransport {
    responses: Mutex<VecDeque<ModelHttpResponse>>,
    requests: Mutex<Vec<ModelHttpRequest>>,
}

struct CancellingFixtureTransport {
    responses: Mutex<VecDeque<ModelHttpResponse>>,
    requests: Mutex<Vec<ModelHttpRequest>>,
    cancel_on_request: usize,
}

impl ModelHttpTransport for FixtureTransport {
    fn execute(
        &self,
        request: ModelHttpRequest,
        cancellation: &ModelRequestCancellation,
        deadline: ModelRequestDeadline,
    ) -> Result<ModelHttpResponse, ModelRequestError> {
        deadline.remaining(cancellation)?;
        self.requests
            .lock()
            .expect("fixture requests")
            .push(request);
        self.responses
            .lock()
            .expect("fixture responses")
            .pop_front()
            .ok_or_else(|| {
                ModelRequestError::new(
                    "fixture_exhausted",
                    "Model request fixture response queue is empty.",
                )
            })
    }
}

impl ModelHttpTransport for CancellingFixtureTransport {
    fn execute(
        &self,
        request: ModelHttpRequest,
        cancellation: &ModelRequestCancellation,
        deadline: ModelRequestDeadline,
    ) -> Result<ModelHttpResponse, ModelRequestError> {
        deadline.remaining(cancellation)?;
        let request_number = {
            let mut requests = self.requests.lock().expect("fixture requests");
            requests.push(request);
            requests.len()
        };
        if request_number == self.cancel_on_request {
            cancellation.cancel();
            return Err(deadline
                .remaining(cancellation)
                .expect_err("cancelled fixture"));
        }
        let response = self
            .responses
            .lock()
            .expect("fixture responses")
            .pop_front()
            .ok_or_else(|| {
                ModelRequestError::new(
                    "fixture_exhausted",
                    "Model request fixture response queue is empty.",
                )
            })?;
        Ok(response)
    }
}

pub(crate) fn fixture_json(value: &Value) -> ModelHttpResponse {
    ModelHttpResponse {
        status: 200,
        headers: std::collections::BTreeMap::from([(
            "content-type".to_owned(),
            "application/json".to_owned(),
        )]),
        body: serde_json::to_vec(value).expect("fixture JSON"),
    }
}

pub(crate) fn fixture_media(mime: &str, bytes: &[u8]) -> ModelHttpResponse {
    ModelHttpResponse {
        status: 200,
        headers: std::collections::BTreeMap::from([("content-type".to_owned(), mime.to_owned())]),
        body: bytes.to_vec(),
    }
}

pub(crate) fn fixture_remote_json_error(status: u16, value: &Value) -> ModelHttpResponse {
    ModelHttpResponse {
        status,
        headers: std::collections::BTreeMap::from([(
            "content-type".to_owned(),
            "application/json".to_owned(),
        )]),
        body: serde_json::to_vec(value).expect("fixture remote error JSON"),
    }
}

pub(crate) fn execute_fixture(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
) -> (
    Result<ModelExecution, ModelRequestError>,
    Vec<ModelHttpRequest>,
    usize,
) {
    execute_fixture_with_limits(
        kind,
        model_id,
        arguments,
        responses,
        ModelRequestResourceLimits::default(),
    )
}

pub(crate) fn execute_fixture_with_limits(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
    limits: ModelRequestResourceLimits,
) -> (
    Result<ModelExecution, ModelRequestError>,
    Vec<ModelHttpRequest>,
    usize,
) {
    execute_fixture_with_invocation_cwd_and_limits(
        kind,
        model_id,
        arguments,
        responses,
        Path::new("."),
        limits,
    )
}

pub(crate) fn execute_fixture_with_invocation_cwd_and_limits(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
    invocation_cwd: &Path,
    limits: ModelRequestResourceLimits,
) -> (
    Result<ModelExecution, ModelRequestError>,
    Vec<ModelHttpRequest>,
    usize,
) {
    execute_fixture_at_base_url_with_invocation_cwd_and_limits(
        kind,
        model_id,
        arguments,
        responses,
        invocation_cwd,
        limits,
        "https://model.example/v1",
    )
}

pub(crate) fn execute_fixture_at_base_url_with_invocation_cwd_and_limits(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
    invocation_cwd: &Path,
    limits: ModelRequestResourceLimits,
    base_url: &str,
) -> (
    Result<ModelExecution, ModelRequestError>,
    Vec<ModelHttpRequest>,
    usize,
) {
    let catalog = ModelCatalog::bundled();
    let definition = catalog.find(model_id).expect("fixture exact Model");
    assert_eq!(definition.kind(), kind);
    let model = ResolvedModelRequestModel {
        model_id: model_id.to_owned(),
        request_model_id: definition.default_request_model_id().to_owned(),
        base_url: base_url.to_owned(),
        api_key: FIXTURE_API_KEY.to_owned(),
    };
    let transport = FixtureTransport {
        responses: Mutex::new(VecDeque::from(responses)),
        requests: Mutex::new(Vec::new()),
    };
    let cancellation = ModelRequestCancellation::default();
    let context = ExecutionContext::new_with_limits(
        &model,
        arguments,
        invocation_cwd,
        &cancellation,
        &transport,
        ModelRequestDeadline::after(Duration::from_secs(5)).expect("fixture deadline"),
        limits,
    )
    .expect("fixture context");
    let execution = execute_model(definition.executor(), context);
    let requests = transport.requests.into_inner().expect("fixture requests");
    let remaining = transport
        .responses
        .into_inner()
        .expect("fixture responses")
        .len();
    (execution, requests, remaining)
}

pub(crate) fn run_fixture(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
) -> (ModelExecution, Vec<ModelHttpRequest>) {
    let (execution, requests, remaining) = execute_fixture(kind, model_id, arguments, responses);
    assert_eq!(remaining, 0, "fixture responses must be consumed");
    (execution.expect("fixture execution"), requests)
}

pub(crate) fn execute_cancelling_fixture(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    responses: Vec<ModelHttpResponse>,
    cancel_on_request: usize,
) -> (
    Result<ModelExecution, ModelRequestError>,
    Vec<ModelHttpRequest>,
    usize,
) {
    let catalog = ModelCatalog::bundled();
    let definition = catalog.find(model_id).expect("fixture exact Model");
    assert_eq!(definition.kind(), kind);
    let model = ResolvedModelRequestModel {
        model_id: model_id.to_owned(),
        request_model_id: definition.default_request_model_id().to_owned(),
        base_url: "https://model.example/v1".to_owned(),
        api_key: FIXTURE_API_KEY.to_owned(),
    };
    let transport = CancellingFixtureTransport {
        responses: Mutex::new(VecDeque::from(responses)),
        requests: Mutex::new(Vec::new()),
        cancel_on_request,
    };
    let cancellation = ModelRequestCancellation::default();
    let context = ExecutionContext::new(
        &model,
        arguments,
        Path::new("."),
        &cancellation,
        &transport,
        ModelRequestDeadline::after(Duration::from_secs(5)).expect("fixture deadline"),
    )
    .expect("fixture context");
    let execution = execute_model(definition.executor(), context);
    let requests = transport.requests.into_inner().expect("fixture requests");
    let remaining = transport
        .responses
        .into_inner()
        .expect("fixture responses")
        .len();
    (execution, requests, remaining)
}

pub(crate) fn assert_first_request_preserves_remote_error(
    kind: ModelKind,
    model_id: &str,
    arguments: &Map<String, Value>,
    response: ModelHttpResponse,
    expected_markers: &[&str],
) {
    let expected_status = response.status;
    let (result, requests, remaining) = execute_fixture(kind, model_id, arguments, vec![response]);
    let error = result.expect_err("provider fixture must reject the request");
    assert_eq!(error.code(), "model_request_failed", "{model_id}");
    assert!(
        error.message().contains(&format!("HTTP {expected_status}")),
        "{model_id} did not preserve the remote HTTP status: {}",
        error.message()
    );
    for marker in expected_markers {
        assert!(
            error.message().contains(marker),
            "{model_id} did not preserve remote marker {marker:?}: {}",
            error.message()
        );
    }
    assert_eq!(requests.len(), 1, "{model_id} did not reach the provider");
    assert_eq!(remaining, 0, "{model_id} did not consume the response");
}

pub(crate) fn assert_model_endpoint_request(
    request: &ModelHttpRequest,
    expected_method: HttpMethod,
    expected_url: &str,
    auth_header: &str,
    auth_value: &str,
) {
    assert_eq!(request.method, expected_method);
    assert_eq!(request.url, expected_url);
    assert_eq!(
        request.headers.get(auth_header).map(String::as_str),
        Some(auth_value)
    );
}

pub(crate) fn assert_primary_model_request(
    execution: &ModelExecution,
    request: &ModelHttpRequest,
    expected_method: HttpMethod,
    expected_url: &str,
    auth_header: &str,
    auth_value: &str,
) {
    assert_model_endpoint_request(
        request,
        expected_method,
        expected_url,
        auth_header,
        auth_value,
    );
    let expected_safe_method = match expected_method {
        HttpMethod::Delete => "DELETE",
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
    };
    assert_eq!(execution.safe_request["method"], expected_safe_method);
    assert_eq!(execution.safe_request["url"], expected_url);
    assert_eq!(execution.safe_request["headers"][auth_header], "[REDACTED]");
    assert!(!execution.safe_request.to_string().contains(FIXTURE_API_KEY));
}

pub(crate) fn assert_public_download_request(request: &ModelHttpRequest, expected_url: &str) {
    assert_eq!(request.method, HttpMethod::Get);
    assert_eq!(request.url, expected_url);
    assert!(request.headers.is_empty());
}

pub(crate) fn assert_request_contains_unknown_sentinel(
    request: &ModelHttpRequest,
    key: &str,
    expected: &str,
) {
    fn json_contains(value: &Value, key: &str, expected: &str) -> bool {
        match value {
            Value::Array(values) => values
                .iter()
                .any(|value| json_contains(value, key, expected)),
            Value::Object(values) => values.iter().any(|(candidate, value)| {
                (candidate == key && value.as_str() == Some(expected))
                    || json_contains(value, key, expected)
            }),
            _ => false,
        }
    }

    let found = match &request.body {
        HttpBody::Json(body) => json_contains(body, key, expected),
        HttpBody::Multipart { fields, .. } => {
            fields.get(key).is_some_and(|value| value == expected)
        }
        HttpBody::Empty => false,
    };
    assert!(
        found,
        "unknown sentinel {key} was not preserved in the upstream request"
    );
}

pub(crate) fn assert_materialized_defaults(
    model_id: &str,
    mut arguments: Map<String, Value>,
    expected: Value,
) {
    let catalog = ModelCatalog::bundled();
    let schema = catalog
        .find(model_id)
        .expect("fixture exact Model")
        .arguments_schema();
    materialize_argument_defaults(model_id, schema, &mut arguments)
        .expect("fixture defaults must materialize");
    assert_eq!(Value::Object(arguments), expected);
}
