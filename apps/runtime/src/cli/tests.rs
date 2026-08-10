use std::{fs, path::PathBuf, sync::Arc};

use futures_util::StreamExt as _;
use serde_json::json;
use uuid::Uuid;

use crate::{
    control::RuntimeControlState,
    workbench::{RuntimeCliHttpService, WorkbenchRuntimeServices},
};

use super::{
    CliCommandPolicy, CliProgress, CliResult, RuntimeCliService, agent_record, command_errors,
    command_specs, parse_cli_args, progress_record,
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
            "runtime.status",
            "runtime.stop",
            "product.uninstall",
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
            "project.status",
            "project.validate",
            "workbench.start",
            "workbench.url",
            "model-artifact.lookup",
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
            CliCommandPolicy::Activate | CliCommandPolicy::Resolve => &[
                "runtime_launch_failed",
                "runtime_ready_timeout",
                "runtime_health_failed",
                "product_update_failed",
            ][..],
            CliCommandPolicy::Stop | CliCommandPolicy::Remove => &[
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

    for command in ["workbench.start", "workbench.url"] {
        let errors = command_errors(command);
        assert!(!errors.contains("invalid_activation"));
        assert!(!errors.contains("desktop_unavailable"));
        assert!(!errors.contains("project_not_found"));
        assert!(!errors.contains("project_invalid"));
        assert!(!errors.contains("project_root_invalid"));
    }
}

#[test]
fn product_uninstall_requires_explicit_yes_and_accepts_only_the_config_preservation_flag() {
    let missing = parse_cli_args(&["product".into(), "uninstall".into()]).unwrap_err();
    assert_eq!(missing.code(), "missing_argument");

    let parsed = parse_cli_args(&[
        "product".into(),
        "uninstall".into(),
        "--yes".into(),
        "--keep-config".into(),
    ])
    .unwrap();
    assert_eq!(parsed.command, "product.uninstall");
    assert_eq!(parsed.policy, CliCommandPolicy::Remove);
    assert_eq!(parsed.options.get("yes").map(String::as_str), Some("true"));
    assert_eq!(
        parsed.options.get("keep-config").map(String::as_str),
        Some("true")
    );
}

#[test]
fn parser_accepts_the_final_request_and_operation_forms() {
    let single = parse_cli_args(&[
        "request".into(),
        "single".into(),
        "--input".into(),
        "request.jsonl".into(),
        "--timeout".into(),
        "10m".into(),
        "--replace".into(),
        "--no-wait".into(),
    ])
    .expect("single request form should parse");
    assert_eq!(single.command, "request.single");
    assert!(single.root.is_none());
    assert!(single.cwd.is_absolute());
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
        "--limit".into(),
        "25".into(),
        "--cursor".into(),
        "runtime-id:42".into(),
    ])
    .expect("operation list form should parse");
    assert_eq!(list.command, "operation.list");

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
    let unexpected =
        parse_cli_args(&["runtime".into(), "status".into(), "extra".into()]).unwrap_err();
    assert_eq!(unexpected.code(), "invalid_argument");

    let missing_required = parse_cli_args(&["request".into(), "single".into()]).unwrap_err();
    assert_eq!(missing_required.code(), "missing_argument");
    assert!(missing_required.message().contains("--input or all of"));

    let conflicting_sources = parse_cli_args(&[
        "request".into(),
        "single".into(),
        "--input".into(),
        "request.jsonl".into(),
        "--model".into(),
        "gpt-image-2".into(),
    ])
    .unwrap_err();
    assert_eq!(conflicting_sources.code(), "conflicting_request_sources");

    let invalid_allowed_value = parse_cli_args(&[
        "workbench".into(),
        "start".into(),
        "--frontend".into(),
        "terminal".into(),
    ])
    .unwrap_err();
    assert_eq!(invalid_allowed_value.code(), "invalid_input");

    let missing_frontend = parse_cli_args(&["workbench".into(), "start".into()]).unwrap_err();
    assert_eq!(missing_frontend.code(), "missing_argument");
    assert!(missing_frontend.message().contains("--frontend"));

    for frontend in ["desktop", "browser"] {
        let parsed = parse_cli_args(&[
            "workbench".into(),
            "start".into(),
            "--frontend".into(),
            frontend.into(),
        ])
        .unwrap_or_else(|error| panic!("explicit {frontend} frontend should parse: {error}"));
        assert_eq!(
            parsed.options.get("frontend").map(String::as_str),
            Some(frontend)
        );
    }

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
}

