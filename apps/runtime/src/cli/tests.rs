use std::{fs, path::PathBuf, sync::Arc};

use futures_util::StreamExt as _;
use serde_json::json;
use uuid::Uuid;

use crate::{
    control::RuntimeControlState,
    workbench::{RuntimeCliHttpService, WorkbenchRuntimeServices},
};

use super::{
    CliCommandPolicy, RuntimeCliService, agent_record, command_errors, command_specs,
    parse_cli_args, progress_record,
};

#[test]
fn registry_exactly_matches_the_final_cli_matrix() {
    let commands = command_specs()
        .iter()
        .map(|spec| spec.command)
        .collect::<Vec<_>>();
    assert_eq!(
        commands,
        vec![
            "update",
            "runtime.status",
            "runtime.doctor",
            "runtime.stop",
            "skills.status",
            "models.image.list",
            "models.image.describe",
            "models.video.list",
            "models.video.describe",
            "models.tts.list",
            "models.tts.describe",
            "models.music.list",
            "models.music.describe",
            "models.sfx.list",
            "models.sfx.describe",
            "project.init",
            "project.status",
            "project.validate",
            "workbench.start",
            "canvas-map.push",
            "canvas.create",
            "canvas.rename",
            "canvas.delete",
            "canvas.reorder",
            "canvas.repair-index",
            "canvas.reset-layout",
            "generated-asset.lookup",
            "request.single",
            "request.batch",
            "operation.list",
            "operation.inspect",
            "operation.wait",
            "operation.cancel",
            "commands",
            "help",
        ]
    );
}

#[test]
fn command_inventory_includes_policy_transport_and_lifecycle_errors() {
    for spec in command_specs() {
        let errors = command_errors(spec.command)
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let expected = match spec.policy {
            CliCommandPolicy::Local => &[][..],
            CliCommandPolicy::Observe => &[
                "runtime_ready_timeout",
                "runtime_health_failed",
                "runtime_lost",
                "product_update_failed",
            ][..],
            CliCommandPolicy::Activate => &[
                "runtime_launch_failed",
                "runtime_ready_timeout",
                "runtime_health_failed",
                "product_update_failed",
            ][..],
            CliCommandPolicy::Stop => &[
                "runtime_not_running",
                "runtime_health_failed",
                "product_update_failed",
            ][..],
            CliCommandPolicy::Run | CliCommandPolicy::Submit | CliCommandPolicy::Stream => &[
                "runtime_launch_failed",
                "runtime_ready_timeout",
                "runtime_health_failed",
                "runtime_lost",
                "product_update_failed",
            ][..],
        };
        for error in expected {
            assert!(
                errors.iter().any(|actual| actual == error),
                "{} must publish {error}",
                spec.command
            );
        }
    }

    let workbench = command_errors("workbench.start");
    assert!(!workbench.contains("invalid_activation"));
    assert!(!workbench.contains("desktop_unavailable"));
}

#[test]
fn parser_accepts_the_final_request_and_operation_forms() {
    let single = parse_cli_args(&[
        "request".into(),
        "single".into(),
        "fixture-project".into(),
        "--input".into(),
        "request.jsonl".into(),
        "--timeout".into(),
        "10m".into(),
        "--replace".into(),
        "--no-wait".into(),
    ])
    .expect("single request form should parse");
    assert_eq!(single.command, "request.single");
    assert_eq!(
        single.options.get("input").map(String::as_str),
        Some("request.jsonl")
    );
    assert_eq!(
        single.options.get("timeout").map(String::as_str),
        Some("10m")
    );
    assert_eq!(
        single.options.get("replace").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        single.options.get("no-wait").map(String::as_str),
        Some("true")
    );

    let batch = parse_cli_args(&[
        "request".into(),
        "batch".into(),
        "fixture-project".into(),
        "--input".into(),
        "-".into(),
        "--concurrency".into(),
        "3".into(),
    ])
    .expect("batch request form should parse");
    assert_eq!(batch.command, "request.batch");
    assert_eq!(batch.options.get("input").map(String::as_str), Some("-"));
    assert_eq!(
        batch.options.get("concurrency").map(String::as_str),
        Some("3")
    );

    let list = parse_cli_args(&[
        "operation".into(),
        "list".into(),
        "--state".into(),
        "active".into(),
        "--model-kind".into(),
        "image".into(),
        "--project".into(),
        "fixture-project".into(),
        "--limit".into(),
        "25".into(),
        "--cursor".into(),
        "runtime-id:42".into(),
    ])
    .expect("operation list form should parse");
    assert_eq!(list.command, "operation.list");
    assert!(PathBuf::from(list.options.get("project").unwrap()).is_absolute());

    for command in ["inspect", "wait", "cancel"] {
        let parsed = parse_cli_args(&[
            "operation".into(),
            command.into(),
            "550e8400-e29b-41d4-a716-446655440000".into(),
        ])
        .unwrap_or_else(|error| panic!("operation {command} should parse: {error}"));
        assert_eq!(parsed.command, format!("operation.{command}"));
    }
}

