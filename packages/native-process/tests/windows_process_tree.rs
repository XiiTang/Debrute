#![cfg(target_os = "windows")]

use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use debrute_native_process::{ChildProcessTree, configure_process_group};

#[test]
fn force_kill_terminates_grandchildren() {
    let fixture = ProcessTreeFixture::spawn();
    let root_pid = fixture.root_pid();
    let grandchild_pid = fixture.grandchild_pid();

    fixture
        .tree
        .as_ref()
        .expect("fixture should own its process tree")
        .force_kill()
        .expect("Job Object termination should succeed");

    assert_process_exits(
        root_pid,
        "root process should exit after Job Object termination",
    );
    assert_process_exits(
        grandchild_pid,
        "grandchild should exit after Job Object termination",
    );
}

#[test]
fn drop_terminates_grandchildren() {
    let mut fixture = ProcessTreeFixture::spawn();
    let root_pid = fixture.root_pid();
    let grandchild_pid = fixture.grandchild_pid();
    drop(fixture.tree.take());

    assert_process_exits(
        root_pid,
        "root process should exit when its Job Object is dropped",
    );
    assert_process_exits(
        grandchild_pid,
        "grandchild should exit when its Job Object is dropped",
    );
}

struct ProcessTreeFixture {
    root: PathBuf,
    child: Option<Child>,
    tree: Option<ChildProcessTree>,
    grandchild_pid: Option<u32>,
}

impl ProcessTreeFixture {
    fn spawn() -> Self {
        let root = std::env::temp_dir().join(format!(
            "debrute-native-process-tree-{}",
            uuid::Uuid::new_v4()
        ));
        let mut fixture = Self {
            root,
            child: None,
            tree: None,
            grandchild_pid: None,
        };
        fixture.initialize();
        fixture
    }

    fn initialize(&mut self) {
        std::fs::create_dir_all(&self.root).expect("process-tree fixture should exist");
        let pid_file = self.root.join("grandchild.pid");
        let escaped_pid_file = pid_file.to_string_lossy().replace('\'', "''");
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command"]).arg(format!(
            "$child = Start-Process -FilePath ping.exe -ArgumentList @('-n','60','127.0.0.1') -PassThru -WindowStyle Hidden; \
             Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id -NoNewline; \
             Wait-Process -Id $child.Id"
        ));
        configure_process_group(&mut command);
        self.child = Some(
            command
                .spawn()
                .expect("process-tree root should start suspended"),
        );
        self.tree = Some(
            ChildProcessTree::attach(
                self.child
                    .as_ref()
                    .expect("fixture should own the suspended root"),
            )
            .expect("process-tree root should join its Job Object and resume"),
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file)
                && let Ok(process_id) = contents.trim().parse::<u32>()
            {
                self.grandchild_pid = Some(process_id);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for the grandchild PID"
            );
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            process_is_alive(self.grandchild_pid()),
            "grandchild should be alive before Job Object termination"
        );
    }

    fn root_pid(&self) -> u32 {
        self.child
            .as_ref()
            .expect("fixture should own its root process")
            .id()
    }

    fn grandchild_pid(&self) -> u32 {
        self.grandchild_pid
            .expect("fixture should know its grandchild PID")
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        let root_pid = self.child.as_ref().map(Child::id);
        let grandchild_pid = self.grandchild_pid;

        if let Some(tree) = self.tree.take() {
            if (root_pid.is_some_and(process_is_alive)
                || grandchild_pid.is_some_and(process_is_alive))
                && let Err(error) = tree.force_kill()
            {
                failures.push(format!("Job Object termination failed: {error}"));
            }
            drop(tree);
        }
        for process_id in [root_pid, grandchild_pid].into_iter().flatten() {
            if let Err(error) = force_kill_pid(process_id) {
                failures.push(error);
            }
        }
        if let Some(mut child) = self.child.take()
            && let Err(error) = child.wait()
        {
            failures.push(format!("root process wait failed: {error}"));
        }
        if let Err(error) = std::fs::remove_dir_all(&self.root)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            failures.push(format!("fixture directory cleanup failed: {error}"));
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

impl Drop for ProcessTreeFixture {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            if std::thread::panicking() {
                eprintln!("process-tree fixture cleanup also failed: {error}");
            } else {
                panic!("process-tree fixture cleanup failed: {error}");
            }
        }
    }
}

fn process_is_alive(process_id: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    // SAFETY: the returned handle is queried and closed within this function.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return false;
    }
    let mut exit_code = 0_u32;
    // SAFETY: `process` is live and `exit_code` is writable for the duration of the call.
    let queried = unsafe { GetExitCodeProcess(process, &raw mut exit_code) } != 0;
    // SAFETY: `process` is an owned live handle and is closed exactly once here.
    unsafe { CloseHandle(process) };
    queried && exit_code == STILL_ACTIVE as u32
}

fn assert_process_exits(process_id: u32, message: &str) {
    if let Err(error) = wait_for_process_exit(process_id) {
        panic!("{message}: {error}");
    }
}

fn wait_for_process_exit(process_id: u32) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_is_alive(process_id) {
        if Instant::now() >= deadline {
            return Err(format!("PID {process_id} remained alive"));
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn force_kill_pid(process_id: u32) -> Result<(), String> {
    if !process_is_alive(process_id) {
        return Ok(());
    }
    let windows_directory = std::env::var_os("WINDIR")
        .ok_or_else(|| "WINDIR is required to clean the process-tree fixture".to_owned())?;
    let result = Command::new(
        PathBuf::from(windows_directory)
            .join("System32")
            .join("taskkill.exe"),
    )
    .args(["/PID", &process_id.to_string(), "/T", "/F"])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|error| format!("taskkill failed for PID {process_id}: {error}"))?;
    if !result.success() && process_is_alive(process_id) {
        return Err(format!(
            "taskkill exited with {result} while PID {process_id} remained alive"
        ));
    }
    wait_for_process_exit(process_id)
}
