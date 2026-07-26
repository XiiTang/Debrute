#![cfg(target_os = "windows")]

use std::{
    io::{Read as _, Write as _},
    path::PathBuf,
    sync::mpsc,
    time::Duration,
};

use debrute_native_process::{ChildProcessTree, WindowsSpawnBarrier};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};

const TERMINAL_BOOTSTRAP_FLAG: &str = "--internal-terminal-bootstrap";
const TERMINAL_SPAWN_BARRIER_ENV: &str = "DEBRUTE_INTERNAL_TERMINAL_SPAWN_BARRIER";

#[test]
fn terminal_bootstrap_runs_the_shell_after_job_assignment() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("ConPTY should open");
    let barrier = WindowsSpawnBarrier::new().expect("spawn barrier should open");
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_debrute-runtime"));
    command.arg(TERMINAL_BOOTSTRAP_FLAG);
    command.arg(windows_system_binary("whoami.exe"));
    command.env(TERMINAL_SPAWN_BARRIER_ENV, barrier.name());
    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("Terminal bootstrap should spawn");
    drop(pair.slave);
    let process = child
        .as_raw_handle()
        .expect("Terminal bootstrap should expose its process handle");
    let tree = ChildProcessTree::attach_raw_handle(process)
        .expect("Terminal bootstrap should join its Job Object and resume");
    barrier.release().expect("spawn barrier should release");

    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("ConPTY output should clone");
    let mut writer = pair
        .master
        .take_writer()
        .expect("ConPTY input should remain writable");
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        loop {
            let mut output = vec![0_u8; 4096];
            let result = reader.read(&mut output).map(|length| {
                output.truncate(length);
                output
            });
            let finished = match &result {
                Ok(output) => output.is_empty(),
                Err(_) => true,
            };
            if sender.send(result).is_err() || finished {
                break;
            }
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    let mut cursor_reported = false;
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let chunk = receiver
            .recv_timeout(remaining)
            .expect("Terminal bootstrap should produce shell output")
            .expect("Terminal bootstrap output should remain readable");
        output.extend_from_slice(&chunk);
        if !cursor_reported && output.windows(4).any(|value| value == b"\x1b[6n") {
            writer
                .write_all(b"\x1b[1;1R")
                .expect("Terminal cursor report should write");
            writer.flush().expect("Terminal cursor report should flush");
            cursor_reported = true;
        }
        if String::from_utf8_lossy(&output).contains('\\') {
            break;
        }
    }
    let output = String::from_utf8_lossy(&output);
    assert!(
        output.contains('\\'),
        "whoami should report a Windows account through ConPTY: {output:?}"
    );

    let status = child.wait().expect("Terminal bootstrap should exit");
    assert!(
        status.success(),
        "Terminal bootstrap should exit successfully"
    );
    drop(tree);
}

fn windows_system_binary(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot should be set"))
        .join("System32")
        .join(name)
}
