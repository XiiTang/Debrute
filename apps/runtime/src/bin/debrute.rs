#![allow(clippy::needless_pass_by_value, clippy::too_many_lines)]

use std::{
    error::Error,
    path::PathBuf,
    process::{Command, ExitCode, Stdio},
    time::{Duration, Instant},
};

use debrute_runtime::{
    cli::{
        CliCommandPolicy, CliParseError, ParsedCliCommand, agent_record, command_errors,
        command_spec, command_specs, parse_cli_args, progress_record,
    },
    control::{
        ActivationIntent, ActivationOutcome, ClientRole, ControlErrorCode, ControlRequest,
        ControlResponse, NativeControlClient, ProjectFrontend, RuntimeStatus,
        endpoint::ControlEndpointAdapter,
    },
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use debrute_runtime::control::endpoint::MacOsControlEndpoint as PlatformControlEndpoint;
#[cfg(target_os = "windows")]
use debrute_runtime::control::endpoint::WindowsControlEndpoint as PlatformControlEndpoint;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
const RUNTIME_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const RUNTIME_ENTRYPOINT_ENV: &str = "DEBRUTE_RUNTIME_STABLE_ENTRYPOINT";

fn main() -> ExitCode {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && matches!(arguments[0].as_str(), "--version" | "-v") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            print_result(&failure(
                "internal_error",
                "internal_error",
                &error.to_string(),
                json!({}),
            ));
            return ExitCode::from(5);
        }
    };
    let result = match parse_cli_args(&arguments) {
        Ok(parsed) => runtime.block_on(run(parsed)),
        Err(error) => Err(parse_failure(&error)),
    };
    match result {
        Ok(result) => {
            let code = exit_code_for_result(&result);
            print_result(&result);
            ExitCode::from(code)
        }
        Err(error) => {
            let result = failure(
                &error.command,
                &error.code,
                &error.message,
                Value::Object(error.fields),
            );
            let code = exit_code_for_result(&result);
            print_result(&result);
            ExitCode::from(code)
        }
    }
}

async fn run(parsed: ParsedCliCommand) -> Result<Value, CliRunError> {
    match parsed.policy {
        CliCommandPolicy::Local => run_local(&parsed),
        CliCommandPolicy::Observe => run_observe(&parsed).await,
        CliCommandPolicy::Activate => run_activate(&parsed),
        CliCommandPolicy::Stop => run_stop(&parsed),
        CliCommandPolicy::Run => run_http(&parsed, false).await,
        CliCommandPolicy::Stream => run_http(&parsed, true).await,
    }
}

fn run_local(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    if parsed.command == "commands" {
        let records = command_specs().iter().map(spec_record).collect::<Vec<_>>();
        return Ok(json!({
            "status": "ok", "command": "commands", "records": records,
            "fields": {"count": command_specs().len()}
        }));
    }
    if parsed.command == "help" {
        let spec = command_spec(&parsed.positional).ok_or_else(|| {
            CliRunError::new(
                parsed.command,
                "invalid_command",
                format!(
                    "Unknown Debrute CLI command: {}",
                    parsed.positional.join(" ")
                ),
            )
        })?;
        return Ok(json!({
            "status": "ok", "command": "help", "records": [spec_record(spec)]
        }));
    }
    Err(CliRunError::new(
        parsed.command,
        "invalid_command",
        "Command is not local.",
    ))
}

async fn run_observe(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    let Some(mut client) = connect_existing()? else {
        return Ok(stopped_observe_result(parsed.command));
    };
    match client.status() {
        RuntimeStatus::Ready => {
            let (origin, authorization) = create_cli_authorization(&mut client)?;
            let result = post_command(parsed, &origin, &authorization, false).await;
            drop(client);
            result
        }
        phase => Ok(transitioning_observe_result(
            parsed.command,
            phase,
            client.instance_id(),
        )),
    }
}

