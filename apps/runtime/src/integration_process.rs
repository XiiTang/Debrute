//! Native integration execution through the Runtime's one bounded supervisor.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::{
    executable_path::resolve_executable,
    integrations::{
        CommandResult, IntegrationCommand, IntegrationDiagnostic, IntegrationProcessAdapter,
        Platform, ProbeResult,
    },
    process::{
        BoundedProcessSupervisor, ProcessCancellation, ProcessOutput, ProcessRequest, WorkerKind,
    },
};

const DIAGNOSTIC_TAIL_LIMIT: usize = 4096;

pub(crate) struct NativeIntegrationProcessAdapter {
    supervisor: Arc<BoundedProcessSupervisor>,
}

impl NativeIntegrationProcessAdapter {
    pub(crate) fn from_supervisor(supervisor: Arc<BoundedProcessSupervisor>) -> Self {
        Self { supervisor }
    }
}

impl IntegrationProcessAdapter for NativeIntegrationProcessAdapter {
    fn resolve_executable(
        &self,
        name: &str,
        env_path: &OsStr,
        platform: Platform,
        path_ext: &OsStr,
    ) -> Option<PathBuf> {
        resolve_executable(name, env_path, platform, path_ext)
    }

    fn run_probe(&self, file: &Path, args: &[String], timeout_ms: u64) -> ProbeResult {
        let mut request = ProcessRequest::new(
            WorkerKind::IntegrationProbe,
            file,
            args.to_vec(),
            Duration::from_millis(timeout_ms),
        );
        request.output_limit = DIAGNOSTIC_TAIL_LIMIT;
        let output = self
            .supervisor
            .run(request, &ProcessCancellation::default());
        ProbeResult {
            ok: output.ok,
            stdout: output.stdout,
            stderr: output.stderr,
            exit_code: output.exit_code,
            error_kind: output.error_kind.map(|kind| kind.as_str().to_owned()),
        }
    }

    fn run_command(&self, command: &IntegrationCommand) -> CommandResult {
        let output = self.supervisor.run(
            ProcessRequest::new(
                WorkerKind::IntegrationCommand,
                &command.file,
                command.args.clone(),
                Duration::from_millis(command.timeout_ms),
            ),
            &ProcessCancellation::default(),
        );
        command_result(output)
    }
}

fn command_result(output: ProcessOutput) -> CommandResult {
    let stdout_tail = non_empty(tail(&output.stdout, DIAGNOSTIC_TAIL_LIMIT));
    let stderr_tail = non_empty(tail(&output.stderr, DIAGNOSTIC_TAIL_LIMIT));
    CommandResult {
        ok: output.ok,
        stdout: output.stdout,
        stderr: output.stderr,
        diagnostic: IntegrationDiagnostic {
            exit_code: output.exit_code,
            error_kind: output.error_kind.map(|kind| kind.as_str().to_owned()),
            stdout_tail,
            stderr_tail,
        },
    }
}

fn tail(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn native_probe_reports_closed_nonzero_and_timeout_diagnostics() {
        let adapter = NativeIntegrationProcessAdapter::from_supervisor(Arc::new(
            BoundedProcessSupervisor::new(1),
        ));
        let nonzero = adapter.run_probe(
            Path::new("/bin/sh"),
            &[
                "-c".to_owned(),
                "printf out; printf err >&2; exit 7".to_owned(),
            ],
            2_000,
        );
        assert!(!nonzero.ok);
        assert_eq!(nonzero.exit_code, Some(7));
        assert_eq!(nonzero.error_kind.as_deref(), Some("nonzero_exit"));
        assert_eq!(nonzero.stdout, "out");
        assert_eq!(nonzero.stderr, "err");

        let timeout = adapter.run_probe(
            Path::new("/bin/sh"),
            &["-c".to_owned(), "sleep 30".to_owned()],
            20,
        );
        assert_eq!(timeout.error_kind.as_deref(), Some("timeout"));
    }
}
