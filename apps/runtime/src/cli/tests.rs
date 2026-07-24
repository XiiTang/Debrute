use std::{fs, path::PathBuf, sync::Arc};

use futures_util::StreamExt as _;
use serde_json::json;
use uuid::Uuid;

use crate::{
    control::{RuntimeControlState, RuntimeStatus},
    workbench::{RuntimeCliHttpService, WorkbenchRuntimeServices},
};

use super::{RuntimeCliService, agent_record, command_specs, parse_cli_args, progress_record};

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
            "generate.image",
            "generate.image-batch",
            "generate.video",
            "generate.tts",
            "generate.music",
            "generate.sfx",
            "commands",
            "help",
        ]
    );
}

#[test]
fn parser_accepts_final_workbench_and_generation_forms() {
    let project = PathBuf::from("fixture-project");
    let parsed = parse_cli_args(&[
        "workbench".into(),
        "start".into(),
        project.to_string_lossy().into_owned(),
        "--frontend".into(),
        "browser".into(),
    ])
    .expect("workbench form should parse");
    assert_eq!(parsed.command, "workbench.start");
    assert_eq!(
        parsed.project_root,
        Some(
            std::env::current_dir()
                .expect("current directory")
                .join(project)
        )
    );
    assert_eq!(
        parsed.options.get("frontend").map(String::as_str),
        Some("browser")
    );

    let parsed = parse_cli_args(&[
        "generate".into(),
        "image-batch".into(),
        "fixture-project".into(),
        "--input-jsonl".into(),
        "requests.jsonl".into(),
        "--log".into(),
        "results.jsonl".into(),
        "--timeout-ms".into(),
        "900000".into(),
    ])
    .expect("image batch form should parse");
    assert_eq!(parsed.command, "generate.image-batch");
    assert_eq!(
        parsed.options.get("timeout-ms").map(String::as_str),
        Some("900000")
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
#[allow(clippy::too_many_lines)]
fn parser_accepts_one_canonical_form_for_every_registered_command() {
    let forms: &[&[&str]] = &[
        &["update"],
        &["runtime", "status"],
        &["runtime", "doctor"],
        &["runtime", "stop"],
        &["skills", "status"],
        &["models", "image", "list"],
        &["models", "image", "describe", "gpt-image-2"],
        &["models", "video", "list"],
        &["models", "video", "describe", "doubao-seedance-2-0-260128"],
        &["models", "tts", "list"],
        &["models", "tts", "describe", "openai-gpt-4o-mini-tts"],
        &["models", "music", "list"],
        &["models", "music", "describe", "elevenlabs-music"],
        &["models", "sfx", "list"],
        &["models", "sfx", "describe", "elevenlabs-sound-effects"],
        &["project", "init", "project"],
        &["project", "status", "project"],
        &["project", "validate", "project"],
        &["workbench", "start", "project", "--frontend", "desktop"],
        &["canvas-map", "push", "project", "canvas-1"],
        &["canvas", "create", "project"],
        &["canvas", "rename", "project", "canvas-1", "Cover"],
        &["canvas", "delete", "project", "canvas-1"],
        &["canvas", "reorder", "project", "canvas-2", "canvas-1"],
        &["canvas", "repair-index", "project"],
        &["canvas", "reset-layout", "project", "canvas-1", "--all"],
        &[
            "generated-asset",
            "lookup",
            "project",
            "--path",
            "generated/image.png",
        ],
        &[
            "generate",
            "image",
            "project",
            "--input-json",
            "{\"model\":\"gpt-image-2\",\"arguments\":{}}",
        ],
        &[
            "generate",
            "image-batch",
            "project",
            "--manifest",
            "batch.json",
            "--log",
            "results.jsonl",
        ],
        &[
            "generate",
            "video",
            "project",
            "--input-json",
            "{\"model\":\"video\",\"arguments\":{}}",
        ],
        &[
            "generate",
            "tts",
            "project",
            "--input-json",
            "{\"model\":\"tts\",\"arguments\":{}}",
        ],
        &[
            "generate",
            "music",
            "project",
            "--input-json",
            "{\"model\":\"music\",\"arguments\":{}}",
        ],
        &[
            "generate",
            "sfx",
            "project",
            "--input-json",
            "{\"model\":\"sfx\",\"arguments\":{}}",
        ],
        &["commands"],
        &["help", "generate", "image-batch"],
    ];
    assert_eq!(forms.len(), command_specs().len());
    for (form, spec) in forms.iter().zip(command_specs()) {
        let argv = form
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let parsed = parse_cli_args(&argv)
            .unwrap_or_else(|error| panic!("canonical form for {} failed: {error}", spec.command));
        assert_eq!(parsed.command, spec.command);
        if spec.command != "help" {
            let help = std::iter::once("help".to_owned())
                .chain(spec.path.iter().map(|value| (*value).to_owned()))
                .collect::<Vec<_>>();
            assert_eq!(
                parse_cli_args(&help)
                    .expect("help form should parse")
                    .command,
                "help"
            );
        }
    }
}

#[test]
fn parser_rejects_two_batch_sources() {
    let ambiguous = parse_cli_args(&[
        "generate".into(),
        "image-batch".into(),
        "fixture-project".into(),
        "--manifest".into(),
        "batch.yaml".into(),
        "--input-jsonl".into(),
        "batch.jsonl".into(),
        "--log".into(),
        "results.jsonl".into(),
    ])
    .expect_err("two batch sources must reject");
    assert_eq!(ambiguous.code(), "invalid_input");
}

#[test]
fn agent_records_match_the_stable_golden_encoding() {
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
            "debrute/1 ok cmd=models.image.list\n",
            "model id=gpt-image-2 parameters=\"{\\\"prompt\\\":\\\"required\\\"}\"\n",
            "model id=\"gemini preview\" parameters=\"{\\\"image_size\\\":\\\"1K|2K\\\"}\"\n",
            "count=2"
        )
    );
    assert_eq!(
        progress_record(
            "generate.image-batch",
            &json!({"total": 10, "done": 1, "note": "ten percent"})
        )
        .expect("progress should render"),
        "debrute/1 progress cmd=generate.image-batch total=10 done=1 note=\"ten percent\""
    );
}

