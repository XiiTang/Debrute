//! Recursive Project filesystem observation with burst event batching.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use notify::{
    Event, EventKind,
    event::{ModifyKind, RenameMode},
};
#[cfg(not(test))]
use notify::{RecursiveMode, Watcher};

use super::{ProjectError, is_project_visible_path};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(40);

pub(super) type ProjectWatchEventHandler = Box<dyn FnMut(notify::Result<Event>) + Send + 'static>;
pub(super) type ProjectWatchGuard = Box<dyn Send>;

pub(super) trait ProjectWatchBackendFactory: Send + Sync {
    fn start(
        &self,
        project_root: &Path,
        event_handler: ProjectWatchEventHandler,
    ) -> notify::Result<ProjectWatchGuard>;
}

#[cfg(not(test))]
pub(super) struct NativeProjectWatchBackendFactory;

#[cfg(not(test))]
impl ProjectWatchBackendFactory for NativeProjectWatchBackendFactory {
    fn start(
        &self,
        project_root: &Path,
        event_handler: ProjectWatchEventHandler,
    ) -> notify::Result<ProjectWatchGuard> {
        let mut watcher = notify::recommended_watcher(event_handler)?;
        watcher.watch(project_root, RecursiveMode::Recursive)?;
        Ok(Box::new(watcher))
    }
}

#[cfg(any(test, feature = "test-support"))]
pub(super) struct NoopProjectWatchBackendFactory;

#[cfg(any(test, feature = "test-support"))]
impl ProjectWatchBackendFactory for NoopProjectWatchBackendFactory {
    fn start(
        &self,
        _project_root: &Path,
        _event_handler: ProjectWatchEventHandler,
    ) -> notify::Result<ProjectWatchGuard> {
        Ok(Box::new(()))
    }
}

enum WatchMessage {
    Event(notify::Result<Event>),
    Stop,
}