fn run_activate(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    let mut client = ensure_runtime()?;
    let frontend = parsed
        .options
        .get("frontend")
        .map_or("default", String::as_str);
    let intent = match (&parsed.project_root, frontend) {
        (None, "default") => ActivationIntent::OpenDefaultFrontend,
        (None, "desktop") => ActivationIntent::OpenDesktop,
        (None, "browser") => ActivationIntent::OpenBrowser,
        (Some(project_root), frontend) => ActivationIntent::OpenProject {
            project_root: project_root.to_string_lossy().into_owned(),
            frontend: match frontend {
                "default" => ProjectFrontend::Default,
                "desktop" => ProjectFrontend::Desktop,
                "browser" => ProjectFrontend::Browser,
                _ => {
                    return Err(CliRunError::new(
                        parsed.command,
                        "invalid_input",
                        "--frontend must be one of default, desktop, or browser.",
                    ));
                }
            },
        },
        (None, _) => {
            return Err(CliRunError::new(
                parsed.command,
                "invalid_input",
                "--frontend must be one of default, desktop, or browser.",
            ));
        }
    };
    let response = client
        .wait_ready_and_request(
            Uuid::new_v4().to_string(),
            ControlRequest::Activate { intent },
        )
        .map_err(|error| control_failure(parsed.command, &error))?;
    match response {
        ControlResponse::Activation { outcome } => Ok(json!({
            "status": "ok",
            "command": parsed.command,
            "fields": {
                "frontend": frontend,
                "target": parsed.project_root.as_ref().map_or_else(
                    || "root".to_owned(),
                    |path| path.to_string_lossy().into_owned()
                ),
                "outcome": activation_outcome(outcome)
            }
        })),
        ControlResponse::Rejected { code } => Err(rejected_failure(parsed.command, code)),
        _ => Err(CliRunError::new(
            parsed.command,
            "runtime_health_failed",
            "Runtime returned an unexpected activation response.",
        )),
    }
}

fn run_stop(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    let Some(mut client) = connect_existing()? else {
        return Err(CliRunError::new(
            parsed.command,
            "runtime_not_running",
            "Debrute Runtime is not running.",
        ));
    };
    let response = client
        .wait_ready_and_request(Uuid::new_v4().to_string(), ControlRequest::QuitProduct)
        .map_err(|error| control_failure(parsed.command, &error))?;
    match response {
        ControlResponse::Ok => Ok(json!({
            "status": "ok",
            "command": parsed.command,
            "fields": {"accepted": true}
        })),
        ControlResponse::Rejected { code } => Err(rejected_failure(parsed.command, code)),
        _ => Err(CliRunError::new(
            parsed.command,
            "runtime_health_failed",
            "Runtime returned an unexpected Product Quit response.",
        )),
    }
}

async fn run_http(parsed: &ParsedCliCommand, stream: bool) -> Result<Value, CliRunError> {
    let mut control = ensure_runtime()?;
    let (origin, authorization) = create_cli_authorization(&mut control)?;
    // `control` intentionally remains live until the HTTP command completes;
    // Runtime revokes this bearer authorization when the native connection closes.
    let result = post_command(parsed, &origin, &authorization, stream).await;
    drop(control);
    result
}

