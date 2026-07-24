//! One bounded, internal-only native worker supervisor.

use std::{
    collections::VecDeque,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const DEFAULT_MAX_CONCURRENT_PROCESSES: usize = 4;
const DEFAULT_OUTPUT_LIMIT: usize = 65_536;
const TERMINATE_GRACE: Duration = Duration::from_millis(250);
const FORCE_KILL_GRACE: Duration = Duration::from_secs(1);
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(100);
const WAIT_POLL: Duration = Duration::from_millis(10);
const MAX_PROCESS_ADMISSION_WAITERS: usize = 32;
const MAX_PROCESS_ADMISSION_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerKind {
    IntegrationProbe,
    IntegrationCommand,
    MediaProbe,
    VideoFrame,
    NativeShell,
}

#[derive(Debug, Clone)]
pub(crate) struct ProcessRequest {
    pub kind: WorkerKind,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub output_limit: usize,
}

impl ProcessRequest {
    pub(crate) fn new(
        kind: WorkerKind,
        executable: impl Into<PathBuf>,
        args: Vec<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            kind,
            executable: executable.into(),
            args,
            cwd: None,
            timeout,
            output_limit: DEFAULT_OUTPUT_LIMIT,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessErrorKind {
    Timeout,
    Cancelled,
    SpawnError,
    OutputError,
    CleanupError,
    NonzeroExit,
    Backpressure,
}

impl ProcessErrorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::SpawnError => "spawn_error",
            Self::OutputError => "output_error",
            Self::CleanupError => "cleanup_error",
            Self::NonzeroExit => "nonzero_exit",
            Self::Backpressure => "backpressure",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessOutput {
    pub kind: WorkerKind,
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub error_kind: Option<ProcessErrorKind>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProcessCancellation(Arc<std::sync::atomic::AtomicBool>);

impl ProcessCancellation {
    pub(crate) fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}

#[derive(Debug)]
pub(crate) struct BoundedProcessSupervisor {
    capacity: usize,
    state: Mutex<ProcessAdmissionState>,
    available: Condvar,
}

#[derive(Debug, Default)]
struct ProcessAdmissionState {
    active: usize,
    waiters: usize,
}

impl Default for BoundedProcessSupervisor {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENT_PROCESSES)
    }
}

impl BoundedProcessSupervisor {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(ProcessAdmissionState::default()),
            available: Condvar::new(),
        }
    }

    // Process admission, capture, cancellation, and teardown are one linear state machine.
    #[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
    pub(crate) fn run(
        &self,
        request: ProcessRequest,
        cancellation: &ProcessCancellation,
    ) -> ProcessOutput {
        if request.timeout.is_zero() || request.output_limit == 0 {
            return failed_output(
                request.kind,
                ProcessErrorKind::SpawnError,
                "process request limits must be positive",
            );
        }
        let _permit = match self.acquire(cancellation, request.timeout) {
            Ok(permit) => permit,
            Err(error_kind) => {
                return failed_output(
                    request.kind,
                    error_kind,
                    if error_kind == ProcessErrorKind::Cancelled {
                        "process cancelled"
                    } else {
                        "process admission queue is full or timed out"
                    },
                );
            }
        };

        let mut command = Command::new(&request.executable);
        command
            .args(&request.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        debrute_native_process::configure_process_group(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return failed_output(
                    request.kind,
                    ProcessErrorKind::SpawnError,
                    &error.to_string(),
                );
            }
        };
        let tree = match debrute_native_process::ChildProcessTree::attach(&child) {
            Ok(tree) => tree,
            Err(error) => {
                kill_and_reap_bounded(&mut child);
                return failed_output(
                    request.kind,
                    ProcessErrorKind::SpawnError,
                    &error.to_string(),
                );
            }
        };
        let stdout = match child.stdout.take() {
            Some(reader) => {
                match spawn_output_reader(reader, request.output_limit, "debrute-worker-stdout") {
                    Ok(reader) => Some(reader),
                    Err(error) => {
                        let _ = tree.force_kill();
                        let _ = wait_for_child(&mut child, FORCE_KILL_GRACE);
                        return failed_output(
                            request.kind,
                            ProcessErrorKind::OutputError,
                            &error.to_string(),
                        );
                    }
                }
            }
            None => None,
        };
        let stderr = match child.stderr.take() {
            Some(reader) => {
                match spawn_output_reader(reader, request.output_limit, "debrute-worker-stderr") {
                    Ok(reader) => Some(reader),
                    Err(error) => {
                        let _ = tree.force_kill();
                        let _ = wait_for_child(&mut child, FORCE_KILL_GRACE);
                        let mut output = failed_output(
                            request.kind,
                            ProcessErrorKind::OutputError,
                            &error.to_string(),
                        );
                        adopt_output(&mut output, stdout, None);
                        return output;
                    }
                }
            }
            None => None,
        };
        let started = Instant::now();
        let (exit_code, error_kind, teardown_error) = loop {
            if cancellation.is_cancelled() {
                let teardown = terminate_then_kill(&tree, &mut child);
                break (
                    child
                        .try_wait()
                        .ok()
                        .flatten()
                        .and_then(|status| status.code()),
                    Some(ProcessErrorKind::Cancelled),
                    teardown.err().map(|error| error.to_string()),
                );
            }
            if started.elapsed() >= request.timeout {
                let teardown = terminate_then_kill(&tree, &mut child);
                break (
                    child
                        .try_wait()
                        .ok()
                        .flatten()
                        .and_then(|status| status.code()),
                    Some(ProcessErrorKind::Timeout),
                    teardown.err().map(|error| error.to_string()),
                );
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    let cleanup_error = tree.force_kill().err();
                    break (
                        code,
                        if cleanup_error.is_some() && status.success() {
                            Some(ProcessErrorKind::CleanupError)
                        } else if status.success() {
                            None
                        } else {
                            Some(ProcessErrorKind::NonzeroExit)
                        },
                        cleanup_error
                            .map(|error| format!("worker process tree cleanup failed: {error}")),
                    );
                }
                Ok(None) => thread::sleep(WAIT_POLL),
                Err(error) => {
                    let _ = tree.force_kill();
                    let _ = wait_for_child(&mut child, FORCE_KILL_GRACE);
                    let mut output = failed_output(
                        request.kind,
                        ProcessErrorKind::OutputError,
                        &error.to_string(),
                    );
                    adopt_output(&mut output, stdout, stderr);
                    return output;
                }
            }
        };
        let mut output = ProcessOutput {
            kind: request.kind,
            ok: error_kind.is_none(),
            exit_code,
            error_kind,
            stdout: String::new(),
            stderr: teardown_error.unwrap_or_default(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        adopt_output(&mut output, stdout, stderr);
        output
    }

    fn acquire<'a>(
        &'a self,
        cancellation: &ProcessCancellation,
        request_timeout: Duration,
    ) -> Result<ProcessPermit<'a>, ProcessErrorKind> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ProcessErrorKind::SpawnError)?;
        if state.active >= self.capacity {
            if state.waiters >= MAX_PROCESS_ADMISSION_WAITERS {
                return Err(ProcessErrorKind::Backpressure);
            }
            state.waiters += 1;
            let deadline = Instant::now() + request_timeout.min(MAX_PROCESS_ADMISSION_WAIT);
            while state.active >= self.capacity {
                if cancellation.is_cancelled() {
                    state.waiters = state.waiters.saturating_sub(1);
                    return Err(ProcessErrorKind::Cancelled);
                }
                if Instant::now() >= deadline {
                    state.waiters = state.waiters.saturating_sub(1);
                    return Err(ProcessErrorKind::Backpressure);
                }
                let (next, _) = self
                    .available
                    .wait_timeout(state, WAIT_POLL)
                    .map_err(|_| ProcessErrorKind::SpawnError)?;
                state = next;
            }
            state.waiters = state.waiters.saturating_sub(1);
        }
        if cancellation.is_cancelled() {
            return Err(ProcessErrorKind::Cancelled);
        }
        state.active += 1;
        Ok(ProcessPermit { supervisor: self })
    }
}