#[test]
fn parser_accepts_an_optional_unchecked_workbench_url_root() {
    let rootless = parse_cli_args(&["workbench".into(), "url".into()])
        .expect("Root Workbench URL form should parse");
    assert_eq!(rootless.policy, CliCommandPolicy::Resolve);
    assert!(rootless.root.is_none());

    let project = parse_cli_args(&[
        "workbench".into(),
        "url".into(),
        "does-not-need-to-exist".into(),
    ])
    .expect("Project Workbench URL form should parse without filesystem admission");
    assert_eq!(
        project.root,
        Some(project.cwd.join("does-not-need-to-exist"))
    );

    let extra = parse_cli_args(&["workbench".into(), "url".into(), "one".into(), "two".into()])
        .expect_err("workbench.url accepts at most one Project root");
    assert_eq!(extra.code(), "invalid_argument");

    let option = parse_cli_args(&[
        "workbench".into(),
        "url".into(),
        "--frontend".into(),
        "browser".into(),
    ])
    .expect_err("workbench.url has no frontend option");
    assert_eq!(option.code(), "invalid_argument");
}

#[test]
fn workbench_url_command_is_read_only_url_resolution() {
    let spec = command_specs()
        .iter()
        .find(|spec| spec.command == "workbench.url")
        .expect("workbench.url should be registered");
    assert_eq!(spec.policy, CliCommandPolicy::Resolve);
    assert_eq!(spec.scope, "runtime");
    assert_eq!(spec.risk, "read");
    assert_eq!(spec.writes, "none");
    assert_eq!(spec.output, "Workbench URL record");
    assert!(spec.options.is_empty());
}

#[test]
fn agent_records_match_the_unversioned_golden_encoding() {
    let rendered = agent_record(&serde_json::from_value::<CliResult>(json!({
        "status": "ok",
        "command": "models.image.list",
        "records": [
            {"name": "model", "fields": {"id": "gpt-image-2", "summary": "Exact output-size constraints."}},
            {"name": "model", "fields": {"id": "gemini preview", "summary": "Up to ten reference images."}}
        ],
        "fields": {"count": 2}
    }))
    .expect("closed result"));
    assert_eq!(
        rendered,
        concat!(
            "debrute ok cmd=models.image.list\n",
            "model id=gpt-image-2 summary=\"Exact output-size constraints.\"\n",
            "model id=\"gemini preview\" summary=\"Up to ten reference images.\"\n",
            "count=2"
        )
    );
    assert_eq!(
        progress_record(
            "request.batch",
            &serde_json::from_value::<CliProgress>(json!({
                "event": "batch_item.settled",
                "records": [
                    {"name": "batch_item", "fields": {"item_index": 0, "model": "gpt-image-2", "status": "succeeded"}},
                    {"name": "artifact", "fields": {"artifact_index": 0, "output_path": "/project/generated/cover.jpg", "mime_type": "image/jpeg"}}
                ]
            })).expect("closed progress")
        ),
        concat!(
            "debrute progress cmd=request.batch event=batch_item.settled\n",
            "batch_item item_index=0 model=gpt-image-2 status=succeeded\n",
            "artifact artifact_index=0 output_path=/project/generated/cover.jpg mime_type=image/jpeg"
        )
    );
}

