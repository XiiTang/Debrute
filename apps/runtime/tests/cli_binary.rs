use std::process::Command;

#[cfg(target_os = "macos")]
use std::{fs, io::Write as _, os::unix::net::UnixListener, time::Duration};

#[cfg(target_os = "macos")]
use debrute_runtime::control::{
    ClientMessage, ClientRole, ControlRequest, ControlResponse, RuntimeStatus, ServerMessage,
    encode_server_frame, read_frame, serve_handshake,
};
#[cfg(target_os = "macos")]
use url::Url;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[test]
fn rust_cli_local_commands_use_the_stable_agent_protocol() {
    let executable = env!("CARGO_BIN_EXE_debrute");
    let version = Command::new(executable)
        .arg("--version")
        .output()
        .expect("CLI should run");
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        env!("CARGO_PKG_VERSION")
    );

    let commands = Command::new(executable)
        .arg("commands")
        .output()
        .expect("CLI should run");
    assert!(commands.status.success());
    let stdout = String::from_utf8(commands.stdout).unwrap();
    assert!(stdout.starts_with("debrute ok cmd=commands\ncommand name=runtime.status"));
    assert!(!stdout.contains("command name=update"));
    assert!(stdout.contains("command name=request.single"));
    assert!(stdout.contains("command name=workbench.url"));
    assert!(stdout.contains("command name=operation.wait"));
    assert!(stdout.ends_with("count=27\n"));
}

#[test]
fn rust_cli_parse_failures_are_agent_records_with_exit_two() {
    let output = Command::new(env!("CARGO_BIN_EXE_debrute"))
        .args(["workbench", "start", "--next", "/settings"])
        .output()
        .expect("CLI should run");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "debrute error cmd=workbench.start code=invalid_argument\nlog=\"Unknown option for workbench.start: --next\""
    );
}

#[cfg(target_os = "macos")]
#[test]
fn rust_cli_resolves_an_unchecked_project_url_as_one_agent_record() {
    let root = std::path::Path::new("/tmp").join(format!("dbrt-url-{}", Uuid::new_v4()));
    let endpoint_directory = root.join("debrute");
    let cwd = root.join("cwd");
    fs::create_dir_all(&endpoint_directory).expect("endpoint directory should exist");
    fs::create_dir(&cwd).expect("CLI working directory should exist");
    let canonical_cwd = cwd
        .canonicalize()
        .expect("CLI working directory should canonicalize");
    let listener = UnixListener::bind(endpoint_directory.join("control.sock"))
        .expect("fake Control endpoint should bind");
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("CLI should connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("server read should be bounded");
        assert_eq!(
            serve_handshake(&mut stream, "runtime-instance", RuntimeStatus::Ready)
                .expect("handshake should succeed"),
            ClientRole::Cli
        );
        let ClientMessage::Request {
            request_id,
            request: ControlRequest::ResolveWorkbenchRootUrl,
        } = read_frame(&mut stream).expect("Workbench URL request should arrive")
        else {
            panic!("CLI should request only the Root Workbench URL");
        };
        stream
            .write_all(
                &encode_server_frame(&ServerMessage::response(
                    request_id,
                    ControlResponse::WorkbenchRootUrl {
                        url: "http://127.0.0.1:45678/".to_owned(),
                    },
                ))
                .expect("Workbench URL response should encode"),
            )
            .expect("Workbench URL response should write");
        stream.flush().expect("Workbench URL response should flush");
    });

    let requested = "missing Project #? 中文";
    assert!(!cwd.join(requested).exists());
    let output = Command::new(env!("CARGO_BIN_EXE_debrute"))
        .env("TMPDIR", &root)
        .current_dir(&cwd)
        .args(["workbench", "url", requested])
        .output()
        .expect("CLI should run");
    server.join().expect("fake Control server should finish");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).expect("stdout should be UTF-8");
    let lines = stdout.trim_end().lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "debrute ok cmd=workbench.url");
    let url = lines[1]
        .strip_prefix("url=\"")
        .and_then(|value| value.strip_suffix('"'))
        .expect("the only result field should be a quoted URL");
    let parsed = Url::parse(url).expect("result should be a URL");
    assert_eq!(parsed.path(), "/open");
    assert_eq!(
        parsed
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned()),
        Some(canonical_cwd.join(requested).to_string_lossy().into_owned())
    );

    fs::remove_dir_all(&root).expect("CLI URL fixture should clean up");
}