async fn post_command(
    parsed: &ParsedCliCommand,
    origin: &str,
    authorization: &str,
    stream: bool,
) -> Result<Value, CliRunError> {
    let request = json!({
        "command": parsed.command,
        "positional": parsed.positional,
        "options": parsed.options,
        "projectRoot": parsed.project_root.as_ref().map(|path| path.to_string_lossy().into_owned())
    });
    let route = if stream {
        "/api/cli/run-stream"
    } else {
        "/api/cli/run"
    };
    let mut response = reqwest::Client::new()
        .post(format!("{origin}{route}"))
        .bearer_auth(authorization)
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            CliRunError::new(parsed.command, "runtime_health_failed", error.to_string())
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.json::<Value>().await.map_err(|error| {
            CliRunError::new(
                parsed.command,
                "runtime_health_failed",
                format!("Runtime CLI bridge returned an invalid error response: {error}"),
            )
        })?;
        let code = body
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("runtime_health_failed");
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map_or_else(
                || format!("Runtime CLI bridge failed: {status}"),
                str::to_owned,
            );
        return Err(CliRunError::new(
            parsed.command,
            normalize_http_error(code),
            message,
        ));
    }
    if !stream {
        return response.json::<Value>().await.map_err(|error| {
            CliRunError::new(parsed.command, "runtime_health_failed", error.to_string())
        });
    }
    let mut buffer = Vec::new();
    let mut result = None;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        CliRunError::new(parsed.command, "runtime_health_failed", error.to_string())
    })? {
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = buffer.drain(..=newline).collect::<Vec<_>>();
            let line = &line[..line.len().saturating_sub(1)];
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            consume_stream_event(
                parsed.command,
                serde_json::from_slice(line).map_err(|error| {
                    CliRunError::new(parsed.command, "runtime_health_failed", error.to_string())
                })?,
                &mut result,
            )?;
        }
    }
    if buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
        consume_stream_event(
            parsed.command,
            serde_json::from_slice(&buffer).map_err(|error| {
                CliRunError::new(parsed.command, "runtime_health_failed", error.to_string())
            })?,
            &mut result,
        )?;
    }
    result.ok_or_else(|| {
        CliRunError::new(
            parsed.command,
            "runtime_health_failed",
            "Runtime CLI stream ended without a final result.",
        )
    })
}

fn consume_stream_event(
    command: &str,
    event: Value,
    result: &mut Option<Value>,
) -> Result<(), CliRunError> {
    match event.get("type").and_then(Value::as_str) {
        Some("progress") => {
            let fields = event.get("fields").ok_or_else(|| {
                CliRunError::new(
                    command,
                    "runtime_health_failed",
                    "CLI progress fields are missing.",
                )
            })?;
            println!(
                "{}",
                progress_record(command, fields).map_err(|error| {
                    CliRunError::new(command, "internal_error", error.to_string())
                })?
            );
            Ok(())
        }
        Some("result") => {
            if result.is_some() {
                return Err(CliRunError::new(
                    command,
                    "runtime_health_failed",
                    "Runtime sent multiple final CLI results.",
                ));
            }
            *result = event.get("result").cloned();
            Ok(())
        }
        _ => Err(CliRunError::new(
            command,
            "runtime_health_failed",
            "Runtime sent an unknown CLI stream event.",
        )),
    }
}

fn spec_record(spec: &debrute_runtime::cli::CliCommandSpec) -> Value {
    json!({"name": "command", "fields": {
        "name": spec.command,
        "scope": spec.scope,
        "risk": spec.risk,
        "requires": spec.requires,
        "writes": spec.writes,
        "input": spec.input,
        "output": spec.output,
        "errors": command_errors(spec.command)
    }})
}

fn stopped_observe_result(command: &str) -> Value {
    if command == "runtime.doctor" {
        json!({
            "status": "ok", "command": command,
            "records": [{"name": "diagnostic", "fields": {
                "code": "runtime_stopped", "severity": "warning",
                "message": "Debrute Runtime is not running."
            }}],
            "fields": {"runtime_state": "stopped", "native_tray": "unavailable", "diagnostics": 1}
        })
    } else {
        json!({
            "status": "ok", "command": command,
            "fields": {"runtime_state": "stopped", "native_tray": "unavailable"}
        })
    }
}