#[test]
fn workbench_url_agent_record_contains_only_the_url_field() {
    let rendered = agent_record(
        &serde_json::from_value::<CliResult>(json!({
            "status": "ok",
            "command": "workbench.url",
            "fields": {
                "url": "http://127.0.0.1:17321/open?path=%2FReference+Projects"
            }
        }))
        .expect("closed result"),
    );
    assert_eq!(
        rendered,
        concat!(
            "debrute ok cmd=workbench.url\n",
            "url=\"http://127.0.0.1:17321/open?path=%2FReference+Projects\""
        )
    );
}

#[test]
fn agent_errors_use_code_and_optional_log_without_a_message_field() {
    let rendered = agent_record(
        &serde_json::from_value::<CliResult>(json!({
            "status": "error",
            "command": "operation.wait",
            "code": "operation_failed",
            "log": "missing\u{1b}]52;c;AAAA\u{7}"
        }))
        .expect("closed result"),
    );
    assert_eq!(
        rendered,
        "debrute error cmd=operation.wait code=operation_failed\nlog=\"missing\\u001b]52;c;AAAA\\u0007\""
    );
}

#[test]
fn runtime_status_reports_only_the_lifecycle_state() {
    let fixture = CliFixture::new();
    let result = fixture
        .service
        .run(&json!({
            "command": "runtime.status",
            "positional": [],
            "options": {},
            "cwd": fixture.root
        }))
        .expect("Runtime observation should run");
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["status"], "ok");
    assert_eq!(result["fields"], json!({"runtime_state": "ready"}));
}

#[test]
fn runtime_cli_service_owns_model_and_project_commands() {
    let fixture = CliFixture::new();
    let models = fixture
        .service
        .run(&json!({
            "command": "models.image.list",
            "positional": [],
            "options": {},
            "cwd": fixture.root
        }))
        .expect("model command should return a record");
    let models = serde_json::to_value(models).unwrap();
    assert_eq!(models["status"], "ok");
    assert_eq!(models["command"], "models.image.list");
    assert_eq!(models["fields"]["count"], 0);

    let project = fixture.root.join("project");
    fs::create_dir(&project).expect("Project root should exist");
    let opened = fixture
        .service
        .run(&json!({
            "command": "project.status",
            "positional": [project.to_string_lossy()],
            "options": {},
            "root": project.to_string_lossy(),
            "cwd": fixture.root
        }))
        .expect("Project status should return a record");
    let opened = serde_json::to_value(opened).unwrap();
    assert_eq!(opened["status"], "ok", "{opened}");
}

#[test]
fn project_validate_is_read_only_for_sparse_canvas_state() {
    let fixture = CliFixture::new();
    let project = fixture.root.join("validation-project");
    fs::create_dir(&project).expect("Project root should exist");
    let opened = fixture
        .service
        .run(&json!({
            "command": "project.status",
            "positional": [project.to_string_lossy()],
            "options": {},
            "root": project,
            "cwd": fixture.root
        }))
        .expect("Project status should return");
    let opened = serde_json::to_value(opened).unwrap();
    assert_eq!(opened["status"], "ok", "{opened}");
    let canonical_root = project
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let canvas_path =
        crate::global::root_state_directory(&fixture.root.join("home"), &canonical_root)
            .join("canvas.json");
    let before = fs::read_to_string(&canvas_path).expect("Canvas state should exist");

    let validated = fixture
        .service
        .run(&json!({
            "command": "project.validate",
            "positional": [project.to_string_lossy()],
            "options": {},
            "root": project,
            "cwd": fixture.root
        }))
        .expect("Project validation should return");
    let validated = serde_json::to_value(validated).unwrap();

    assert_eq!(validated["status"], "ok", "{validated}");
    assert_eq!(validated["fields"]["warnings"], 0);
    assert_eq!(fs::read_to_string(canvas_path).unwrap(), before);
}