pub(super) enum ProjectWatchSignal {
    Paths(Vec<ProjectWatchPath>),
    RescanRequired(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectWatchPath {
    pub project_relative_path: String,
    pub resets_identity: bool,
}

impl ProjectWatchPath {
    pub(super) fn modified(project_relative_path: String) -> Self {
        Self {
            project_relative_path,
            resets_identity: false,
        }
    }
}

pub(super) struct ProjectFileWatcher {
    watch_guard: Option<ProjectWatchGuard>,
    sender: mpsc::Sender<WatchMessage>,
    worker: Option<JoinHandle<()>>,
}

impl ProjectFileWatcher {
    /// Starts one native recursive Project-root subscription and a coalescing
    /// delivery worker. Debrute's supported macOS and Windows backends own the
    /// recursive subscription; Runtime filters events before Project refresh.
    ///
    /// # Errors
    /// Returns an error when the watcher or worker cannot be created.
    pub(super) fn start(
        project_root: &Path,
        backend_factory: &dyn ProjectWatchBackendFactory,
        is_loaded_dependency: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        on_change: Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
    ) -> Result<Self, ProjectError> {
        let root = project_root.to_path_buf();
        let (sender, receiver) = mpsc::channel();
        let event_sender = sender.clone();
        let event_handler: ProjectWatchEventHandler = Box::new(move |event| {
            let _ = event_sender.send(WatchMessage::Event(event));
        });
        let watch_guard = backend_factory
            .start(project_root, event_handler)
            .map_err(|error| watch_error(&error))?;
        let worker = thread::Builder::new()
            .name("debrute-project-watch".to_owned())
            .spawn(move || {
                watch_worker(&root, &receiver, &is_loaded_dependency, &on_change);
            })?;
        Ok(Self {
            watch_guard: Some(watch_guard),
            sender,
            worker: Some(worker),
        })
    }

    /// Stops observation and joins the delivery worker.
    ///
    pub(super) fn close(&mut self) {
        self.watch_guard.take();
        let _ = self.sender.send(WatchMessage::Stop);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("Project watcher thread panicked");
        }
    }
}

impl Drop for ProjectFileWatcher {
    fn drop(&mut self) {
        self.close();
    }
}

fn watch_worker(
    root: &Path,
    receiver: &mpsc::Receiver<WatchMessage>,
    is_loaded_dependency: &Arc<dyn Fn(&str) -> bool + Send + Sync>,
    on_change: &Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
) {
    let mut pending = HashMap::<String, (Instant, bool)>::new();
    loop {
        flush_ready(&mut pending, on_change);
        let timeout = pending
            .values()
            .min()
            .map_or(Duration::from_mins(1), |(deadline, _)| {
                deadline.saturating_duration_since(Instant::now())
            });
        match receiver.recv_timeout(timeout) {
            Ok(WatchMessage::Event(Ok(event))) => {
                queue_event(root, event, is_loaded_dependency, &mut pending);
            }
            Ok(WatchMessage::Event(Err(error))) => {
                on_change(ProjectWatchSignal::RescanRequired(error.to_string()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(WatchMessage::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn flush_ready(
    pending: &mut HashMap<String, (Instant, bool)>,
    on_change: &Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
) {
    let now = Instant::now();
    let mut ready = pending
        .iter()
        .filter_map(|(path, (deadline, _))| (*deadline <= now).then_some(path.clone()))
        .collect::<Vec<_>>();
    ready.sort();
    let ready = ready
        .into_iter()
        .filter_map(|path| {
            pending
                .remove(&path)
                .map(|(_, resets_identity)| ProjectWatchPath {
                    project_relative_path: path,
                    resets_identity,
                })
        })
        .collect::<Vec<_>>();
    if !ready.is_empty() {
        on_change(ProjectWatchSignal::Paths(ready));
    }
}

fn queue_event(
    root: &Path,
    event: Event,
    is_loaded_dependency: &Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pending: &mut HashMap<String, (Instant, bool)>,
) {
    let deadline = Instant::now() + WATCH_DEBOUNCE;
    let event_kind = event.kind;
    let path_count = event.paths.len();
    for path in event.paths {
        let Some(relative) = project_relative_path(root, &path) else {
            continue;
        };
        if is_loaded_dependency(&relative) && is_project_visible_path(&relative) {
            let resets_identity = match event_kind {
                EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::To)) => true,
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if path_count >= 2 => true,
                _ => false,
            };
            pending
                .entry(relative)
                .and_modify(|entry| {
                    entry.0 = deadline;
                    entry.1 |= resets_identity;
                })
                .or_insert((deadline, resets_identity));
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

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    #[test]
    fn event_filter_keeps_only_loaded_visible_paths() {
        let root = std::env::temp_dir().join(format!("debrute-watch-explicit-{}", Uuid::new_v4()));
        let dependency: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(|path| {
            path == "node_modules/pkg/index.js" || path == ".debrute/feedback/feedback.json"
        });
        let mut pending = HashMap::new();

        queue_event(
            &root,
            Event {
                kind: notify::EventKind::Any,
                paths: vec![
                    root.join("node_modules/pkg/index.js"),
                    root.join("unloaded/noise.txt"),
                    root.join(".git/objects/pack"),
                    root.join(".debrute/feedback/feedback.json"),
                ],
                attrs: notify::event::EventAttributes::default(),
            },
            &dependency,
            &mut pending,
        );

        assert!(pending.contains_key("node_modules/pkg/index.js"));
        assert!(pending.contains_key(".debrute/feedback/feedback.json"));
        assert!(!pending.contains_key("unloaded/noise.txt"));
        assert!(!pending.contains_key(".git/objects/pack"));
    }

    #[test]
    fn create_remove_and_rename_events_reset_path_identity() {
        let root = std::env::temp_dir().join(format!("debrute-watch-identity-{}", Uuid::new_v4()));
        let dependency: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(|_| true);
        let mut pending = HashMap::new();
        for kind in [
            notify::EventKind::Remove(notify::event::RemoveKind::File),
            notify::EventKind::Create(notify::event::CreateKind::File),
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        ] {
            queue_event(
                &root,
                Event {
                    kind,
                    paths: vec![root.join("old.txt"), root.join("new.txt")],
                    attrs: notify::event::EventAttributes::default(),
                },
                &dependency,
                &mut pending,
            );
        }
        assert!(
            pending
                .values()
                .all(|(_, resets_identity)| *resets_identity)
        );
    }

    #[test]
    fn backend_errors_request_a_refresh_of_loaded_authority() {
        let root = std::env::temp_dir().join(format!("debrute-watch-rescan-{}", Uuid::new_v4()));
        let (message_sender, message_receiver) = mpsc::channel();
        let (signal_sender, signal_receiver) = mpsc::channel();
        let dependency: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(|_| false);
        let on_change: Arc<dyn Fn(ProjectWatchSignal) + Send + Sync> =
            Arc::new(move |signal| signal_sender.send(signal).unwrap());
        let worker_root = root.clone();
        let worker = thread::spawn(move || {
            watch_worker(&worker_root, &message_receiver, &dependency, &on_change);
        });

        message_sender
            .send(WatchMessage::Event(Err(notify::Error::generic(
                "dropped event",
            ))))
            .unwrap();
        match signal_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
        {
            ProjectWatchSignal::RescanRequired(message) => {
                assert!(message.contains("dropped event"));
            }
            ProjectWatchSignal::Paths(paths) => panic!("unexpected filtered paths: {paths:?}"),
        }

        message_sender.send(WatchMessage::Stop).unwrap();
        worker.join().unwrap();
    }
}
