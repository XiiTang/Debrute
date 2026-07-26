//! Recursive Project filesystem observation with burst event batching.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use super::{ProjectError, is_project_indexed_path, is_project_visible_path};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(40);

enum WatchMessage {
    Event(notify::Result<Event>),
    Stop,
    #[cfg(test)]
    BackendError(String),
}

pub(super) enum ProjectWatchSignal {
    Paths(Vec<String>),
    RescanRequired(String),
}

pub(super) struct ProjectFileWatcher {
    watcher: Option<RecommendedWatcher>,
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
        is_explicit_dependency: Arc<dyn Fn(&str) -> bool + Send + Sync>,
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
            .spawn(move || {
                watch_worker(&root, &receiver, &is_explicit_dependency, &on_change);
            })?;
        Ok(Self {
            watcher: Some(watcher),
            sender,
            worker: Some(worker),
        })
    }

    /// Stops observation and joins the delivery worker.
    ///
    pub(super) fn close(&mut self) {
        self.watcher.take();
        let _ = self.sender.send(WatchMessage::Stop);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("Project watcher thread panicked");
        }
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
        self.close();
    }
}

fn watch_worker(
    root: &Path,
    receiver: &mpsc::Receiver<WatchMessage>,
    is_explicit_dependency: &Arc<dyn Fn(&str) -> bool + Send + Sync>,
    on_change: &Arc<dyn Fn(ProjectWatchSignal) + Send + Sync>,
) {
    let mut pending = HashMap::<String, Instant>::new();
    let mut indexed_directories = HashMap::<String, bool>::new();
    loop {
        flush_ready(&mut pending, on_change);
        let timeout = pending
            .values()
            .min()
            .map_or(Duration::from_mins(1), |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
        match receiver.recv_timeout(timeout) {
            Ok(WatchMessage::Event(Ok(event))) => {
                queue_event(
                    root,
                    event,
                    is_explicit_dependency,
                    &mut pending,
                    &mut indexed_directories,
                );
            }
            Ok(WatchMessage::Event(Err(error))) => {
                on_change(ProjectWatchSignal::RescanRequired(error.to_string()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(WatchMessage::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
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
    for path in &ready {
        pending.remove(path);
    }
    if !ready.is_empty() {
        on_change(ProjectWatchSignal::Paths(ready));
    }
}

fn queue_event(
    root: &Path,
    event: Event,
    is_explicit_dependency: &Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pending: &mut HashMap<String, Instant>,
    indexed_directories: &mut HashMap<String, bool>,
) {
    let deadline = Instant::now() + WATCH_DEBOUNCE;
    for path in event.paths {
        let Some(relative) = project_relative_path(root, &path) else {
            continue;
        };
        if is_gitignore_path(&relative) {
            indexed_directories.clear();
        }
        let indexed = if is_gitignore_path(&relative) {
            relative
                .rsplit_once('/')
                .is_none_or(|(parent, _)| is_indexed_directory(root, parent, indexed_directories))
        } else {
            is_indexed_event_path(root, &relative, path.is_dir(), indexed_directories)
        };
        if is_project_visible_path(&relative) && (indexed || is_explicit_dependency(&relative)) {
            pending.insert(relative, deadline);
        }
    }
}

fn is_indexed_event_path(
    root: &Path,
    relative: &str,
    is_dir: bool,
    indexed_directories: &mut HashMap<String, bool>,
) -> bool {
    if let Some((parent, _)) = relative.rsplit_once('/')
        && !is_indexed_directory(root, parent, indexed_directories)
    {
        return false;
    }
    let indexed = is_project_indexed_path(root, relative, is_dir).unwrap_or(false);
    if is_dir {
        indexed_directories.insert(relative.to_owned(), indexed);
    }
    indexed
}

fn is_indexed_directory(
    root: &Path,
    relative: &str,
    indexed_directories: &mut HashMap<String, bool>,
) -> bool {
    indexed_directories
        .get(relative)
        .copied()
        .unwrap_or_else(|| {
            let indexed = is_project_indexed_path(root, relative, true).unwrap_or(false);
            indexed_directories.insert(relative.to_owned(), indexed);
            indexed
        })
}

fn is_gitignore_path(path: &str) -> bool {
    path == ".gitignore" || path.ends_with("/.gitignore")
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
    use std::fs;

    use uuid::Uuid;

    use super::*;

    #[test]
    fn event_filter_skips_generated_and_nested_ignored_subtrees() {
        let root = std::env::temp_dir().join(format!("debrute-watch-filter-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("repo/vendor-cache")).unwrap();
        fs::create_dir_all(root.join("repo/node_modules/package")).unwrap();
        fs::create_dir_all(root.join("repo/src")).unwrap();
        fs::write(root.join("repo/.gitignore"), "vendor-cache/\n").unwrap();
        let mut cache = HashMap::new();

        assert!(is_indexed_event_path(
            &root,
            "repo/src/main.rs",
            false,
            &mut cache
        ));
        assert!(!is_indexed_event_path(
            &root,
            "repo/vendor-cache/large.bin",
            false,
            &mut cache
        ));
        assert!(!is_indexed_event_path(
            &root,
            "repo/.git/objects/pack",
            false,
            &mut cache
        ));
        assert!(!is_indexed_event_path(
            &root,
            "repo/node_modules/package/index.js",
            false,
            &mut cache
        ));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn event_filter_keeps_only_explicit_dependencies_inside_excluded_trees() {
        let root = std::env::temp_dir().join(format!("debrute-watch-explicit-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/render.png"), "render").unwrap();
        fs::write(root.join("dist/noise.tmp"), "noise").unwrap();
        let dependency: Arc<dyn Fn(&str) -> bool + Send + Sync> =
            Arc::new(|path| path == "dist/render.png");
        let mut pending = HashMap::new();
        let mut cache = HashMap::new();

        queue_event(
            &root,
            Event {
                kind: notify::EventKind::Any,
                paths: vec![root.join("dist/render.png"), root.join("dist/noise.tmp")],
                attrs: notify::event::EventAttributes::default(),
            },
            &dependency,
            &mut pending,
            &mut cache,
        );

        assert!(pending.contains_key("dist/render.png"));
        assert!(!pending.contains_key("dist/noise.tmp"));
        fs::remove_dir_all(root).unwrap();
    }
}