#[test]
fn model_list_returns_only_configured_exact_model_summaries() {
    let fixture = CliFixture::new();
    fixture.configure_model("gpt-image-2");
    fixture.configure_model("minimax-h3");

    let listed = fixture
        .service
        .run(&json!({
            "command": "models.image.list",
            "positional": [],
            "options": {},
            "cwd": fixture.root
        }))
        .expect("model list should return configured exact Models");
    let listed = serde_json::to_value(listed).unwrap();
    assert_eq!(listed["fields"], json!({"count": 1}));
    assert_eq!(listed["records"].as_array().unwrap().len(), 1);
    let model = &listed["records"][0];
    assert_eq!(model["name"], "model");
    assert_eq!(model["fields"]["id"], "gpt-image-2");
    assert!(
        model["fields"]["summary"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(
        model["fields"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["id", "summary"]
    );
}

#[test]
fn model_describe_returns_only_the_exact_definition_contract() {
    let fixture = CliFixture::new();
    let described = fixture
        .service
        .run(&json!({
            "command": "models.image.describe",
            "positional": ["gpt-image-2"],
            "options": {},
            "cwd": fixture.root
        }))
        .expect("model describe should return a record");
    let described = serde_json::to_value(described).unwrap();
    assert_eq!(described["status"], "ok");
    assert_eq!(
        described["records"],
        json!([{
            "name": "model",
            "fields": {"id": "gpt-image-2"}
        }])
    );
    assert_eq!(
        described["fields"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["arguments_schema", "manual_markdown"]
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(
            described["fields"]["arguments_schema"]
                .as_str()
                .expect("schema")
        )
        .expect("arguments schema should remain JSON")
        .is_object()
    );
    let markdown = described["fields"]["manual_markdown"]
        .as_str()
        .expect("manual");
    assert!(markdown.contains("gpt-image-2"));
}

#[test]
fn model_operation_submission_is_atomic_before_acceptance() {
    let fixture = CliFixture::new();
    let project = fixture.root.join("project");
    fs::create_dir_all(&project).unwrap();
    let rejected = fixture
        .service
        .submit(
            &json!({
                "command": "request.single",
                "positional": [],
                "options": {"input": "request.jsonl"},
                "root": null,
                "cwd": project,
            }),
            br#"{"model":"missing-model","arguments":{},"output":{"directory":"generated","name":"artifact"}}"#,
        )
        .unwrap();
    let rejected = serde_json::to_value(rejected).unwrap();
    assert_eq!(rejected["status"], "error");
    assert_eq!(rejected["code"], "model_unavailable");

    let listed = fixture
        .service
        .run(&json!({
            "command": "operation.list",
            "positional": [],
            "options": {},
            "cwd": fixture.root
        }))
        .unwrap();
    assert_eq!(listed.error_code(), None);
    assert!(listed.records().is_empty());
}

#[test]
fn runtime_cli_requires_both_argument_collections() {
    let fixture = CliFixture::new();
    for request in [
        json!({"command": "runtime.status", "options": {}, "cwd": fixture.root}),
        json!({"command": "runtime.status", "positional": [], "cwd": fixture.root}),
    ] {
        let error = fixture
            .service
            .run(&request)
            .expect_err("missing internal CLI collections must not be materialized");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "cli_request_invalid");
    }
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
                "root": null,
                "cwd": fixture.root,
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
        let services = WorkbenchRuntimeServices::compose(
            root.join("home"),
            state,
            crate::project::CanvasVideoToolPaths::for_tests(),
        )
        .expect("Runtime services should compose");
        let service = RuntimeCliService::new(
            Arc::clone(services.models()),
            Arc::clone(services.global()),
            services.projects().clone(),
            Arc::clone(services.provenance()),
            Arc::clone(services.model_operations()),
            None,
        );
        Self {
            root,
            _services: services,
            service,
        }
    }

    fn configure_model(&self, model_id: &str) {
        self._services
            .global()
            .settings_mutate(
                &serde_json::from_value(json!({
                    "operation": "save-model-setting",
                    "modelId": model_id,
                    "setting": {
                        "baseUrlOverride": null,
                        "requestModelIdOverride": null,
                        "apiKey": format!("test-key-{model_id}")
                    }
                }))
                .expect("fixture should contain a valid Global Settings intent"),
            )
            .expect("fixture Model should be configured");
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