struct ProcessPermit<'a> {
    supervisor: &'a BoundedProcessSupervisor,
}

impl Drop for ProcessPermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .supervisor
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active = state.active.saturating_sub(1);
        self.supervisor.available.notify_one();
    }
}

fn terminate_then_kill(
    tree: &debrute_native_process::ChildProcessTree,
    child: &mut std::process::Child,
) -> std::io::Result<()> {
    let terminate_error = tree.terminate().err();
    if wait_for_child(child, TERMINATE_GRACE)?.is_some() {
        tree.force_kill()?;
        return Ok(());
    }
    tree.force_kill()?;
    if wait_for_child(child, FORCE_KILL_GRACE)?.is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "worker process did not exit after force-kill",
        ));
    }
    if let Some(error) = terminate_error {
        return Err(error);
    }
    Ok(())
}

fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(WAIT_POLL);
    }
}

fn kill_and_reap_bounded(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = wait_for_child(child, FORCE_KILL_GRACE);
}

struct OutputCapture {
    tail: Arc<Mutex<BoundedTail>>,
    error: Arc<Mutex<Option<String>>>,
    done: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
}

trait CancellableOutputReader: Read + Send + 'static {
    fn configure(&self) -> std::io::Result<()>;
    fn readiness(&self) -> std::io::Result<debrute_native_process::PipeReadiness>;
}

