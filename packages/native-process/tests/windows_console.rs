#![cfg(target_os = "windows")]

use std::{
    os::windows::io::AsRawHandle as _,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use debrute_native_process::{ChildProcessTree, configure_process_group};

const CONSOLE_TEST_ROLE: &str = "DEBRUTE_NATIVE_PROCESS_CONSOLE_TEST_ROLE";
const TEST_NAME: &str = "supervised_worker_has_no_console_window";

#[test]
fn supervised_worker_has_no_console_window() {
    match std::env::var(CONSOLE_TEST_ROLE).as_deref() {
        Ok("child") => {
            // SAFETY: this only observes the calling process's console association.
            let window = unsafe { GetConsoleWindow() };
            println!("child-consoleless={}", usize::from(window.is_null()));
        }
        Ok("parent") => run_consoleless_parent(),
        _ => run_outer_test(),
    }
}

#[test]
fn raw_handle_attachment_resumes_suspended_process() {
    let mut command = Command::new("cmd.exe");
    command.args(["/d", "/s", "/c", "exit 0"]);
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .expect("raw-handle child should start suspended");
    let tree = ChildProcessTree::attach_raw_handle(child.as_raw_handle())
        .expect("raw-handle child should attach and resume");

    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .expect("child status should remain readable")
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = tree.force_kill();
            let _ = child.wait();
            panic!("raw-handle child remained suspended after attachment");
        }
        thread::sleep(Duration::from_millis(10));
    };
    drop(tree);
    assert!(
        status.success(),
        "raw-handle child should exit successfully"
    );
}

fn run_outer_test() {
    let output = Command::new(std::env::current_exe().expect("test executable should resolve"))
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env(CONSOLE_TEST_ROLE, "parent")
        .output()
        .expect("consoleless parent should start");
    assert!(
        output.status.success(),
        "consoleless parent failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_consoleless_parent() {
    // SAFETY: detaching this dedicated helper process from its inherited
    // console is the precondition needed to reproduce GUI-parent spawning.
    unsafe { FreeConsole() };

    let mut command =
        Command::new(std::env::current_exe().expect("test executable should resolve"));
    command
        .args(["--exact", TEST_NAME, "--nocapture"])
        .env(CONSOLE_TEST_ROLE, "child")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let child = command
        .spawn()
        .expect("supervised child should start suspended");
    let tree = ChildProcessTree::attach(&child).expect("supervised child should attach and resume");
    let output = child
        .wait_with_output()
        .expect("supervised child output should be collected");
    drop(tree);
    assert!(
        output.status.success(),
        "supervised child failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("child-consoleless=1"),
        "supervised child received a console window:\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn FreeConsole() -> i32;
    fn GetConsoleWindow() -> *mut core::ffi::c_void;
}
