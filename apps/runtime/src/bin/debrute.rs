#![allow(clippy::needless_pass_by_value, clippy::too_many_lines)]

use std::{
    fs::File,
    io::{Read as _, Write as _, stdin, stdout},
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
        ControlResponse, NativeControlClient, NativeControlClientError, ProjectFrontend,
        RuntimeStatus, endpoint::ControlEndpointAdapter,
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
const MAX_MODEL_OPERATION_INPUT_BYTES: usize = 16 * 1024 * 1024;

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
            return ExitCode::from(1);
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
        CliCommandPolicy::Local => Ok(run_local(&parsed)),
        CliCommandPolicy::Observe => run_observe(&parsed).await,
        CliCommandPolicy::Activate => run_activate(&parsed),
        CliCommandPolicy::Stop => run_stop(&parsed),
        CliCommandPolicy::Run => run_http(&parsed, false).await,
        CliCommandPolicy::Submit => run_submit(&parsed).await,
        CliCommandPolicy::Stream => run_http(&parsed, true).await,
    }
}

fn run_local(parsed: &ParsedCliCommand) -> Value {
    if parsed.command == "commands" {
        let records = command_specs().iter().map(spec_record).collect::<Vec<_>>();
        return json!({
            "status": "ok", "command": "commands", "records": records,
            "fields": {"count": command_specs().len()}
        });
    }
    let spec = command_spec(&parsed.positional)
        .expect("the parser resolves the command path before selecting Local policy");
    json!({
        "status": "ok", "command": "help", "records": [spec_record(spec)]
    })
}