macro_rules! impl_cancellable_output_reader {
    ($type:ty) => {
        impl CancellableOutputReader for $type {
            fn configure(&self) -> std::io::Result<()> {
                debrute_native_process::configure_output_pipe(self)
            }

            fn readiness(&self) -> std::io::Result<debrute_native_process::PipeReadiness> {
                debrute_native_process::output_pipe_readiness(self)
            }
        }
    };
}

impl_cancellable_output_reader!(std::process::ChildStdout);
impl_cancellable_output_reader!(std::process::ChildStderr);

fn spawn_output_reader(
    mut reader: impl CancellableOutputReader,
    limit: usize,
    name: &str,
) -> std::io::Result<OutputCapture> {
    reader.configure()?;
    let tail = Arc::new(Mutex::new(BoundedTail::new(limit)));
    let error = Arc::new(Mutex::new(None));
    let done = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let reader_tail = Arc::clone(&tail);
    let reader_error = Arc::clone(&error);
    let reader_done = Arc::clone(&done);
    let reader_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            while !reader_stop.load(Ordering::Acquire) {
                match reader.readiness() {
                    Ok(debrute_native_process::PipeReadiness::Pending) => {
                        thread::sleep(WAIT_POLL);
                        continue;
                    }
                    Ok(debrute_native_process::PipeReadiness::Closed) => break,
                    Ok(debrute_native_process::PipeReadiness::Ready) => {}
                    Err(read_error) => {
                        if let Ok(mut error) = reader_error.lock() {
                            *error = Some(read_error.to_string());
                        }
                        break;
                    }
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if let Ok(mut tail) = reader_tail.lock() {
                            tail.push(&buffer[..read]);
                        } else {
                            break;
                        }
                    }
                    Err(read_error) if read_error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(WAIT_POLL);
                    }
                    Err(read_error) => {
                        if let Ok(mut error) = reader_error.lock() {
                            *error = Some(read_error.to_string());
                        }
                        break;
                    }
                }
            }
            reader_done.store(true, Ordering::Release);
        })?;
    Ok(OutputCapture {
        tail,
        error,
        done,
        stop,
        reader: Some(thread),
    })
}

fn adopt_output(
    output: &mut ProcessOutput,
    stdout: Option<OutputCapture>,
    stderr: Option<OutputCapture>,
) {
    if let Some(reader) = stdout {
        let ((value, truncated), error) = reader.snapshot();
        output.stdout = value;
        output.stdout_truncated = truncated;
        if let Some(error) = error {
            output.ok = false;
            output.error_kind = Some(ProcessErrorKind::OutputError);
            append_diagnostic(&mut output.stderr, &error);
        }
    }
    if let Some(reader) = stderr {
        let ((value, truncated), error) = reader.snapshot();
        append_diagnostic(&mut output.stderr, &value);
        output.stderr_truncated = truncated;
        if let Some(error) = error {
            output.ok = false;
            output.error_kind = Some(ProcessErrorKind::OutputError);
            append_diagnostic(&mut output.stderr, &error);
        }
    }
}

fn append_diagnostic(target: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push('\n');
    }
    target.push_str(value);
}