#[test]
fn parser_enforces_registered_syntax_shapes() {
    let missing_name = parse_cli_args(&[
        "canvas".into(),
        "rename".into(),
        "project".into(),
        "canvas-1".into(),
    ])
    .unwrap_err();
    assert_eq!(missing_name.code(), "missing_argument");

    let unexpected = parse_cli_args(&["update".into(), "extra".into()]).unwrap_err();
    assert_eq!(unexpected.code(), "invalid_argument");

    let missing_required =
        parse_cli_args(&["request".into(), "single".into(), "project".into()]).unwrap_err();
    assert_eq!(missing_required.code(), "missing_argument");
    assert!(missing_required.message().contains("--input"));

    let invalid_allowed_value = parse_cli_args(&[
        "workbench".into(),
        "start".into(),
        "--frontend".into(),
        "terminal".into(),
    ])
    .unwrap_err();
    assert_eq!(invalid_allowed_value.code(), "invalid_input");

    for (option, value) in [("--state", "pending"), ("--model-kind", "audio")] {
        let invalid_operation_filter = parse_cli_args(&[
            "operation".into(),
            "list".into(),
            option.into(),
            value.into(),
        ])
        .unwrap_err();
        assert_eq!(invalid_operation_filter.code(), "invalid_input");
    }

    let repeated = parse_cli_args(&[
        "canvas".into(),
        "reset-layout".into(),
        "project".into(),
        "canvas-1".into(),
        "--path".into(),
        "first".into(),
        "--path".into(),
        "second".into(),
    ])
    .expect("repeatable path shape should parse");
    assert_eq!(
        repeated.options.get("path").unwrap(),
        r#"["first","second"]"#
    );
}

#[test]
fn agent_records_match_the_unversioned_golden_encoding() {
    let rendered = agent_record(&json!({
        "status": "ok",
        "command": "models.image.list",
        "records": [
            {"name": "model", "fields": {"id": "gpt-image-2", "parameters": "{\"prompt\":\"required\"}"}},
            {"name": "model", "fields": {"id": "gemini preview", "parameters": "{\"image_size\":\"1K|2K\"}"}}
        ],
        "fields": {"count": 2}
    }))
    .expect("record should render");
    assert_eq!(
        rendered,
        concat!(
            "debrute ok cmd=models.image.list\n",
            "model id=gpt-image-2 parameters=\"{\\\"prompt\\\":\\\"required\\\"}\"\n",
            "model id=\"gemini preview\" parameters=\"{\\\"image_size\\\":\\\"1K|2K\\\"}\"\n",
            "count=2"
        )
    );
    assert_eq!(
        progress_record(
            "request.batch",
            &json!({
                "event": "batch_item.settled",
                "records": [
                    {"name": "batch_item", "fields": {"item_index": 0, "model": "gpt-image-2", "status": "succeeded"}},
                    {"name": "artifact", "fields": {"artifact_index": 0, "role": "primary-image", "project_relative_path": "generated/cover.jpg", "mime_type": "image/jpeg"}}
                ]
            })
        )
        .expect("progress should render"),
        concat!(
            "debrute progress cmd=request.batch event=batch_item.settled\n",
            "batch_item item_index=0 model=gpt-image-2 status=succeeded\n",
            "artifact artifact_index=0 role=primary-image project_relative_path=generated/cover.jpg mime_type=image/jpeg"
        )
    );
}

#[test]
fn agent_errors_use_code_and_optional_log_without_a_message_field() {
    let rendered = agent_record(&json!({
        "status": "error",
        "command": "operation.wait",
        "code": "operation_failed",
        "log": "missing\u{1b}]52;c;AAAA\u{7}"
    }))
    .expect("record should render");
    assert_eq!(
        rendered,
        "debrute error cmd=operation.wait code=operation_failed\nlog=\"missing\\u001b]52;c;AAAA\\u0007\""
    );
}

#[test]
fn runtime_observation_reports_the_ready_native_tray_contract() {
    let fixture = CliFixture::new();
    for command in ["runtime.status", "runtime.doctor"] {
        let result = fixture
            .service
            .run(&json!({
                "command": command,
                "positional": [],
                "options": {}
            }))
            .expect("Runtime observation should run");
        assert_eq!(result["status"], "ok");
        assert_eq!(result["fields"]["runtime_state"], "ready");
        assert_eq!(result["fields"]["native_tray"], "active");
    }
}

#[test]
fn runtime_cli_service_owns_model_and_project_commands() {
    let fixture = CliFixture::new();
    let models = fixture
        .service
        .run(&json!({
            "command": "models.image.list",
            "positional": [],
            "options": {}
        }))
        .expect("model command should return a record");
    assert_eq!(models["status"], "ok");
    assert_eq!(models["command"], "models.image.list");
    assert_eq!(models["fields"]["count"], 0);

    let project = fixture.root.join("project");
    fs::create_dir(&project).expect("Project root should exist");
    let initialized = fixture
        .service
        .run(&json!({
            "command": "project.init",
            "positional": [project.to_string_lossy()],
            "options": {},
            "projectRoot": project.to_string_lossy()
        }))
        .expect("Project init should return a record");
    assert_eq!(initialized["status"], "ok", "{initialized}");
    assert_eq!(initialized["fields"]["canvases"], 1);
    assert!(project.join(".debrute/project.json").is_file());
}