async fn run_observe(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    let deadline = Instant::now() + RUNTIME_STARTUP_TIMEOUT;
    let Some(mut client) = connect_existing(ready_time_remaining(deadline, parsed.command)?)?
    else {
        return Ok(stopped_observe_result(parsed.command));
    };
    match client.status() {
        RuntimeStatus::Ready => {
            let (origin, authorization) = create_cli_authorization(&mut client, deadline)?;
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
    let deadline = Instant::now() + RUNTIME_STARTUP_TIMEOUT;
    let mut client = ensure_runtime(deadline)?;
    let frontend = parsed
        .options
        .get("frontend")
        .map_or("default", String::as_str);
    let frontend = match frontend {
        "default" => ProjectFrontend::Default,
        "desktop" => ProjectFrontend::Desktop,
        "browser" => ProjectFrontend::Browser,
        _ => unreachable!("the parser enforces the frontend value set"),
    };
    let intent = match (&parsed.project_root, frontend) {
        (None, ProjectFrontend::Default) => ActivationIntent::OpenDefaultFrontend,
        (None, ProjectFrontend::Desktop) => ActivationIntent::OpenDesktop,
        (None, ProjectFrontend::Browser) => ActivationIntent::OpenBrowser,
        (Some(project_root), frontend) => ActivationIntent::OpenProject {
            project_root: project_root.to_string_lossy().into_owned(),
            frontend,
        },
    };
    let response = client
        .wait_ready_and_request_until(
            deadline,
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
    let Some(mut client) = connect_existing(CONTROL_TIMEOUT)? else {
        return Err(CliRunError::new(
            parsed.command,
            "runtime_not_running",
            "Debrute Runtime is not running.",
        ));
    };
    let response = client
        .quit_product(Uuid::new_v4().to_string())
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
    let deadline = Instant::now() + RUNTIME_STARTUP_TIMEOUT;
    let mut control = ensure_runtime(deadline)?;
    let (origin, authorization) = create_cli_authorization(&mut control, deadline)?;
    // `control` intentionally remains live until the HTTP command completes;
    // Runtime revokes this bearer authorization when the native connection closes.
    let result = post_command(parsed, &origin, &authorization, stream).await;
    drop(control);
    result
}

async fn run_submit(parsed: &ParsedCliCommand) -> Result<Value, CliRunError> {
    let input_path = parsed.options.get("input").ok_or_else(|| {
        CliRunError::new(parsed.command, "missing_argument", "--input is required.")
    })?;
    let input = read_model_input(input_path, parsed.command)?;
    let deadline = Instant::now() + RUNTIME_STARTUP_TIMEOUT;
    let mut control = ensure_runtime(deadline)?;
    let (origin, authorization) = create_cli_authorization(&mut control, deadline)?;
    let request = command_request(parsed);
    let form = reqwest::multipart::Form::new()
        .text(
            "request",
            serde_json::to_string(&request).map_err(|error| {
                CliRunError::new(parsed.command, "internal_error", error.to_string())
            })?,
        )
        .part(
            "input",
            reqwest::multipart::Part::bytes(input)
                .file_name("model-requests.jsonl")
                .mime_str("application/x-ndjson")
                .map_err(|error| {
                    CliRunError::new(parsed.command, "internal_error", error.to_string())
                })?,
        );
    let response = reqwest::Client::new()
        .post(format!("{origin}/api/cli/model-operations"))
        .bearer_auth(&authorization)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            CliRunError::new(
                parsed.command,
                "submission_outcome_unknown",
                format!("Runtime connection ended while submitting the Model Operation: {error}"),
            )
        })?;
    let submitted = if response.status().is_success() {
        response.json::<Value>().await.map_err(|error| {
            CliRunError::new(
                parsed.command,
                "submission_outcome_unknown",
                format!("Runtime submission response ended before the Operation id: {error}"),
            )
        })?
    } else {
        parse_http_response(parsed.command, response).await?
    };
    if submitted.get("status").and_then(Value::as_str) == Some("error")
        || parsed
            .options
            .get("no-wait")
            .is_some_and(|value| value == "true")
    {
        drop(control);
        return Ok(submitted);
    }
    let operation_id = submitted
        .get("records")
        .and_then(Value::as_array)
        .and_then(|records| {
            records.iter().find_map(|record| {
                (record.get("name").and_then(Value::as_str) == Some("operation"))
                    .then(|| record.pointer("/fields/id").and_then(Value::as_str))
                    .flatten()
            })
        })
        .ok_or_else(|| {
            CliRunError::new(
                parsed.command,
                "submission_outcome_unknown",
                "Runtime accepted a Model Operation without returning its id.",
            )
        })?
        .to_owned();
    print_progress(
        parsed.command,
        &json!({
            "event": "operation.accepted",
            "records": submitted["records"].clone()
        }),
    )?;
    let wait_request = json!({
        "command": "operation.wait",
        "positional": [operation_id],
        "options": {},
        "projectRoot": null
    });
    let mut result = post_request(
        parsed.command,
        &origin,
        &authorization,
        wait_request,
        true,
        false,
    )
    .await?;
    if let Some(result) = result.as_object_mut() {
        result.insert(
            "command".to_owned(),
            Value::String(parsed.command.to_owned()),
        );
    }
    drop(control);
    Ok(result)
}

async fn post_command(
    parsed: &ParsedCliCommand,
    origin: &str,
    authorization: &str,
    stream: bool,
) -> Result<Value, CliRunError> {
    post_request(
        parsed.command,
        origin,
        authorization,
        command_request(parsed),
        stream,
        true,
    )
    .await
}

fn command_request(parsed: &ParsedCliCommand) -> Value {
    json!({
        "command": parsed.command,
        "positional": parsed.positional,
        "options": parsed.options,
        "projectRoot": parsed.project_root.as_ref().map(|path| path.to_string_lossy().into_owned())
    })
}

async fn post_request(
    command: &str,
    origin: &str,
    authorization: &str,
    request: Value,
    stream: bool,
    print_observed: bool,
) -> Result<Value, CliRunError> {
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
        .map_err(|error| CliRunError::new(command, "runtime_lost", error.to_string()))?;
    if !response.status().is_success() {
        return parse_http_response(command, response).await;
    }
    if !stream {
        return response.json::<Value>().await.map_err(|error| {
            CliRunError::new(command, "runtime_health_failed", error.to_string())
        });
    }
    let mut buffer = Vec::new();
    let mut result = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| CliRunError::new(command, "runtime_lost", error.to_string()))?
    {
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = buffer.drain(..=newline).collect::<Vec<_>>();
            let line = &line[..line.len().saturating_sub(1)];
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            consume_stream_event(
                command,
                serde_json::from_slice(line).map_err(|error| {
                    CliRunError::new(command, "runtime_health_failed", error.to_string())
                })?,
                &mut result,
                print_observed,
            )?;
        }
    }
    if buffer.iter().any(|byte| !byte.is_ascii_whitespace()) {
        consume_stream_event(
            command,
            serde_json::from_slice(&buffer).map_err(|error| {
                CliRunError::new(command, "runtime_health_failed", error.to_string())
            })?,
            &mut result,
            print_observed,
        )?;
    }
    result.ok_or_else(|| {
        CliRunError::new(
            command,
            "runtime_health_failed",
            "Runtime CLI stream ended without a final result.",
        )
    })
}