#[test]
fn agent_records_escape_terminal_control_characters() {
    let rendered = agent_record(&json!({
        "status": "error",
        "command": "project.status",
        "code": "project_not_found",
        "message": "missing\u{1b}]52;c;AAAA\u{7}"
    }))
    .expect("record should render");
    assert_eq!(
        rendered,
        "debrute/1 error cmd=project.status code=project_not_found\nmessage=\"missing\\u001b]52;c;AAAA\\u0007\""
    );
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
    assert_eq!(initialized["status"], "ok");
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
fn runtime_cli_service_returns_closed_business_errors_without_http_failure() {
    let fixture = CliFixture::new();
    let unsupported = fixture
        .service
        .run(&json!({
            "command": "retired.status",
            "positional": [],
            "options": {}
        }))
        .expect("business error should remain a successful bridge response");
    assert_eq!(unsupported["status"], "error");
    assert_eq!(unsupported["code"], "invalid_command");

    fixture.initialize_project(&fixture.root);

    let malformed = fixture
        .service
        .run(&json!({
            "command": "generate.image",
            "positional": [fixture.root.to_string_lossy()],
            "options": {"input-json": "not-json"},
            "projectRoot": fixture.root.to_string_lossy()
        }))
        .expect("input failure should remain a successful bridge response");
    assert_eq!(malformed["status"], "error");
    assert_eq!(malformed["code"], "invalid_json_input");

    let invalid_timeout = fixture
        .service
        .run(&json!({
            "command": "generate.image",
            "positional": [fixture.root.to_string_lossy()],
            "options": {"input-json": "{\"model\":\"gpt-image-2\",\"arguments\":{},\"timeoutMs\":0}"},
            "projectRoot": fixture.root.to_string_lossy()
        }))
        .expect("input failure should remain a successful bridge response");
    assert_eq!(invalid_timeout["status"], "error");
    assert_eq!(invalid_timeout["code"], "invalid_input");
}

#[test]
fn audio_describe_and_generation_errors_keep_the_public_cli_taxonomy() {
    let fixture = CliFixture::new();
    let unavailable = fixture
        .service
        .run(&json!({
            "command": "models.tts.describe",
            "positional": ["missing-audio-model"],
            "options": {}
        }))
        .expect("business error should return");
    assert_eq!(unavailable["code"], "audio_model_unavailable");
    assert_eq!(
        super::service::normalize_generation_error(
            crate::generation::GenerationKind::Tts,
            "model_not_configured"
        ),
        "audio_model_not_configured"
    );
    assert_eq!(
        super::service::normalize_generation_error(
            crate::generation::GenerationKind::Image,
            "generation_timeout"
        ),
        "model_request_failed"
    );
}

#[test]
fn model_describe_uses_the_bundled_official_snapshot() {
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
    assert_eq!(described["records"][1]["name"], "official_doc");
    assert_eq!(
        described["records"][1]["fields"]["captured_at"],
        "2026-05-31"
    );
    assert!(
        described["records"][1]["fields"]["snapshot"]
            .as_str()
            .is_some_and(|path| { path.starts_with("model-docs/snapshots/image/") })
    );
    let markdown = described["fields"]["description_markdown"]
        .as_str()
        .expect("description");
    assert!(markdown.contains("Official documentation:"));
    assert!(markdown.contains("debrute generate image <project>"));
    assert!(!markdown.contains("Runtime model documentation is bundled"));
}

#[test]
fn image_batch_stream_executes_each_item_once_and_finishes_with_one_result() {
    let fixture = CliFixture::new();
    let project = fixture.root.join("batch-project");
    fs::create_dir(&project).expect("Project root should exist");
    fixture.initialize_project(&project);
    fs::write(
        project.join("requests.jsonl"),
        "{\"model\":\"gpt-image-2\",\"arguments\":{\"prompt\":\"cover\"}}\n",
    )
    .expect("batch source should be written");
    let stream = fixture
        .service
        .run_stream(&json!({
            "command": "generate.image-batch",
            "positional": [project.to_string_lossy()],
            "options": {"input-jsonl": "requests.jsonl", "log": "logs/results.jsonl"},
            "projectRoot": project.to_string_lossy()
        }))
        .expect("batch stream should be accepted");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test runtime");
    let events = runtime.block_on(stream.collect::<Vec<_>>());
    assert_eq!(
        events.first().and_then(|event| event["type"].as_str()),
        Some("progress")
    );
    let result = &events.last().expect("final event")["result"];
    assert_eq!(result["status"], "ok");
    assert_eq!(result["fields"]["total"], 1);
    assert_eq!(result["fields"]["failed"], 1);
    let log = fs::read_to_string(project.join("logs/results.jsonl")).expect("batch log");
    assert_eq!(log.lines().count(), 1);
    assert!(log.contains("model_not_configured"));
}

struct CliFixture {
    root: PathBuf,
    service: RuntimeCliService,
}

impl CliFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("debrute-cli-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture root should exist");
        let state = Arc::new(RuntimeControlState::new(
            "cli-fixture",
            RuntimeStatus::Starting,
        ));
        let services = WorkbenchRuntimeServices::compose(root.join("home"), state)
            .expect("Runtime services should compose");
        let service = RuntimeCliService::new(services);
        Self { root, service }
    }

    fn initialize_project(&self, project: &std::path::Path) {
        let result = self
            .service
            .run(&json!({
                "command": "project.init",
                "positional": [project.to_string_lossy()],
                "options": {},
                "projectRoot": project.to_string_lossy()
            }))
            .expect("Project init should run");
        assert_eq!(result["status"], "ok");
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