#[test]
fn project_status_never_initializes_an_uninitialized_directory() {
    let fixture = CliFixture::new();
    let project = fixture.root.join("uninitialized-project");
    fs::create_dir(&project).expect("Project root should exist");
    let status = fixture
        .service
        .run(&json!({
            "command": "project.status",
            "positional": [project.to_string_lossy()],
            "options": {},
            "projectRoot": project.to_string_lossy()
        }))
        .expect("Project status business error should return");
    assert_eq!(status["status"], "error");
    assert_eq!(status["code"], "project_not_found");
    assert!(!project.join(".debrute").exists());
}

#[test]
fn model_describe_uses_the_request_command() {
    let fixture = CliFixture::new();
    let described = fixture
        .service
        .run(&json!({
            "command": "models.image.describe",
            "positional": ["gpt-image-2"],
            "options": {}
        }))
        .expect("model describe should return a record");
    assert_eq!(described["status"], "ok");
    let markdown = described["fields"]["description_markdown"]
        .as_str()
        .expect("description");
    assert!(markdown.contains("debrute request single <project>"));
}

#[test]
fn model_operation_submission_is_atomic_before_acceptance() {
    let fixture = CliFixture::new();
    let project = fixture.root.join("project");
    fs::create_dir_all(&project).unwrap();
    let initialized = fixture
        .service
        .run(&json!({
            "command": "project.init",
            "positional": [project.to_string_lossy()],
            "options": {},
            "projectRoot": project,
        }))
        .unwrap();
    assert_eq!(initialized["status"], "ok", "{initialized}");

    let rejected = fixture
        .service
        .submit(
            &json!({
                "command": "request.single",
                "positional": [project.to_string_lossy()],
                "options": {"input": "request.jsonl"},
                "projectRoot": project,
            }),
            br#"{"model":"missing-model","arguments":{}}"#,
        )
        .unwrap();
    assert_eq!(rejected["status"], "error");
    assert_eq!(rejected["code"], "model_unavailable");

    let absent = fixture.root.join("absent-project");
    let invalid_project = fixture
        .service
        .submit(
            &json!({
                "command": "request.single",
                "positional": [absent.to_string_lossy()],
                "options": {"input": "request.jsonl"},
                "projectRoot": absent,
            }),
            br#"{"model":"missing-model","arguments":{}}"#,
        )
        .unwrap();
    assert_eq!(invalid_project["status"], "error");
    assert_eq!(invalid_project["code"], "project_invalid");

    let listed = fixture
        .service
        .run(&json!({"command": "operation.list", "positional": [], "options": {}}))
        .unwrap();
    assert_eq!(listed["status"], "ok");
    assert_eq!(listed["records"].as_array().unwrap().len(), 0);
}

#[test]
fn runtime_cli_requires_both_argument_collections() {
    let fixture = CliFixture::new();
    for request in [
        json!({"command": "runtime.status", "options": {}}),
        json!({"command": "runtime.status", "positional": []}),
    ] {
        let error = fixture
            .service
            .run(&request)
            .expect_err("missing internal CLI collections must not be materialized");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "cli_request_invalid");
    }
}

#[test]
fn source_runtime_update_reports_product_unavailable() {
    let fixture = CliFixture::new();
    let result = fixture
        .service
        .run(&json!({"command": "update", "positional": [], "options": {}}))
        .expect("valid CLI request should produce one record");
    assert_eq!(result["status"], "error");
    assert_eq!(result["code"], "product_update_unavailable");
    assert!(command_errors("update").contains("product_update_unavailable"));
}

#[tokio::test]
async fn operation_wait_ends_when_its_control_credential_is_no_longer_live() {
    let fixture = CliFixture::new();
    let mut stream = fixture
        .service
        .run_stream(
            &json!({
                "command": "operation.wait",
                "positional": [Uuid::new_v4().to_string()],
                "options": {},
                "projectRoot": null,
            }),
            Arc::new(|| false),
        )
        .unwrap();
    let record = tokio::time::timeout(std::time::Duration::from_secs(1), stream.next())
        .await
        .expect("dead Control credential should end the observer promptly");
    assert!(record.is_none());
}

struct CliFixture {
    root: PathBuf,
    _services: Arc<WorkbenchRuntimeServices>,
    service: RuntimeCliService,
}

impl CliFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("debrute-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture root should exist");
        let state = Arc::new(RuntimeControlState::new("cli-fixture"));
        let services = WorkbenchRuntimeServices::compose(root.join("home"), state)
            .expect("Runtime services should compose");
        let service = RuntimeCliService::new(
            Arc::clone(services.models()),
            Arc::clone(services.global()),
            services.projects().clone(),
            Arc::clone(services.generated_assets()),
            Arc::clone(services.model_operations()),
            None,
            None,
        );
        Self {
            root,
            _services: services,
            service,
        }
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