impl OutputCapture {
    fn snapshot(mut self) -> ((String, bool), Option<String>) {
        let deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
        while !self.done.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(WAIT_POLL);
        }
        let drain_timed_out = !self.done.load(Ordering::Acquire);
        self.stop.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take()
            && reader.join().is_err()
            && let Ok(mut error) = self.error.lock()
        {
            *error = Some("worker output reader panicked".to_owned());
        }
        let (tail, truncated) = self
            .tail
            .lock()
            .map(|tail| tail.snapshot())
            .unwrap_or_default();
        let mut error = self.error.lock().ok().and_then(|error| error.clone());
        if drain_timed_out {
            let message = "worker output did not drain before the bounded deadline";
            error = Some(
                error.map_or_else(|| message.to_owned(), |error| format!("{error}; {message}")),
            );
        }
        ((tail, truncated || drain_timed_out), error)
    }
}

fn failed_output(kind: WorkerKind, error_kind: ProcessErrorKind, message: &str) -> ProcessOutput {
    ProcessOutput {
        kind,
        ok: false,
        exit_code: None,
        error_kind: Some(error_kind),
        stdout: String::new(),
        stderr: message.to_owned(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

struct BoundedTail {
    bytes: VecDeque<u8>,
    limit: usize,
    truncated: bool,
}

impl BoundedTail {
    fn new(limit: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(limit),
            limit,
            truncated: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.limit {
            self.bytes.clear();
            self.bytes.extend(
                bytes[bytes.len().saturating_sub(self.limit)..]
                    .iter()
                    .copied(),
            );
            self.truncated = true;
            return;
        }
        while self.bytes.len() + bytes.len() > self.limit {
            self.bytes.pop_front();
            self.truncated = true;
        }
        self.bytes.extend(bytes.iter().copied());
    }

    fn snapshot(&self) -> (String, bool) {
        let bytes = self.bytes.iter().copied().collect::<Vec<_>>();
        (String::from_utf8_lossy(&bytes).into_owned(), self.truncated)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn worker_output_is_bounded_to_its_tail() {
        let supervisor = BoundedProcessSupervisor::new(1);
        let mut request = ProcessRequest::new(
            WorkerKind::IntegrationProbe,
            "/bin/sh",
            vec!["-c".to_owned(), "printf 0123456789".to_owned()],
            Duration::from_secs(2),
        );
        request.output_limit = 4;
        let output = supervisor.run(request, &ProcessCancellation::default());
        assert!(output.ok);
        assert_eq!(output.stdout, "6789");
        assert!(output.stdout_truncated);
    }

    #[test]
    fn timeout_terminates_the_owned_worker_tree() {
        let supervisor = BoundedProcessSupervisor::new(1);
        let request = ProcessRequest::new(
            WorkerKind::MediaProbe,
            "/bin/sh",
            vec!["-c".to_owned(), "sleep 30 & wait".to_owned()],
            Duration::from_millis(30),
        );
        let output = supervisor.run(request, &ProcessCancellation::default());
        assert_eq!(output.error_kind, Some(ProcessErrorKind::Timeout));
    }

    #[test]
    fn cancellation_before_admission_never_spawns() {
        let supervisor = BoundedProcessSupervisor::new(1);
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        let request = ProcessRequest::new(
            WorkerKind::NativeShell,
            "/usr/bin/false",
            Vec::new(),
            Duration::from_secs(1),
        );
        assert_eq!(
            supervisor.run(request, &cancellation).error_kind,
            Some(ProcessErrorKind::Cancelled)
        );
    }

    #[test]
    fn occupied_process_capacity_has_a_bounded_admission_wait() {
        let supervisor = Arc::new(BoundedProcessSupervisor::new(1));
        let permit = supervisor
            .acquire(&ProcessCancellation::default(), Duration::from_secs(1))
            .unwrap();
        let waiting = Arc::clone(&supervisor);
        let result = thread::spawn(move || {
            waiting
                .acquire(&ProcessCancellation::default(), Duration::from_millis(20))
                .err()
        })
        .join()
        .unwrap();
        assert_eq!(result, Some(ProcessErrorKind::Backpressure));
        drop(permit);
    }
}
