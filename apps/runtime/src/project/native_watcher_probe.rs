//! Supervised proof that the production Project watcher wiring observes native events.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use super::{
    ProjectError,
    registry::default_watch_backend_factory,
    watcher::{ProjectFileWatcher, ProjectWatchSignal},
};

const EVENT_DEADLINE: Duration = Duration::from_secs(5);
const WATCHER_COUNT: usize = 4;

struct ProbeWatch {
    _watcher: ProjectFileWatcher,
    event_receiver: mpsc::Receiver<ProjectWatchSignal>,
    changed_path: PathBuf,
    expected_project_path: String,
}

/// Exercises the production default watcher factory and Project watcher worker.
///
/// # Errors
///
/// Returns an error when a watcher cannot start, a fixture cannot be written, or
/// the production watcher pipeline does not publish the expected Project Path.
pub fn run_native_project_watcher_probe(root: &Path) -> Result<usize, ProjectError> {
    let root = root.canonicalize()?;
    let backend_factory = default_watch_backend_factory();
    let mut probes = Vec::with_capacity(WATCHER_COUNT);
    for index in 0..WATCHER_COUNT {
        let watch_root = root.join(format!("project-{index}"));
        fs::create_dir(&watch_root)?;
        let (event_sender, event_receiver) = mpsc::channel();
        let on_change = Arc::new(move |signal| {
            let _ = event_sender.send(signal);
        });
        let watcher = ProjectFileWatcher::start(
            &watch_root,
            backend_factory.as_ref(),
            Arc::new(|_| true),
            on_change,
        )?;
        probes.push(ProbeWatch {
            _watcher: watcher,
            event_receiver,
            changed_path: watch_root.join("changed.txt"),
            expected_project_path: "changed.txt".to_owned(),
        });
    }

    for probe in &probes {
        fs::write(&probe.changed_path, "changed")?;
    }

    let deadline = Instant::now() + EVENT_DEADLINE;
    for probe in &probes {
        wait_for_expected_path(probe, deadline)?;
    }
    Ok(probes.len())
}

fn wait_for_expected_path(probe: &ProbeWatch, deadline: Instant) -> Result<(), ProjectError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match probe.event_receiver.recv_timeout(remaining) {
            Ok(ProjectWatchSignal::Paths(paths))
                if paths
                    .iter()
                    .any(|path| path.project_relative_path == probe.expected_project_path) =>
            {
                return Ok(());
            }
            Ok(ProjectWatchSignal::Paths(_)) => {}
            Ok(ProjectWatchSignal::RescanRequired(message)) => {
                return Err(ProjectError::service("project_watcher_failed", message));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(ProjectError::service(
                    "project_watcher_failed",
                    format!(
                        "native watcher did not report {} before its deadline",
                        probe.changed_path.display()
                    ),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ProjectError::service(
                    "project_watcher_failed",
                    "native watcher event channel disconnected",
                ));
            }
        }
    }
}