fn transitioning_observe_result(command: &str, status: RuntimeStatus, instance_id: &str) -> Value {
    let state = status_name(status);
    if command == "runtime.doctor" {
        json!({
            "status": "ok", "command": command,
            "records": [{"name": "diagnostic", "fields": {
                "code": format!("runtime_{state}"), "severity": "warning",
                "message": format!("Debrute Runtime is {state}.")
            }}],
            "fields": {
                "runtime_state": state, "native_tray": "unavailable",
                "runtime_instance": instance_id, "diagnostics": 1
            }
        })
    } else {
        json!({
            "status": "ok", "command": command,
            "fields": {
                "runtime_state": state, "native_tray": "unavailable",
                "runtime_instance": instance_id
            }
        })
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn connect_existing() -> Result<Option<NativeControlClient<PlatformConnection>>, CliRunError> {
    let endpoint = platform_endpoint()?;
    match endpoint.connect_existing(CONTROL_TIMEOUT) {
        Ok(connection) => {
            NativeControlClient::handshake_and_clear_timeouts(connection, ClientRole::Cli)
                .map(Some)
                .map_err(|error| control_failure("runtime", &error))
        }
        Err(error) if error.is_absent() => Ok(None),
        Err(error) => Err(CliRunError::new(
            "runtime",
            "runtime_health_failed",
            error.to_string(),
        )),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn connect_existing() -> Result<Option<()>, CliRunError> {
    Err(CliRunError::new(
        "runtime",
        "runtime_health_failed",
        "Debrute Runtime is unsupported on this platform.",
    ))
}

#[cfg(target_os = "macos")]
type PlatformConnection = std::os::unix::net::UnixStream;
#[cfg(target_os = "windows")]
type PlatformConnection = debrute_native_control::WindowsControlConnection;

#[cfg(target_os = "macos")]
#[allow(clippy::unnecessary_wraps)]
fn platform_endpoint() -> Result<PlatformControlEndpoint, CliRunError> {
    Ok(PlatformControlEndpoint::for_current_user())
}

#[cfg(target_os = "windows")]
fn platform_endpoint() -> Result<PlatformControlEndpoint, CliRunError> {
    PlatformControlEndpoint::for_current_user()
        .map_err(|error| CliRunError::new("runtime", "runtime_health_failed", error.to_string()))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn ensure_runtime() -> Result<NativeControlClient<PlatformConnection>, CliRunError> {
    if let Some(client) = connect_existing()? {
        return Ok(client);
    }
    let runtime = runtime_entrypoint()?;
    Command::new(&runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| CliRunError::new("runtime", "runtime_launch_failed", error.to_string()))?;
    let deadline = Instant::now() + RUNTIME_STARTUP_TIMEOUT;
    loop {
        match connect_existing() {
            Ok(Some(client)) => return Ok(client),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                return Err(CliRunError::new(
                    "runtime",
                    "runtime_launch_failed",
                    "Debrute Runtime did not open Control before the startup deadline.",
                ));
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn ensure_runtime() -> Result<(), CliRunError> {
    Err(CliRunError::new(
        "runtime",
        "runtime_launch_failed",
        "Debrute Runtime is unsupported on this platform.",
    ))
}

fn runtime_entrypoint() -> Result<PathBuf, CliRunError> {
    if let Some(path) = std::env::var_os(RUNTIME_ENTRYPOINT_ENV).map(PathBuf::from) {
        return executable_path(path);
    }
    let current = std::env::current_exe()
        .map_err(|error| CliRunError::new("runtime", "runtime_launch_failed", error.to_string()))?;
    let directory = current.parent().ok_or_else(|| {
        CliRunError::new(
            "runtime",
            "runtime_launch_failed",
            "CLI executable has no parent directory.",
        )
    })?;
    let sibling = directory.join(runtime_executable_name());
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err(CliRunError::new(
        "runtime",
        "runtime_launch_failed",
        "The active Product Runtime entrypoint is unavailable.",
    ))
}

fn executable_path(path: PathBuf) -> Result<PathBuf, CliRunError> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(CliRunError::new(
            "runtime",
            "runtime_launch_failed",
            format!("Runtime entrypoint is unavailable: {}", path.display()),
        ))
    }
}

const fn runtime_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "debrute-runtime.exe"
    } else {
        "debrute-runtime"
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn create_cli_authorization(
    client: &mut NativeControlClient<PlatformConnection>,
) -> Result<(String, String), CliRunError> {
    let response = client
        .wait_ready_and_request(
            Uuid::new_v4().to_string(),
            ControlRequest::CreateCliAuthorization,
        )
        .map_err(|error| control_failure("runtime", &error))?;
    match response {
        ControlResponse::CliAuthorization {
            origin,
            authorization,
        } => Ok((origin, authorization)),
        ControlResponse::Rejected { code } => Err(rejected_failure("runtime", code)),
        _ => Err(CliRunError::new(
            "runtime",
            "runtime_health_failed",
            "Runtime returned an unexpected CLI session response.",
        )),
    }
}

fn rejected_failure(command: &str, code: ControlErrorCode) -> CliRunError {
    let (error_code, message) = match code {
        ControlErrorCode::InvalidActivation | ControlErrorCode::InvalidRoute => {
            ("invalid_input", "Runtime rejected the activation target.")
        }
        ControlErrorCode::DesktopUnavailable => {
            ("runtime_health_failed", "Debrute Desktop is unavailable.")
        }
        ControlErrorCode::UpdateCommitInProgress => (
            "product_update_failed",
            "Product update commit is already in progress.",
        ),
        _ => (
            "runtime_health_failed",
            "Runtime rejected the Control request.",
        ),
    };
    CliRunError::new(command, error_code, message)
}

fn control_failure(command: &str, error: &dyn Error) -> CliRunError {
    CliRunError::new(command, "runtime_health_failed", error.to_string())
}

fn parse_failure(error: &CliParseError) -> CliRunError {
    CliRunError::new(error.command(), error.code(), error.message())
}

fn normalize_http_error(code: &str) -> &str {
    match code {
        "cli_request_invalid" => "invalid_input",
        _ => "runtime_health_failed",
    }
}

const fn activation_outcome(outcome: ActivationOutcome) -> &'static str {
    match outcome {
        ActivationOutcome::Ensured => "ensured",
        ActivationOutcome::Opened => "opened",
        ActivationOutcome::FocusedExisting => "focused_existing",
        ActivationOutcome::HandledByExistingDesktop => "handled_by_existing_desktop",
        ActivationOutcome::PromotedToDesktopHost => "promoted_to_desktop_host",
    }
}

const fn status_name(status: RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Starting => "starting",
        RuntimeStatus::Ready => "ready",
        RuntimeStatus::Exiting => "exiting",
        RuntimeStatus::Replacing => "replacing",
    }
}

fn print_result(result: &Value) {
    match agent_record(result) {
        Ok(record) => println!("{record}"),
        Err(error) => println!(
            "debrute/1 error cmd=internal_error code=internal_error\nmessage=\"{}\"",
            error.to_string().replace('"', "\\\"")
        ),
    }
}

fn exit_code_for_result(result: &Value) -> u8 {
    if result.get("status").and_then(Value::as_str) != Some("error") {
        if result.get("command").and_then(Value::as_str) == Some("generate.image-batch")
            && result
                .pointer("/fields/failed")
                .and_then(Value::as_u64)
                .is_some_and(|failed| failed > 0)
        {
            return 1;
        }
        return 0;
    }
    match result
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("internal_error")
    {
        "invalid_command" | "invalid_argument" | "missing_argument" | "invalid_input"
        | "invalid_json_input" => 2,
        "runtime_config_error"
        | "runtime_not_running"
        | "runtime_launch_failed"
        | "runtime_health_failed"
        | "product_update_failed"
        | "model_not_configured"
        | "skills_bundle_unavailable"
        | "skills_shared_root_unreadable"
        | "skills_permission_denied" => 3,
        "model_request_failed" | "model_unavailable" => 4,
        "internal_error" => 5,
        _ => 1,
    }
}

fn failure(command: &str, code: &str, message: &str, fields: Value) -> Value {
    json!({
        "status": "error", "command": command, "code": code, "message": message,
        "fields": fields
    })
}

struct CliRunError {
    command: String,
    code: String,
    message: String,
    fields: Map<String, Value>,
}

impl CliRunError {
    fn new(
        command: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            command: command.into(),
            code: code.into(),
            message: message.into(),
            fields: Map::new(),
        }
    }
}