async fn parse_http_response(
    command: &str,
    response: reqwest::Response,
) -> Result<Value, CliRunError> {
    if response.status().is_success() {
        return response.json::<Value>().await.map_err(|error| {
            CliRunError::new(command, "runtime_health_failed", error.to_string())
        });
    }
    let status = response.status();
    let body = response.json::<Value>().await.map_err(|error| {
        CliRunError::new(
            command,
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
    Err(CliRunError::new(
        command,
        normalize_http_error(code),
        message,
    ))
}

fn read_model_input(path: &str, command: &str) -> Result<Vec<u8>, CliRunError> {
    let mut input = Vec::new();
    if path == "-" {
        stdin()
            .lock()
            .take((MAX_MODEL_OPERATION_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|error| CliRunError::new(command, "invalid_input", error.to_string()))?;
    } else {
        File::open(path)
            .map_err(|error| CliRunError::new(command, "invalid_input", error.to_string()))?
            .take((MAX_MODEL_OPERATION_INPUT_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|error| CliRunError::new(command, "invalid_input", error.to_string()))?;
    }
    if input.len() > MAX_MODEL_OPERATION_INPUT_BYTES {
        return Err(CliRunError::new(
            command,
            "invalid_input",
            "Model Request input exceeds 16 MiB.",
        ));
    }
    Ok(input)
}

fn consume_stream_event(
    command: &str,
    event: Value,
    result: &mut Option<Value>,
    print_observed: bool,
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
            if print_observed
                || fields.get("event").and_then(Value::as_str) != Some("operation.observed")
            {
                print_progress(command, fields)?;
            }
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

fn print_progress(command: &str, fields: &Value) -> Result<(), CliRunError> {
    let record = progress_record(command, fields)
        .map_err(|error| CliRunError::new(command, "internal_error", error.to_string()))?;
    println!("{record}");
    stdout()
        .flush()
        .map_err(|error| CliRunError::new(command, "internal_error", error.to_string()))
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
fn connect_existing(
    timeout: Duration,
) -> Result<Option<NativeControlClient<PlatformConnection>>, CliRunError> {
    connect_existing_until(Instant::now() + timeout, control_failure)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn connect_existing_for_ready(
    deadline: Instant,
) -> Result<Option<NativeControlClient<PlatformConnection>>, CliRunError> {
    connect_existing_until(deadline, readiness_control_failure)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn connect_existing_until(
    deadline: Instant,
    map_control_error: fn(&str, &NativeControlClientError) -> CliRunError,
) -> Result<Option<NativeControlClient<PlatformConnection>>, CliRunError> {
    let endpoint = platform_endpoint()?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            map_control_error(
                "runtime",
                &NativeControlClientError::HandshakeDeadlineExceeded,
            )
        })?;
    match endpoint.connect_existing(remaining) {
        Ok(connection) => {
            NativeControlClient::handshake_and_clear_timeouts(connection, ClientRole::Cli, deadline)
                .map(Some)
                .map_err(|error| map_control_error("runtime", &error))
        }
        Err(_) if Instant::now() >= deadline => Err(map_control_error(
            "runtime",
            &NativeControlClientError::HandshakeDeadlineExceeded,
        )),
        Err(error) if error.is_absent() => Ok(None),
        Err(error) => Err(CliRunError::new(
            "runtime",
            "runtime_health_failed",
            error.to_string(),
        )),
    }
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
fn ensure_runtime(
    deadline: Instant,
) -> Result<NativeControlClient<PlatformConnection>, CliRunError> {
    if let Some(client) = connect_existing_for_ready(deadline)? {
        return Ok(client);
    }
    ready_time_remaining(deadline, "runtime")?;
    let runtime = runtime_entrypoint()?;
    let mut command = Command::new(&runtime);
    #[cfg(target_os = "windows")]
    command.arg("--stable-runtime-entrypoint").arg(&runtime);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| CliRunError::new("runtime", "runtime_launch_failed", error.to_string()))?;
    loop {
        let remaining = ready_time_remaining(deadline, "runtime")?;
        match connect_existing_for_ready(deadline) {
            Ok(Some(client)) => return Ok(client),
            Ok(None) => std::thread::sleep(Duration::from_millis(25).min(remaining)),
            Err(error) => return Err(error),
        }
    }
}

fn runtime_entrypoint() -> Result<PathBuf, CliRunError> {
    let path = std::env::var_os(RUNTIME_ENTRYPOINT_ENV)
        .map(PathBuf::from)
        .ok_or_else(|| {
            CliRunError::new(
                "runtime",
                "runtime_launch_failed",
                format!("{RUNTIME_ENTRYPOINT_ENV} is required."),
            )
        })?;
    executable_path(path)
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn create_cli_authorization(
    client: &mut NativeControlClient<PlatformConnection>,
    deadline: Instant,
) -> Result<(String, String), CliRunError> {
    let response = client
        .wait_ready_and_request_until(
            deadline,
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

fn control_failure(command: &str, error: &NativeControlClientError) -> CliRunError {
    let code = if matches!(error, NativeControlClientError::RuntimeReadyTimeout) {
        "runtime_ready_timeout"
    } else {
        "runtime_health_failed"
    };
    CliRunError::new(command, code, error.to_string())
}

fn readiness_control_failure(command: &str, error: &NativeControlClientError) -> CliRunError {
    if error.is_handshake_timeout() {
        CliRunError::new(command, "runtime_ready_timeout", error.to_string())
    } else {
        control_failure(command, error)
    }
}

fn ready_time_remaining(deadline: Instant, command: &str) -> Result<Duration, CliRunError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            CliRunError::new(
                command,
                "runtime_ready_timeout",
                "Runtime did not become Ready before the absolute deadline.",
            )
        })
}

fn parse_failure(error: &CliParseError) -> CliRunError {
    CliRunError::new(error.command(), error.code(), error.message())
}

fn normalize_http_error(code: &str) -> &str {
    match code {
        "cli_request_invalid"
        | "request_body_too_large"
        | "invalid_input"
        | "invalid_multipart" => "invalid_input",
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
            "debrute error cmd=internal_error code=internal_error\nlog=\"{}\"",
            error.to_string().replace('"', "\\\"")
        ),
    }
}

fn exit_code_for_result(result: &Value) -> u8 {
    if result.get("status").and_then(Value::as_str) != Some("error") {
        return 0;
    }
    match result
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("internal_error")
    {
        "invalid_command" | "invalid_argument" | "missing_argument" | "invalid_input"
        | "invalid_json_input" | "project_invalid" => 2,
        _ => 1,
    }
}

fn failure(command: &str, code: &str, message: &str, fields: Value) -> Value {
    json!({
        "status": "error", "command": command, "code": code, "log": message,
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::{
        os::unix::net::UnixStream,
        time::{Duration, Instant},
    };

    use debrute_runtime::control::{ClientRole, NativeControlClient};

    use super::{control_failure, readiness_control_failure};

    #[test]
    fn stalled_handshake_is_ready_timeout_only_for_runtime_acquisition() {
        let error = stalled_handshake_error();
        assert_eq!(
            control_failure("runtime.stop", &error).code,
            "runtime_health_failed"
        );
        assert_eq!(
            readiness_control_failure("runtime", &error).code,
            "runtime_ready_timeout"
        );
    }

    fn stalled_handshake_error() -> debrute_runtime::control::NativeControlClientError {
        let (client, _stalled_server) =
            UnixStream::pair().expect("Control stream pair should open");
        let Err(error) = NativeControlClient::handshake_and_clear_timeouts(
            client,
            ClientRole::Cli,
            Instant::now() + Duration::from_millis(20),
        ) else {
            panic!("stalled handshake should time out");
        };
        error
    }
}
