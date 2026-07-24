//! Recursive Project filesystem observation with path-local event coalescing.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use super::{ProjectError, is_project_visible_path};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(40);

enum WatchMessage {
    Event(notify::Result<Event>),
    Stop,
    #[cfg(test)]
    Panic,
    #[cfg(test)]
    BackendError(String),
}

pub(super) enum ProjectWatchSignal {
    Path(String),
    RescanRequired(String),
}

pub(super) struct ProjectFileWatcher {
    watcher: Option<RecommendedWatcher>,
    sender: mpsc::Sender<WatchMessage>,
    worker: Option<JoinHandle<()>>,
}

impl ProjectFileWatcher {
    /// Starts recursive observation and a coalescing delivery worker.
    ///
    /// # Errors
    /// Returns an error when the watcher or worker cannot be created.
    pub(super) fn start(
        project_root: &Path,
        on_change: Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
    ) -> Result<Self, ProjectError> {
        let root = project_root.to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let event_sender = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = event_sender.send(WatchMessage::Event(event));
        })
        .map_err(|error| watch_error(&error))?;
        watcher
            .watch(project_root, RecursiveMode::Recursive)
            .map_err(|error| watch_error(&error))?;
        let worker = thread::Builder::new()
            .name("debrute-project-watch".to_owned())
            .spawn(move || watch_worker(&root, &receiver, &on_change))?;
        Ok(Self {
            watcher: Some(watcher),
            sender,
            worker: Some(worker),
        })
    }

    /// Stops observation and joins the delivery worker.
    ///
    /// # Errors
    /// Returns an error if the worker panicked.
    pub(super) fn close(&mut self) -> Result<(), ProjectError> {
        self.watcher.take();
        let _ = self.sender.send(WatchMessage::Stop);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| {
                ProjectError::service("project_watcher_failed", "Project watcher thread panicked.")
            })?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn fail_worker_for_test(&self) -> Result<(), ProjectError> {
        self.sender
            .send(WatchMessage::Panic)
            .map_err(|error| ProjectError::service("project_watcher_failed", error.to_string()))
    }

    #[cfg(test)]
    pub(super) fn report_backend_error_for_test(&self, message: &str) -> Result<(), ProjectError> {
        self.sender
            .send(WatchMessage::BackendError(message.to_owned()))
            .map_err(|error| ProjectError::service("project_watcher_failed", error.to_string()))
    }
}

impl Drop for ProjectFileWatcher {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn watch_worker(
    root: &Path,
    receiver: &mpsc::Receiver<WatchMessage>,
    on_change: &Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
) {
    let mut pending = HashMap::<String, Instant>::new();
    loop {
        flush_ready(&mut pending, on_change);
        let timeout = pending
            .values()
            .min()
            .map_or(Duration::from_mins(1), |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
        match receiver.recv_timeout(timeout) {
            Ok(WatchMessage::Event(Ok(event))) => queue_event(root, event, &mut pending),
            Ok(WatchMessage::Event(Err(error))) => {
                on_change(ProjectWatchSignal::RescanRequired(error.to_string()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(WatchMessage::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            #[cfg(test)]
            Ok(WatchMessage::Panic) => panic!("injected Project watcher failure"),
            #[cfg(test)]
            Ok(WatchMessage::BackendError(message)) => {
                on_change(ProjectWatchSignal::RescanRequired(message));
            }
        }
    }
}

fn flush_ready(
    pending: &mut HashMap<String, Instant>,
    on_change: &Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
) {
    let now = Instant::now();
    let mut ready = pending
        .iter()
        .filter_map(|(path, deadline)| (*deadline <= now).then_some(path.clone()))
        .collect::<Vec<_>>();
    ready.sort();
    for path in ready {
        pending.remove(&path);
        on_change(ProjectWatchSignal::Path(path));
    }
}

fn queue_event(root: &Path, event: Event, pending: &mut HashMap<String, Instant>) {
    let deadline = Instant::now() + WATCH_DEBOUNCE;
    for path in event.paths {
        if let Some(relative) = project_relative_path(root, &path)
            && is_project_visible_path(&relative)
        {
            pending.insert(relative, deadline);
        }
    }
}

fn project_relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    (!relative.is_empty()).then_some(relative)
}

fn watch_error(error: &notify::Error) -> ProjectError {
    ProjectError::service("project_watcher_failed", error.to_string())
}
