//! Native integration execution through the Runtime's one bounded supervisor.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use crate::{
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
        env_path: &str,
        platform: Platform,
        path_ext: &str,
    ) -> Option<PathBuf> {
        if name.is_empty()
            || Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name)
        {
            return None;
        }
        split_path(env_path, platform)
            .flat_map(|directory| {
                executable_candidate_names(name, platform, path_ext)
                    .into_iter()
                    .map(move |candidate| Path::new(directory).join(candidate))
            })
            .find(|candidate| is_executable(candidate, platform))
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

fn split_path(value: &str, platform: Platform) -> impl Iterator<Item = &str> {
    value
        .split(if platform == Platform::Windows {
            ';'
        } else {
            ':'
        })
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
}

fn executable_candidate_names(name: &str, platform: Platform, path_ext: &str) -> Vec<String> {
    if platform != Platform::Windows {
        return vec![name.to_owned()];
    }
    let extensions = path_ext
        .split(';')
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .collect::<Vec<_>>();
    if extensions.iter().any(|extension| {
        name.to_ascii_lowercase()
            .ends_with(&extension.to_ascii_lowercase())
    }) {
        return vec![name.to_owned()];
    }
    std::iter::once(name.to_owned())
        .chain(
            extensions
                .into_iter()
                .map(|extension| format!("{name}{extension}")),
        )
        .collect()
}

fn is_executable(path: &Path, platform: Platform) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if platform == Platform::Windows {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    false
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
    use std::{fs, os::unix::fs::PermissionsExt as _};

    use super::*;

    #[test]
    fn executable_resolution_obeys_platform_path_and_permissions() {
        let root =
            std::env::temp_dir().join(format!("debrute-integration-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let executable = root.join("ffprobe");
        fs::write(&executable, "fixture").expect("fixture should be written");
        let adapter = NativeIntegrationProcessAdapter::from_supervisor(Arc::new(
            BoundedProcessSupervisor::new(1),
        ));
        assert_eq!(
            adapter.resolve_executable("ffprobe", root.to_str().unwrap(), Platform::MacOs, ""),
            None
        );
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("fixture should become executable");
        assert_eq!(
            adapter.resolve_executable("ffprobe", root.to_str().unwrap(), Platform::MacOs, ""),
            Some(executable)
        );
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

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
