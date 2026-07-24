//! Serialized PTY sessions, topology, observation, and ordered input.

use std::{
    collections::{HashMap, VecDeque},
    fmt,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use uuid::Uuid;

use crate::project::{
    ProjectSessionRegistry, ProjectUse, ProjectUseKind, normalize_project_directory_path,
    parent_project_path, resolve_no_symlink_existing_project_path,
};

use super::{
    emulator::TerminalEmulator,
    protocol::{TerminalCheckpoint, TerminalSessionStatus, TerminalSessionView},
};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MAX_TERMINAL_COLS: u16 = 200;
const MAX_TERMINAL_ROWS: u16 = 100;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const TERMINAL_COMMAND_CAPACITY: usize = 256;
const TERMINAL_INPUT_CAPACITY: usize = 32;
const TERMINAL_EVENT_CAPACITY: usize = 8;
const TERMINAL_TOPOLOGY_CAPACITY: usize = 16;
const MAX_TERMINAL_OBSERVERS: usize = 8;
const MAX_TERMINAL_TOPOLOGY_OBSERVERS: usize = 32;
const MAX_TERMINAL_OBSERVER_ID_BYTES: usize = 128;
const MAX_TERMINALS_PER_PROJECT: usize = 8;
const MAX_TERMINALS_PER_RUNTIME: usize = 16;
const TERMINAL_CLOSE_GRACE: Duration = Duration::from_secs(1);
const TERMINAL_FORCE_KILL_GRACE: Duration = Duration::from_secs(2);
const TERMINAL_CLOSE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const TERMINAL_CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(4);
const TERMINAL_INPUT_ACK_TIMEOUT: Duration = Duration::from_secs(30);
const TERMINAL_START_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_OUTPUT_COALESCE: Duration = Duration::from_millis(4);
const TERMINAL_OUTPUT_COALESCE_MAX_CHUNKS: usize = 8;
const TERMINAL_OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(1);
#[cfg(target_os = "windows")]
const TERMINAL_BOOTSTRAP_FLAG: &str = "--internal-terminal-bootstrap";
#[cfg(target_os = "windows")]
const TERMINAL_SPAWN_BARRIER_ENV: &str = "DEBRUTE_INTERNAL_TERMINAL_SPAWN_BARRIER";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateTerminalSession {
    pub cwd_project_relative_path: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalError {
    code: &'static str,
    message: String,
}

impl TerminalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TerminalError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        terminal_id: String,
        sequence: u64,
        data_base64: String,
    },
    Status(TerminalSessionView),
    Exit {
        terminal_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    Error {
        terminal_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTopologySnapshot {
    pub revision: u64,
    pub sessions: Vec<TerminalSessionView>,
}

pub struct TerminalObservation {
    pub checkpoint: TerminalCheckpoint,
    receiver: mpsc::Receiver<TerminalEvent>,
    terminal: Weak<TerminalHandle>,
    observer_id: String,
    observation_id: Uuid,
    active: Arc<AtomicBool>,
}

impl TerminalObservation {
    /// Waits for the next ordered Terminal event.
    ///
    /// # Errors
    /// Returns an error after the observation stream closes.
    pub fn recv(&self) -> Result<TerminalEvent, mpsc::RecvError> {
        self.receiver.recv()
    }

    /// Waits up to `timeout` for the next ordered Terminal event.
    ///
    /// # Errors
    /// Returns timeout or disconnected receiver state.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<TerminalEvent, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }

    /// Attempts to receive the next ordered Terminal event without blocking.
    ///
    /// # Errors
    /// Returns empty or disconnected receiver state.
    pub fn try_recv(&self) -> Result<TerminalEvent, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }
}

impl Drop for TerminalObservation {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if let Some(terminal) = self.terminal.upgrade() {
            // A full queue already contains actor work; dropping the receiver makes the next
            // publication remove this observer without blocking the caller's destructor.
            let _ = terminal.commands.try_send(ActorCommand::Unobserve {
                observer_id: self.observer_id.clone(),
                observation_id: self.observation_id,
            });
        }
    }
}

pub struct TerminalTopologySubscription {
    pub snapshot: TerminalTopologySnapshot,
    receiver: mpsc::Receiver<TerminalTopologySnapshot>,
    service: Weak<TerminalServiceInner>,
    project_id: String,
    observer_id: Uuid,
}

impl TerminalTopologySubscription {
    /// Waits for the next topology revision.
    ///
    /// # Errors
    /// Returns an error after the topology stream closes.
    pub fn recv(&self) -> Result<TerminalTopologySnapshot, mpsc::RecvError> {
        self.receiver.recv()
    }

    /// Waits up to `timeout` for the next topology revision.
    ///
    /// # Errors
    /// Returns timeout or disconnected receiver state.
    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<TerminalTopologySnapshot, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }

    /// Attempts to receive the next topology revision without blocking.
    ///
    /// # Errors
    /// Returns empty or disconnected receiver state.
    pub fn try_recv(&self) -> Result<TerminalTopologySnapshot, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }
}

impl Drop for TerminalTopologySubscription {
    fn drop(&mut self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        if let Ok(mut projects) = service.projects.lock()
            && let Some(project) = projects.get_mut(&self.project_id)
        {
            project.observers.remove(&self.observer_id);
        }
    }
}

#[derive(Clone)]
pub struct TerminalService {
    inner: Arc<TerminalServiceInner>,
}

struct TerminalServiceInner {
    registry: ProjectSessionRegistry,
    projects: Mutex<HashMap<String, ProjectTerminals>>,
}

impl Drop for TerminalServiceInner {
    fn drop(&mut self) {
        let projects = self
            .projects
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let terminals = projects
            .values()
            .flat_map(|project| project.sessions.values().cloned())
            .collect::<Vec<_>>();
        for terminal in terminals {
            terminal.shutdown_with_fallback();
        }
        projects.clear();
    }
}

#[derive(Default)]
struct ProjectTerminals {
    revision: u64,
    reservations: usize,
    sessions: HashMap<String, Arc<TerminalHandle>>,
    observers: HashMap<Uuid, mpsc::SyncSender<TerminalTopologySnapshot>>,
}

struct TerminalHandle {
    id: String,
    view: Arc<Mutex<TerminalSessionView>>,
    final_checkpoint: Arc<Mutex<Option<Result<TerminalCheckpoint, TerminalError>>>>,
    commands: mpsc::SyncSender<ActorCommand>,
    actor: Mutex<Option<thread::JoinHandle<()>>>,
    tree: Arc<Mutex<Option<Arc<debrute_native_process::ChildProcessTree>>>>,
}

struct TerminalReservation {
    service: Weak<TerminalServiceInner>,
    project_id: String,
    active: bool,
}

impl TerminalService {
    #[must_use]
    pub fn new(registry: ProjectSessionRegistry) -> Self {
        Self {
            inner: Arc::new(TerminalServiceInner {
                registry,
                projects: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Creates one Project-owned, memory-only Terminal session.
    ///
    /// # Errors
    /// Returns a typed error for an invalid Project/cwd, PTY failure, or exhausted topology.
    #[allow(clippy::needless_pass_by_value)] // Creation consumes one command DTO at the boundary.
    pub fn create(
        &self,
        project_id: &str,
        input: CreateTerminalSession,
    ) -> Result<TerminalSessionView, TerminalError> {
        let session = self
            .inner
            .registry
            .get(project_id)
            .map_err(project_terminal_error)?;
        let cwd = resolve_terminal_cwd(
            session.root(),
            input.cwd_project_relative_path.as_deref().unwrap_or(""),
        )?;
        let cols = input.cols.unwrap_or(DEFAULT_COLS);
        let rows = input.rows.unwrap_or(DEFAULT_ROWS);
        validate_dimensions(cols, rows)?;
        let mut reservation = self.reserve_terminal(project_id)?;
        let project_use = self
            .inner
            .registry
            .acquire_use(project_id, ProjectUseKind::RunningTerminal)
            .map_err(project_terminal_error)?;
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        let view = TerminalSessionView {
            id: id.clone(),
            title: cwd
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("Terminal")
                .to_owned(),
            cwd_project_relative_path: project_relative_cwd(session.root(), &cwd)?,
            cols,
            rows,
            status: TerminalSessionStatus::Starting,
            exit_code: None,
            signal: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let terminal = spawn_terminal(view, cwd, project_use)?;
        let result = terminal.view()?;
        let mut projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        let project = projects.entry(project_id.to_owned()).or_default();
        reservation.commit(project);
        project.sessions.insert(id, terminal);
        if let Err(error) = publish_topology(project) {
            let terminal = project.sessions.remove(&result.id);
            drop(projects);
            if let Some(terminal) = terminal {
                let _ = terminal.close();
            }
            return Err(error);
        }
        Ok(result)
    }

    fn reserve_terminal(&self, project_id: &str) -> Result<TerminalReservation, TerminalError> {
        let mut projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        let mut retired = Vec::new();
        loop {
            let project = projects.entry(project_id.to_owned()).or_default();
            if project.sessions.len() + project.reservations < MAX_TERMINALS_PER_PROJECT {
                break;
            }
            let Some(terminal_id) = oldest_retired_terminal_id(project)? else {
                return Err(TerminalError::new(
                    "terminal_project_limit_reached",
                    format!(
                        "Project Terminal limit reached ({MAX_TERMINALS_PER_PROJECT}): {project_id}"
                    ),
                ));
            };
            if let Some(terminal) = project.sessions.remove(&terminal_id) {
                retired.push(terminal);
                publish_topology(project)?;
            }
        }
        loop {
            let runtime_count = projects
                .values()
                .map(|project| project.sessions.len() + project.reservations)
                .sum::<usize>();
            if runtime_count < MAX_TERMINALS_PER_RUNTIME {
                break;
            }
            let Some((retired_project_id, terminal_id)) =
                oldest_runtime_retired_terminal(&projects)?
            else {
                return Err(TerminalError::new(
                    "terminal_runtime_limit_reached",
                    format!("Runtime Terminal limit reached ({MAX_TERMINALS_PER_RUNTIME})."),
                ));
            };
            if let Some(project) = projects.get_mut(&retired_project_id)
                && let Some(terminal) = project.sessions.remove(&terminal_id)
            {
                retired.push(terminal);
                publish_topology(project)?;
            }
        }
        let project = projects.entry(project_id.to_owned()).or_default();
        project.reservations += 1;
        let reservation = TerminalReservation {
            service: Arc::downgrade(&self.inner),
            project_id: project_id.to_owned(),
            active: true,
        };
        drop(projects);
        drop(retired);
        Ok(reservation)
    }

    /// Lists the current memory-only Terminal entities for one open Project.
    ///
    /// # Errors
    /// Returns an error when the Project is not open or Terminal state is poisoned.
    pub fn list(&self, project_id: &str) -> Result<TerminalTopologySnapshot, TerminalError> {
        self.inner
            .registry
            .get(project_id)
            .map_err(project_terminal_error)?;
        let projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        projects.get(project_id).map_or_else(
            || {
                Ok(TerminalTopologySnapshot {
                    revision: 0,
                    sessions: Vec::new(),
                })
            },
            snapshot,
        )
    }

    /// Registers one hub attachment as an observer and returns its exact checkpoint barrier.
    ///
    /// # Errors
    /// Returns a typed error when the Terminal is absent or its actor is unavailable.
    pub fn observe(
        &self,
        project_id: &str,
        terminal_id: &str,
        observer_id: impl Into<String>,
    ) -> Result<TerminalObservation, TerminalError> {
        let terminal = self.terminal(project_id, terminal_id)?;
        let observer_id = observer_id.into();
        validate_observer_id(&observer_id)?;
        let observation_id = Uuid::new_v4();
        let active = Arc::new(AtomicBool::new(true));
        let (events, receiver) = mpsc::sync_channel(TERMINAL_EVENT_CAPACITY);
        if let Some(checkpoint) = terminal.final_checkpoint()? {
            drop(events);
            return Ok(TerminalObservation {
                checkpoint: checkpoint?,
                receiver,
                terminal: Arc::downgrade(&terminal),
                observer_id,
                observation_id,
                active,
            });
        }
        let (reply, checkpoint) = mpsc::channel();
        terminal.send(ActorCommand::Observe {
            observer_id: observer_id.clone(),
            observation_id,
            active: Arc::clone(&active),
            events,
            reply,
        })?;
        let checkpoint = checkpoint
            .recv_timeout(TERMINAL_CLOSE_REQUEST_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => TerminalError::new(
                    "terminal_observe_timeout",
                    format!("Terminal observation timed out: {terminal_id}"),
                ),
                mpsc::RecvTimeoutError::Disconnected => actor_unavailable(terminal_id),
            })??;
        Ok(TerminalObservation {
            checkpoint,
            receiver,
            terminal: Arc::downgrade(&terminal),
            observer_id,
            observation_id,
            active,
        })
    }

    /// Writes one strictly increasing input sequence after ordered PTY acceptance.
    ///
    /// # Errors
    /// Returns an error for a missing observation, stale sequence, stopped Terminal, or PTY failure.
    pub fn write_input(
        &self,
        project_id: &str,
        terminal_id: &str,
        observer_id: &str,
        sequence: u64,
        data: String,
    ) -> Result<u64, TerminalError> {
        validate_observer_id(observer_id)?;
        if data.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(TerminalError::new(
                "terminal_input_too_large",
                format!("Terminal input exceeds the {MAX_TERMINAL_INPUT_BYTES}-byte frame limit."),
            ));
        }
        let terminal = self.terminal(project_id, terminal_id)?;
        let (reply, result) = mpsc::channel();
        terminal.send(ActorCommand::Input {
            observer_id: observer_id.to_owned(),
            sequence,
            data,
            reply,
        })?;
        result
            .recv_timeout(TERMINAL_INPUT_ACK_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => TerminalError::new(
                    "terminal_input_timeout",
                    format!("Terminal input acknowledgement timed out: {terminal_id}"),
                ),
                mpsc::RecvTimeoutError::Disconnected => actor_unavailable(terminal_id),
            })?
    }

    /// Resizes one observed Terminal in the same serialized authority as input/output.
    ///
    /// # Errors
    /// Returns an error for invalid dimensions, a missing observation, or PTY failure.
    pub fn resize(
        &self,
        project_id: &str,
        terminal_id: &str,
        observer_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionView, TerminalError> {
        validate_observer_id(observer_id)?;
        validate_dimensions(cols, rows)?;
        let terminal = self.terminal(project_id, terminal_id)?;
        let (reply, result) = mpsc::channel();
        terminal.send(ActorCommand::Resize {
            observer_id: observer_id.to_owned(),
            cols,
            rows,
            reply,
        })?;
        result
            .recv_timeout(TERMINAL_CLOSE_REQUEST_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => TerminalError::new(
                    "terminal_resize_timeout",
                    format!("Terminal resize timed out: {terminal_id}"),
                ),
                mpsc::RecvTimeoutError::Disconnected => actor_unavailable(terminal_id),
            })?
    }

    /// Releases every observer and input sequence owned by one disconnected
    /// Terminal hub attachment.
    ///
    /// # Errors
    /// Returns an error if any affected Terminal actor cannot acknowledge the detach.
    pub fn detach_attachment(
        &self,
        project_id: &str,
        observer_id: &str,
    ) -> Result<(), TerminalError> {
        validate_observer_id(observer_id)?;
        let terminals = self
            .inner
            .projects
            .lock()
            .map_err(|_| {
                TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
            })?
            .get(project_id)
            .map(|project| project.sessions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for terminal in terminals {
            let (reply, result) = mpsc::channel();
            terminal.send(ActorCommand::DetachAttachment {
                observer_id: observer_id.to_owned(),
                reply,
            })?;
            result
                .recv_timeout(TERMINAL_CLOSE_REQUEST_TIMEOUT)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => TerminalError::new(
                        "terminal_detach_timeout",
                        format!("Terminal attachment detach timed out: {}", terminal.id),
                    ),
                    mpsc::RecvTimeoutError::Disconnected => actor_unavailable(&terminal.id),
                })?;
        }
        Ok(())
    }

    /// Explicitly closes and removes one Terminal entity.
    ///
    /// # Errors
    /// Returns a typed error when the Terminal does not exist or process-tree cleanup fails.
    pub fn close(&self, project_id: &str, terminal_id: &str) -> Result<(), TerminalError> {
        let terminal = self.terminal(project_id, terminal_id)?;
        terminal.close()?;
        let mut projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        if let Some(project) = projects.get_mut(project_id) {
            project.sessions.remove(terminal_id);
            publish_topology(project)?;
        }
        Ok(())
    }

    /// Subscribes to independently revisioned create/close topology.
    ///
    /// # Errors
    /// Returns an error when the Project is not open or state is poisoned.
    pub fn subscribe_topology(
        &self,
        project_id: &str,
    ) -> Result<TerminalTopologySubscription, TerminalError> {
        self.inner
            .registry
            .get(project_id)
            .map_err(project_terminal_error)?;
        let mut projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        let project = projects.entry(project_id.to_owned()).or_default();
        if project.observers.len() >= MAX_TERMINAL_TOPOLOGY_OBSERVERS {
            return Err(TerminalError::new(
                "terminal_topology_observer_limit_reached",
                "Terminal topology observer limit reached.",
            ));
        }
        let snapshot = snapshot(project)?;
        let observer_id = Uuid::new_v4();
        let (sender, receiver) = mpsc::sync_channel(TERMINAL_TOPOLOGY_CAPACITY);
        project.observers.insert(observer_id, sender);
        Ok(TerminalTopologySubscription {
            snapshot,
            receiver,
            service: Arc::downgrade(&self.inner),
            project_id: project_id.to_owned(),
            observer_id,
        })
    }

    /// Closes every Terminal before Runtime shutdown.
    ///
    /// # Errors
    /// Returns the first close, topology, or state error while retaining every
    /// Terminal that did not close for an explicit shutdown decision.
    pub fn close_all(&self) -> Result<(), TerminalError> {
        let terminals = self
            .inner
            .projects
            .lock()
            .map(|projects| {
                projects
                    .iter()
                    .flat_map(|(project_id, project)| {
                        project.sessions.iter().map(|(terminal_id, terminal)| {
                            (
                                project_id.clone(),
                                terminal_id.clone(),
                                Arc::clone(terminal),
                            )
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .map_err(|_| {
                TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
            })?;
        let mut first_error = None;
        for (project_id, terminal_id, terminal) in terminals {
            match terminal.close() {
                Ok(()) => {
                    if let Ok(mut projects) = self.inner.projects.lock()
                        && let Some(project) = projects.get_mut(&project_id)
                    {
                        project.sessions.remove(&terminal_id);
                        if let Err(error) = publish_topology(project)
                            && first_error.is_none()
                        {
                            first_error = Some(error);
                        }
                    }
                }
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn terminal(
        &self,
        project_id: &str,
        terminal_id: &str,
    ) -> Result<Arc<TerminalHandle>, TerminalError> {
        let projects = self.inner.projects.lock().map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })?;
        projects
            .get(project_id)
            .and_then(|project| project.sessions.get(terminal_id))
            .cloned()
            .ok_or_else(|| {
                TerminalError::new(
                    "terminal_not_found",
                    format!("Terminal session not found: {terminal_id}"),
                )
            })
    }
}

fn snapshot(project: &ProjectTerminals) -> Result<TerminalTopologySnapshot, TerminalError> {
    let mut sessions = project
        .sessions
        .values()
        .map(|terminal| terminal.view())
        .collect::<Result<Vec<_>, _>>()?;
    sessions.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.id.cmp(&right.id))
    });
    Ok(TerminalTopologySnapshot {
        revision: project.revision,
        sessions,
    })
}

fn oldest_retired_terminal_id(project: &ProjectTerminals) -> Result<Option<String>, TerminalError> {
    let mut retired = project
        .sessions
        .values()
        .filter_map(|terminal| match terminal.retired_sort_key() {
            Ok(Some(key)) => Some(Ok((key, terminal.id.clone()))),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    retired.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    Ok(retired.into_iter().next().map(|(_, id)| id))
}

fn oldest_runtime_retired_terminal(
    projects: &HashMap<String, ProjectTerminals>,
) -> Result<Option<(String, String)>, TerminalError> {
    let mut retired = Vec::new();
    for (project_id, project) in projects {
        for terminal in project.sessions.values() {
            if let Some(key) = terminal.retired_sort_key()? {
                retired.push((key, project_id.clone(), terminal.id.clone()));
            }
        }
    }
    retired.sort();
    Ok(retired
        .into_iter()
        .next()
        .map(|(_, project_id, terminal_id)| (project_id, terminal_id)))
}

fn publish_topology(project: &mut ProjectTerminals) -> Result<(), TerminalError> {
    let revision = project.revision.checked_add(1).ok_or_else(|| {
        TerminalError::new(
            "terminal_topology_exhausted",
            "Terminal topology revision is exhausted.",
        )
    })?;
    let mut snapshot = snapshot(project)?;
    snapshot.revision = revision;
    project.revision = revision;
    project
        .observers
        .retain(|_, observer| observer.try_send(snapshot.clone()).is_ok());
    Ok(())
}

impl TerminalHandle {
    fn view(&self) -> Result<TerminalSessionView, TerminalError> {
        self.view.lock().map(|view| view.clone()).map_err(|_| {
            TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
        })
    }

    fn send(&self, command: ActorCommand) -> Result<(), TerminalError> {
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => TerminalError::new(
                    "terminal_backpressure",
                    format!("Terminal command queue is full: {}", self.id),
                ),
                mpsc::TrySendError::Disconnected(_) => actor_unavailable(&self.id),
            })
    }

    fn final_checkpoint(
        &self,
    ) -> Result<Option<Result<TerminalCheckpoint, TerminalError>>, TerminalError> {
        self.final_checkpoint
            .lock()
            .map(|checkpoint| checkpoint.clone())
            .map_err(|_| {
                TerminalError::new("terminal_state_poisoned", "Terminal state is poisoned.")
            })
    }

    fn retired_sort_key(&self) -> Result<Option<String>, TerminalError> {
        if self.final_checkpoint()?.is_none() {
            return Ok(None);
        }
        self.view().map(|view| Some(view.created_at))
    }

    fn close(&self) -> Result<(), TerminalError> {
        self.request_close(false)
    }

    fn shutdown(&self) -> Result<(), TerminalError> {
        self.request_close(true)
    }

    fn request_close(&self, shutdown: bool) -> Result<(), TerminalError> {
        if self.final_checkpoint()?.is_some() {
            return self.join_actor();
        }
        let (reply, result) = mpsc::channel();
        let mut command = if shutdown {
            ActorCommand::Shutdown { reply }
        } else {
            ActorCommand::Close { reply }
        };
        let deadline = Instant::now() + TERMINAL_CLOSE_REQUEST_TIMEOUT;
        loop {
            match self.commands.try_send(command) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(returned)) if Instant::now() < deadline => {
                    command = returned;
                    thread::sleep(Duration::from_millis(5));
                }
                Err(mpsc::TrySendError::Full(_)) => {
                    return Err(TerminalError::new(
                        "terminal_close_timeout",
                        format!("Terminal close request timed out: {}", self.id),
                    ));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    return Err(actor_unavailable(&self.id));
                }
            }
        }
        let close_result = result
            .recv_timeout(TERMINAL_CLOSE_ACK_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => TerminalError::new(
                    "terminal_close_timeout",
                    format!("Terminal close acknowledgement timed out: {}", self.id),
                ),
                mpsc::RecvTimeoutError::Disconnected => actor_unavailable(&self.id),
            })?;
        if !shutdown {
            close_result.clone()?;
        }
        self.join_actor()?;
        close_result
    }

    fn join_actor(&self) -> Result<(), TerminalError> {
        let actor = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(actor) = actor
            && actor.join().is_err()
        {
            return Err(TerminalError::new(
                "terminal_actor_panicked",
                format!("Terminal actor panicked: {}", self.id),
            ));
        }
        Ok(())
    }

    fn shutdown_with_fallback(&self) {
        if self.shutdown().is_ok() {
            return;
        }
        let tree = self
            .tree
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(tree) = tree {
            let _ = tree.force_kill();
        }
        let (reply, result) = mpsc::channel();
        let mut command = ActorCommand::Shutdown { reply };
        let deadline = Instant::now() + TERMINAL_CLOSE_REQUEST_TIMEOUT;
        let sent = loop {
            match self.commands.try_send(command) {
                Ok(()) => break true,
                Err(mpsc::TrySendError::Full(returned)) if Instant::now() < deadline => {
                    command = returned;
                    thread::sleep(Duration::from_millis(5));
                }
                Err(mpsc::TrySendError::Full(_) | mpsc::TrySendError::Disconnected(_)) => {
                    break false;
                }
            }
        };
        if sent && result.recv_timeout(TERMINAL_CLOSE_ACK_TIMEOUT).is_ok() {
            let _ = self.join_actor();
        } else {
            // The process tree has already been force-killed. Rust cannot cancel a
            // wedged platform call safely, so detach the thread instead of turning
            // Runtime destruction into an unbounded wait.
            self.actor
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
    }
}

impl TerminalReservation {
    fn commit(&mut self, project: &mut ProjectTerminals) {
        project.reservations = project.reservations.saturating_sub(1);
        self.active = false;
    }
}

impl Drop for TerminalReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let mut projects = service
            .projects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(project) = projects.get_mut(&self.project_id) {
            project.reservations = project.reservations.saturating_sub(1);
        }
        self.active = false;
    }
}

impl Drop for TerminalHandle {
    fn drop(&mut self) {
        if self
            .actor
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
        {
            self.shutdown_with_fallback();
        }
    }
}

enum ActorCommand {
    Output(Vec<u8>),
    ReaderFailed(String),
    ReaderClosed,
    ChildExited(Result<portable_pty::ExitStatus, String>),
    Observe {
        observer_id: String,
        observation_id: Uuid,
        events: mpsc::SyncSender<TerminalEvent>,
        active: Arc<AtomicBool>,
        reply: mpsc::Sender<Result<TerminalCheckpoint, TerminalError>>,
    },
    Unobserve {
        observer_id: String,
        observation_id: Uuid,
    },
    DetachAttachment {
        observer_id: String,
        reply: mpsc::Sender<()>,
    },
    Input {
        observer_id: String,
        sequence: u64,
        data: String,
        reply: mpsc::Sender<Result<u64, TerminalError>>,
    },
    Resize {
        observer_id: String,
        cols: u16,
        rows: u16,
        reply: mpsc::Sender<Result<TerminalSessionView, TerminalError>>,
    },
    Close {
        reply: mpsc::Sender<Result<(), TerminalError>>,
    },
    Shutdown {
        reply: mpsc::Sender<Result<(), TerminalError>>,
    },
}

struct ObserverState {
    observation_id: Uuid,
    events: mpsc::SyncSender<TerminalEvent>,
    active: Arc<AtomicBool>,
}

struct InputWrite {
    bytes: Vec<u8>,
    sequence: u64,
    reply: mpsc::Sender<Result<u64, TerminalError>>,
}

struct ExitNotice {
    status: Mutex<Option<Result<portable_pty::ExitStatus, String>>>,
    ready: Condvar,
}

struct PtyRuntime {
    master: Box<dyn portable_pty::MasterPty + Send>,
    input: mpsc::SyncSender<InputWrite>,
    tree: Arc<debrute_native_process::ChildProcessTree>,
    exit_notice: Arc<ExitNotice>,
    #[cfg(target_os = "windows")]
    _spawn_barrier: debrute_native_process::WindowsSpawnBarrier,
}

struct TerminalActor {
    view: TerminalSessionView,
    shared_view: Arc<Mutex<TerminalSessionView>>,
    final_checkpoint: Arc<Mutex<Option<Result<TerminalCheckpoint, TerminalError>>>>,
    emulator: TerminalEmulator,
    pty: PtyRuntime,
    tree_owner: Arc<Mutex<Option<Arc<debrute_native_process::ChildProcessTree>>>>,
    observers: HashMap<String, ObserverState>,
    input_sequences: HashMap<String, u64>,
    reader_closed: bool,
    pending_exit: Option<Result<portable_pty::ExitStatus, String>>,
    retirement_deadline: Option<Instant>,
    tree_cleanup_error: Option<String>,
    exit_published: bool,
    project_use: Option<ProjectUse>,
}

fn spawn_terminal(
    view: TerminalSessionView,
    cwd: PathBuf,
    project_use: ProjectUse,
) -> Result<Arc<TerminalHandle>, TerminalError> {
    let (commands, receiver) = mpsc::sync_channel(TERMINAL_COMMAND_CAPACITY);
    let shared_view = Arc::new(Mutex::new(view.clone()));
    let final_checkpoint = Arc::new(Mutex::new(None));
    let (startup, started) = mpsc::channel();
    let (activate, activation) = mpsc::sync_channel::<(ProjectUse, mpsc::Sender<()>)>(1);
    let tree = Arc::new(Mutex::new(None));
    let actor_tree = Arc::clone(&tree);
    let actor_commands = commands.clone();
    let actor_view = Arc::clone(&shared_view);
    let actor_final_checkpoint = Arc::clone(&final_checkpoint);
    let id = view.id.clone();
    let actor = thread::Builder::new()
        .name(format!("debrute-terminal-{id}"))
        .spawn(move || {
            let result = start_terminal_actor(
                view,
                actor_view,
                actor_final_checkpoint,
                cwd,
                &actor_commands,
                &actor_tree,
            );
            match result {
                Ok(mut actor) => {
                    let _ = startup.send(Ok(()));
                    let Ok((project_use, activated)) = activation.recv() else {
                        let _ = actor.close();
                        return;
                    };
                    actor.project_use = Some(project_use);
                    let _ = activated.send(());
                    run_terminal_actor(actor, receiver);
                }
                Err(error) => {
                    let _ = startup.send(Err(error));
                }
            }
        })
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))?;
    let mut actor = Some(actor);
    match started.recv_timeout(TERMINAL_START_TIMEOUT) {
        Ok(Ok(())) => {
            let handle = Arc::new(TerminalHandle {
                id: id.clone(),
                view: shared_view,
                final_checkpoint,
                commands,
                actor: Mutex::new(actor.take()),
                tree,
            });
            let (activated, activation_result) = mpsc::channel();
            if activate.send((project_use, activated)).is_err()
                || activation_result
                    .recv_timeout(TERMINAL_START_TIMEOUT)
                    .is_err()
            {
                handle.shutdown_with_fallback();
                return Err(actor_unavailable(&id));
            }
            Ok(handle)
        }
        Ok(Err(error)) => {
            if let Some(actor) = actor.take() {
                let _ = actor.join();
            }
            Err(error)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => Err(TerminalError::new(
            "terminal_spawn_timeout",
            format!("Terminal startup timed out: {id}"),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if let Some(actor) = actor.take() {
                let _ = actor.join();
            }
            Err(actor_unavailable(&id))
        }
    }
}

// PTY acquisition and every rollback edge form one startup transaction.
#[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
fn start_terminal_actor(
    mut view: TerminalSessionView,
    shared_view: Arc<Mutex<TerminalSessionView>>,
    final_checkpoint: Arc<Mutex<Option<Result<TerminalCheckpoint, TerminalError>>>>,
    cwd: PathBuf,
    commands: &mpsc::SyncSender<ActorCommand>,
    tree_owner: &Arc<Mutex<Option<Arc<debrute_native_process::ChildProcessTree>>>>,
) -> Result<TerminalActor, TerminalError> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: view.rows,
            cols: view.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))?;
    #[cfg(target_os = "windows")]
    let (mut command, spawn_barrier) = windows_terminal_command()?;
    #[cfg(not(target_os = "windows"))]
    let mut command = CommandBuilder::new(default_shell());
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "debrute");
    command.env("PWD", &cwd);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))?;
    drop(pair.slave);
    let tree = match attach_terminal_tree(child.as_ref()) {
        Ok(tree) => Arc::new(tree),
        Err(error) => {
            let _ = child.kill();
            let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
            return Err(error);
        }
    };
    *tree_owner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&tree));
    #[cfg(target_os = "windows")]
    if let Err(error) = spawn_barrier.release() {
        let _ = tree.force_kill();
        let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
        return Err(TerminalError::new(
            "terminal_spawn_failed",
            error.to_string(),
        ));
    }
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = tree.force_kill();
            let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
            return Err(TerminalError::new(
                "terminal_spawn_failed",
                error.to_string(),
            ));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = tree.force_kill();
            let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
            return Err(TerminalError::new(
                "terminal_spawn_failed",
                error.to_string(),
            ));
        }
    };
    let (input, input_receiver) = mpsc::sync_channel(TERMINAL_INPUT_CAPACITY);
    if let Err(error) = thread::Builder::new()
        .name(format!("debrute-terminal-input-{}", view.id))
        .spawn(move || write_terminal_input(writer, input_receiver))
    {
        let _ = tree.force_kill();
        let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
        return Err(TerminalError::new(
            "terminal_spawn_failed",
            error.to_string(),
        ));
    }
    let exit_notice = Arc::new(ExitNotice {
        status: Mutex::new(None),
        ready: Condvar::new(),
    });

    let output_commands = commands.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("debrute-terminal-output-{}", view.id))
        .spawn(move || read_terminal_output(reader, &output_commands))
    {
        let _ = tree.force_kill();
        let _ = wait_for_pty_child(&mut *child, TERMINAL_CLOSE_GRACE);
        return Err(TerminalError::new(
            "terminal_spawn_failed",
            error.to_string(),
        ));
    }
    let exit_commands = commands.clone();
    let exit_state = Arc::clone(&exit_notice);
    if let Err(error) = thread::Builder::new()
        .name(format!("debrute-terminal-wait-{}", view.id))
        .spawn(move || {
            let status = child.wait().map_err(|error| error.to_string());
            if let Ok(mut notice) = exit_state.status.lock() {
                *notice = Some(status.clone());
                exit_state.ready.notify_all();
            }
            let _ = exit_commands.send(ActorCommand::ChildExited(status));
        })
    {
        let _ = tree.force_kill();
        return Err(TerminalError::new(
            "terminal_spawn_failed",
            error.to_string(),
        ));
    }

    view.status = TerminalSessionStatus::Running;
    view.updated_at = now_iso();
    if let Ok(mut shared) = shared_view.lock() {
        *shared = view.clone();
    }
    Ok(TerminalActor {
        emulator: TerminalEmulator::new(view.id.clone(), view.rows, view.cols),
        view,
        shared_view,
        final_checkpoint,
        pty: PtyRuntime {
            master: pair.master,
            input,
            tree,
            exit_notice,
            #[cfg(target_os = "windows")]
            _spawn_barrier: spawn_barrier,
        },
        tree_owner: Arc::clone(tree_owner),
        observers: HashMap::new(),
        input_sequences: HashMap::new(),
        reader_closed: false,
        pending_exit: None,
        retirement_deadline: None,
        tree_cleanup_error: None,
        exit_published: false,
        project_use: None,
    })
}

#[allow(clippy::needless_pass_by_value)] // The dedicated writer thread owns its queue receiver.
fn write_terminal_input(mut writer: Box<dyn Write + Send>, receiver: mpsc::Receiver<InputWrite>) {
    while let Ok(input) = receiver.recv() {
        let result = writer
            .write_all(&input.bytes)
            .and_then(|()| writer.flush())
            .map(|()| input.sequence)
            .map_err(|error| TerminalError::new("terminal_input_failed", error.to_string()));
        let failed = result.is_err();
        let _ = input.reply.send(result);
        if failed {
            break;
        }
    }
}

fn read_terminal_output(
    mut reader: Box<dyn Read + Send>,
    commands: &mpsc::SyncSender<ActorCommand>,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if commands
                    .send(ActorCommand::Output(buffer[..read].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => {
                let _ = commands.send(ActorCommand::ReaderFailed(error.to_string()));
                break;
            }
        }
    }
    let _ = commands.send(ActorCommand::ReaderClosed);
}

#[allow(clippy::needless_pass_by_value)] // The actor thread owns its receiver.
#[allow(clippy::too_many_lines)] // One actor match is the serialized PTY authority.
fn run_terminal_actor(mut actor: TerminalActor, receiver: mpsc::Receiver<ActorCommand>) {
    let mut pending = VecDeque::new();
    loop {
        if actor
            .retirement_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            let _ = actor.publish_exit_if_ready(true);
            break;
        }
        let command = pending.pop_front().or_else(|| {
            actor.retirement_deadline.map_or_else(
                || receiver.recv().ok(),
                |deadline| {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    receiver.recv_timeout(remaining).ok()
                },
            )
        });
        let Some(command) = command else {
            if actor.retirement_deadline.is_some() {
                let _ = actor.publish_exit_if_ready(true);
            } else {
                let _ = actor.pty.tree.force_kill();
            }
            break;
        };
        actor.reap_inactive_observers();
        match command {
            ActorCommand::Output(bytes) => {
                actor.publish_output(bytes);
                let deadline = Instant::now() + TERMINAL_OUTPUT_COALESCE;
                let mut coalesced = Vec::new();
                for _ in 1..TERMINAL_OUTPUT_COALESCE_MAX_CHUNKS {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match receiver.recv_timeout(remaining) {
                        Ok(ActorCommand::Output(bytes)) => coalesced.extend_from_slice(&bytes),
                        Ok(other) => {
                            pending.push_back(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                if !coalesced.is_empty() {
                    actor.publish_output(coalesced);
                }
            }
            ActorCommand::ReaderClosed => {
                actor.reader_closed = true;
                if actor.publish_exit_if_ready(false) {
                    break;
                }
            }
            ActorCommand::ReaderFailed(message) => {
                actor.publish(TerminalEvent::Error {
                    terminal_id: actor.view.id.clone(),
                    code: "terminal_output_failed".to_owned(),
                    message,
                });
            }
            ActorCommand::ChildExited(status) => {
                actor.pending_exit = Some(status);
                actor.tree_cleanup_error = actor
                    .pty
                    .tree
                    .force_kill()
                    .err()
                    .map(|error| error.to_string());
                actor.retirement_deadline = Some(Instant::now() + TERMINAL_OUTPUT_DRAIN_GRACE);
                if actor.publish_exit_if_ready(false) {
                    break;
                }
            }
            ActorCommand::Observe {
                observer_id,
                observation_id,
                active,
                events,
                reply,
            } => {
                let result = if !actor.observers.contains_key(&observer_id)
                    && actor.observers.len() >= MAX_TERMINAL_OBSERVERS
                {
                    Err(TerminalError::new(
                        "terminal_observer_limit_reached",
                        format!("Terminal observer limit reached: {}", actor.view.id),
                    ))
                } else {
                    actor
                        .emulator
                        .checkpoint(&actor.view.title)
                        .map_err(|message| {
                            TerminalError::new("terminal_checkpoint_too_large", message)
                        })
                };
                if result.is_ok() {
                    actor.observers.insert(
                        observer_id,
                        ObserverState {
                            observation_id,
                            events,
                            active,
                        },
                    );
                }
                let _ = reply.send(result);
            }
            ActorCommand::Unobserve {
                observer_id,
                observation_id,
            } => {
                if actor
                    .observers
                    .get(&observer_id)
                    .is_some_and(|observer| observer.observation_id == observation_id)
                {
                    actor.observers.remove(&observer_id);
                }
            }
            ActorCommand::DetachAttachment { observer_id, reply } => {
                actor.observers.remove(&observer_id);
                actor.input_sequences.remove(&observer_id);
                let _ = reply.send(());
            }
            ActorCommand::Input {
                observer_id,
                sequence,
                data,
                reply,
            } => {
                actor.write_input(&observer_id, sequence, data.into_bytes(), reply);
            }
            ActorCommand::Resize {
                observer_id,
                cols,
                rows,
                reply,
            } => {
                let result = actor.resize(&observer_id, cols, rows);
                let _ = reply.send(result);
            }
            ActorCommand::Close { reply } => {
                let result = actor.close();
                let should_stop = result.is_ok();
                let _ = reply.send(result);
                if should_stop {
                    break;
                }
            }
            ActorCommand::Shutdown { reply } => {
                let result = actor.close();
                let _ = reply.send(result);
                break;
            }
        }
    }
}

impl TerminalActor {
    fn publish_output(&mut self, bytes: Vec<u8>) {
        let sequence = self.emulator.process_output(&bytes);
        let title = self.emulator.title(&self.view.title);
        if title != self.view.title {
            self.view.title = title;
            self.view.updated_at = now_iso();
            self.publish(TerminalEvent::Status(self.view.clone()));
            self.sync_shared_view();
        }
        self.publish(TerminalEvent::Output {
            terminal_id: self.view.id.clone(),
            sequence,
            data_base64: STANDARD.encode(bytes),
        });
    }

    fn write_input(
        &mut self,
        observer_id: &str,
        sequence: u64,
        bytes: Vec<u8>,
        reply: mpsc::Sender<Result<u64, TerminalError>>,
    ) {
        let validation = (|| {
            if self.view.status != TerminalSessionStatus::Running {
                return Err(TerminalError::new(
                    "terminal_not_running",
                    format!("Terminal is not running: {}", self.view.id),
                ));
            }
            if !self.observers.contains_key(observer_id) {
                return Err(TerminalError::new(
                    "terminal_not_observed",
                    format!(
                        "Terminal is not observed by this connection: {}",
                        self.view.id
                    ),
                ));
            }
            let previous = self.input_sequences.get(observer_id).copied().unwrap_or(0);
            if sequence <= previous {
                return Err(TerminalError::new(
                    "terminal_input_out_of_order",
                    format!("Terminal input sequence is not increasing: {sequence}"),
                ));
            }
            Ok(previous)
        })();
        let previous = match validation {
            Ok(value) => value,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        self.input_sequences
            .insert(observer_id.to_owned(), sequence);
        if let Err(error) = self.pty.input.try_send(InputWrite {
            bytes,
            sequence,
            reply,
        }) {
            if previous == 0 {
                self.input_sequences.remove(observer_id);
            } else {
                self.input_sequences
                    .insert(observer_id.to_owned(), previous);
            }
            let (reply, error) = match error {
                mpsc::TrySendError::Full(input) => (
                    input.reply,
                    TerminalError::new(
                        "terminal_input_backpressure",
                        format!("Terminal input queue is full: {}", self.view.id),
                    ),
                ),
                mpsc::TrySendError::Disconnected(input) => (
                    input.reply,
                    TerminalError::new(
                        "terminal_input_failed",
                        format!("Terminal input writer is unavailable: {}", self.view.id),
                    ),
                ),
            };
            let _ = reply.send(Err(error));
        }
    }

    fn resize(
        &mut self,
        observer_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionView, TerminalError> {
        if self.view.status != TerminalSessionStatus::Running {
            return Err(TerminalError::new(
                "terminal_not_running",
                format!("Terminal is not running: {}", self.view.id),
            ));
        }
        if !self.observers.contains_key(observer_id) {
            return Err(TerminalError::new(
                "terminal_not_observed",
                format!(
                    "Terminal is not observed by this connection: {}",
                    self.view.id
                ),
            ));
        }
        self.pty
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::new("terminal_resize_failed", error.to_string()))?;
        self.emulator.resize(rows, cols);
        self.view.rows = rows;
        self.view.cols = cols;
        self.view.updated_at = now_iso();
        self.sync_shared_view();
        self.publish(TerminalEvent::Status(self.view.clone()));
        Ok(self.view.clone())
    }

    fn publish_exit_if_ready(&mut self, force_output_drain: bool) -> bool {
        if self.exit_published || (!self.reader_closed && !force_output_drain) {
            return false;
        }
        let Some(status) = self.pending_exit.take() else {
            return false;
        };
        self.exit_published = true;
        self.retirement_deadline = None;
        match (
            status,
            self.tree_cleanup_error.take(),
            force_output_drain && !self.reader_closed,
        ) {
            (_, Some(error), _) => {
                self.view.status = TerminalSessionStatus::Failed;
                self.view.updated_at = now_iso();
                self.sync_shared_view();
                self.publish(TerminalEvent::Error {
                    terminal_id: self.view.id.clone(),
                    code: "terminal_tree_cleanup_failed".to_owned(),
                    message: error,
                });
                self.publish(TerminalEvent::Status(self.view.clone()));
            }
            (_, None, true) => {
                self.view.status = TerminalSessionStatus::Failed;
                self.view.updated_at = now_iso();
                self.sync_shared_view();
                self.publish(TerminalEvent::Error {
                    terminal_id: self.view.id.clone(),
                    code: "terminal_output_drain_timeout".to_owned(),
                    message: "Terminal output did not close within the bounded drain period after process-tree cleanup.".to_owned(),
                });
                self.publish(TerminalEvent::Status(self.view.clone()));
            }
            (Ok(status), None, false) => {
                self.view.status = TerminalSessionStatus::Exited;
                self.view.exit_code = Some(status.exit_code());
                self.view.signal = status.signal().map(str::to_owned);
                self.view.updated_at = now_iso();
                self.sync_shared_view();
                self.publish(TerminalEvent::Exit {
                    terminal_id: self.view.id.clone(),
                    exit_code: self.view.exit_code,
                    signal: self.view.signal.clone(),
                });
                self.publish(TerminalEvent::Status(self.view.clone()));
            }
            (Err(message), None, false) => {
                self.view.status = TerminalSessionStatus::Failed;
                self.view.updated_at = now_iso();
                self.sync_shared_view();
                self.publish(TerminalEvent::Error {
                    terminal_id: self.view.id.clone(),
                    code: "terminal_wait_failed".to_owned(),
                    message,
                });
                self.publish(TerminalEvent::Status(self.view.clone()));
            }
        }
        let checkpoint = self
            .emulator
            .checkpoint(&self.view.title)
            .map_err(|message| TerminalError::new("terminal_checkpoint_too_large", message));
        *self
            .final_checkpoint
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(checkpoint);
        self.project_use.take();
        self.tree_owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.observers.clear();
        true
    }

    fn close(&mut self) -> Result<(), TerminalError> {
        if !matches!(
            self.view.status,
            TerminalSessionStatus::Exited | TerminalSessionStatus::Failed
        ) {
            self.view.status = TerminalSessionStatus::Terminating;
            self.view.updated_at = now_iso();
            self.sync_shared_view();
            self.publish(TerminalEvent::Status(self.view.clone()));
            let _terminate_error = self.pty.tree.terminate().err();
            let exited = wait_for_exit(&self.pty.exit_notice, TERMINAL_CLOSE_GRACE);
            let force_error = self.pty.tree.force_kill().err();
            let confirmed_exit =
                exited.or_else(|| wait_for_exit(&self.pty.exit_notice, TERMINAL_FORCE_KILL_GRACE));
            if confirmed_exit.is_none() {
                let message = force_error.map_or_else(
                    || "Terminal process tree did not exit after force-kill.".to_owned(),
                    |error| format!("Terminal force-kill failed: {error}"),
                );
                return Err(TerminalError::new("terminal_close_failed", message));
            }
            if let Some(error) = force_error {
                return Err(TerminalError::new(
                    "terminal_close_failed",
                    format!("Terminal process-tree cleanup failed: {error}"),
                ));
            }
            if wait_for_exit(&self.pty.exit_notice, Duration::ZERO).is_none() {
                return Err(TerminalError::new(
                    "terminal_close_failed",
                    "Terminal process tree exit could not be confirmed.",
                ));
            }
        }
        self.observers.clear();
        Ok(())
    }

    #[allow(clippy::needless_pass_by_value)] // One event value is fanned out to all observers.
    fn publish(&mut self, event: TerminalEvent) {
        self.observers.retain(|_, observer| {
            observer.active.load(Ordering::Acquire)
                && observer.events.try_send(event.clone()).is_ok()
        });
    }

    fn reap_inactive_observers(&mut self) {
        self.observers
            .retain(|_, observer| observer.active.load(Ordering::Acquire));
    }

    fn sync_shared_view(&self) {
        if let Ok(mut shared) = self.shared_view.lock() {
            *shared = self.view.clone();
        }
    }
}

fn wait_for_exit(
    notice: &ExitNotice,
    timeout: Duration,
) -> Option<Result<portable_pty::ExitStatus, String>> {
    let status = notice.status.lock().ok()?;
    if status.is_some() {
        return status.clone();
    }
    let (status, _) = notice.ready.wait_timeout(status, timeout).ok()?;
    status.clone()
}

fn wait_for_pty_child(
    child: &mut dyn portable_pty::Child,
    timeout: Duration,
) -> std::io::Result<Option<portable_pty::ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn resolve_terminal_cwd(project_root: &Path, requested: &str) -> Result<PathBuf, TerminalError> {
    let requested = normalize_project_directory_path(requested).map_err(project_terminal_error)?;
    let requested_path = resolve_no_symlink_existing_project_path(project_root, &requested)
        .map_err(project_terminal_error)?;
    let metadata = requested_path
        .metadata()
        .map_err(|error| TerminalError::new("terminal_invalid_cwd", error.to_string()))?;
    let directory = if metadata.is_dir() {
        requested
    } else {
        parent_project_path(&requested).map_err(project_terminal_error)?
    };
    let path = resolve_no_symlink_existing_project_path(project_root, &directory)
        .map_err(project_terminal_error)?;
    if !path
        .metadata()
        .map_err(|error| TerminalError::new("terminal_invalid_cwd", error.to_string()))?
        .is_dir()
    {
        return Err(TerminalError::new(
            "terminal_invalid_cwd",
            format!("Terminal cwd is not a directory: {directory}"),
        ));
    }
    Ok(path)
}

fn project_relative_cwd(project_root: &Path, cwd: &Path) -> Result<String, TerminalError> {
    cwd.strip_prefix(project_root)
        .map_err(|_| TerminalError::new("terminal_invalid_cwd", "Terminal cwd escaped Project."))
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if cols == 0 || rows == 0 || cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS {
        Err(TerminalError::new(
            "terminal_invalid_dimensions",
            format!(
                "Terminal dimensions must be within 1..={MAX_TERMINAL_COLS} columns and 1..={MAX_TERMINAL_ROWS} rows."
            ),
        ))
    } else {
        Ok(())
    }
}

fn validate_observer_id(observer_id: &str) -> Result<(), TerminalError> {
    if observer_id.is_empty() || observer_id.len() > MAX_TERMINAL_OBSERVER_ID_BYTES {
        return Err(TerminalError::new(
            "terminal_observer_id_invalid",
            format!(
                "Terminal observer id must contain 1..={MAX_TERMINAL_OBSERVER_ID_BYTES} bytes."
            ),
        ));
    }
    Ok(())
}

fn default_shell() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("ComSpec").map_or_else(|| PathBuf::from("cmd.exe"), PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("SHELL").map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from)
    }
}

#[cfg(target_os = "windows")]
fn windows_terminal_command()
-> Result<(CommandBuilder, debrute_native_process::WindowsSpawnBarrier), TerminalError> {
    let barrier = debrute_native_process::WindowsSpawnBarrier::new()
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))?;
    let runtime = std::env::current_exe()
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))?;
    let mut command = CommandBuilder::new(runtime);
    command.arg(TERMINAL_BOOTSTRAP_FLAG);
    command.arg(default_shell());
    command.env(TERMINAL_SPAWN_BARRIER_ENV, barrier.name());
    Ok((command, barrier))
}

/// Runs the inert Windows ConPTY bootstrap when the Runtime executable was
/// launched through the internal Terminal command. The bootstrap cannot spawn
/// its shell until the owning Runtime has assigned it to a Job Object.
#[cfg(target_os = "windows")]
pub fn run_windows_terminal_bootstrap() -> Option<std::io::Result<i32>> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next()?;
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(TERMINAL_BOOTSTRAP_FLAG)) {
        return None;
    }
    let Some(shell) = arguments.next() else {
        return Some(Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Terminal bootstrap shell is missing",
        )));
    };
    if arguments.next().is_some() {
        return Some(Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Terminal bootstrap received unexpected arguments",
        )));
    }
    let Some(barrier) = std::env::var_os(TERMINAL_SPAWN_BARRIER_ENV) else {
        return Some(Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Terminal bootstrap spawn barrier is missing",
        )));
    };
    let Some(barrier) = barrier.to_str() else {
        return Some(Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Terminal bootstrap spawn barrier is invalid",
        )));
    };
    Some((|| {
        debrute_native_process::wait_for_windows_spawn_barrier(barrier)?;
        let status = std::process::Command::new(shell)
            .env_remove(TERMINAL_SPAWN_BARRIER_ENV)
            .status()?;
        Ok(status.code().unwrap_or(1))
    })())
}

#[cfg(target_os = "macos")]
fn attach_terminal_tree(
    child: &dyn portable_pty::Child,
) -> Result<debrute_native_process::ChildProcessTree, TerminalError> {
    let process_id = child.process_id().ok_or_else(|| {
        TerminalError::new("terminal_spawn_failed", "Terminal child has no process id.")
    })?;
    debrute_native_process::ChildProcessTree::attach_process_id(process_id)
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))
}

#[cfg(target_os = "windows")]
fn attach_terminal_tree(
    child: &dyn portable_pty::Child,
) -> Result<debrute_native_process::ChildProcessTree, TerminalError> {
    let process = child.as_raw_handle().ok_or_else(|| {
        TerminalError::new(
            "terminal_spawn_failed",
            "Terminal child has no process handle.",
        )
    })?;
    debrute_native_process::ChildProcessTree::attach_raw_handle(process)
        .map_err(|error| TerminalError::new("terminal_spawn_failed", error.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn attach_terminal_tree(
    _child: &dyn portable_pty::Child,
) -> Result<debrute_native_process::ChildProcessTree, TerminalError> {
    Err(TerminalError::new(
        "terminal_spawn_failed",
        "Terminal process-tree ownership is unsupported on this distribution target.",
    ))
}

#[allow(clippy::needless_pass_by_value)] // map_err transfers source-error ownership here.
fn project_terminal_error(error: crate::project::ProjectError) -> TerminalError {
    TerminalError::new(error.code(), error.to_string())
}

fn actor_unavailable(terminal_id: &str) -> TerminalError {
    TerminalError::new(
        "terminal_unavailable",
        format!("Terminal actor is unavailable: {terminal_id}"),
    )
}

fn now_iso() -> String {
    crate::now_rfc3339()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::{fs, time::Duration};

    use crate::{
        project::{
            CanvasFeedbackArtifacts, DefaultProjectNodeAdapter, MediaToolPaths,
            ProjectPreviewService, ProjectUseKind,
        },
        workers::RuntimeWorkerServices,
    };

    use super::*;

    fn project_service() -> (PathBuf, ProjectSessionRegistry, String, ProjectUse) {
        let root = std::env::temp_dir().join(format!("debrute-terminal-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture should exist");
        let workers = RuntimeWorkerServices::new();
        let previews = Arc::new(ProjectPreviewService::new(
            &workers,
            MediaToolPaths::unavailable(),
        ));
        let feedback = Arc::new(
            CanvasFeedbackArtifacts::new(previews).expect("feedback scheduler should start"),
        );
        let registry = ProjectSessionRegistry::new(
            root.join("home"),
            Arc::new(DefaultProjectNodeAdapter),
            feedback,
        );
        let opened = registry
            .open_project(&root, ProjectUseKind::Workbench)
            .expect("project should open");
        let project_id = opened.session.project_id().to_owned();
        (root, registry, project_id, opened.project_use)
    }

    #[test]
    fn terminal_requires_observation_and_acks_ordered_input() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let session = service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        assert_eq!(session.status, TerminalSessionStatus::Running);
        assert_eq!(
            service
                .write_input(&project_id, &session.id, "hub", 1, "echo no\n".to_owned())
                .expect_err("unobserved input should fail")
                .code(),
            "terminal_not_observed"
        );
        let observation = service
            .observe(&project_id, &session.id, "hub")
            .expect("terminal should be observed");
        assert_eq!(
            service
                .write_input(
                    &project_id,
                    &session.id,
                    "hub",
                    1,
                    "printf debrute\n".to_owned()
                )
                .expect("input should be acknowledged"),
            1
        );
        assert_eq!(
            service
                .write_input(&project_id, &session.id, "hub", 1, String::new())
                .expect_err("duplicate input should fail")
                .code(),
            "terminal_input_out_of_order"
        );
        let output = (0..20).find_map(|_| {
            match observation
                .receiver
                .recv_timeout(Duration::from_millis(100))
            {
                Ok(TerminalEvent::Output { data_base64, .. }) => {
                    let bytes = STANDARD.decode(data_base64).expect("output should decode");
                    String::from_utf8_lossy(&bytes)
                        .contains("debrute")
                        .then_some(())
                }
                _ => None,
            }
        });
        assert!(output.is_some());
        service
            .close(&project_id, &session.id)
            .expect("terminal should close");
        service.close_all().expect("all terminals should close");
        drop(open_use);
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn natural_exit_retires_the_actor_and_releases_the_running_project_use() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let session = service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        let observation = service
            .observe(&project_id, &session.id, "hub")
            .expect("terminal should be observed");
        service
            .write_input(&project_id, &session.id, "hub", 1, "exit\n".to_owned())
            .expect("exit input should be acknowledged");
        let exited = (0..50).any(|_| {
            matches!(
                observation
                    .receiver
                    .recv_timeout(Duration::from_millis(100)),
                Ok(TerminalEvent::Exit { .. })
            )
        });
        assert!(exited, "terminal should publish its natural exit");
        drop(open_use);
        let released = (0..50).any(|_| {
            if registry.get(&project_id).is_err() {
                true
            } else {
                thread::sleep(Duration::from_millis(20));
                false
            }
        });
        assert!(
            released,
            "natural exit must release the RunningTerminal project_use"
        );
        service
            .close(&project_id, &session.id)
            .expect("retired terminal record should close");
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn natural_exit_retires_even_when_a_background_child_held_the_pty() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let session = service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        let _observation = service
            .observe(&project_id, &session.id, "hub")
            .expect("terminal should be observed");
        service
            .write_input(
                &project_id,
                &session.id,
                "hub",
                1,
                "sleep 30 & disown; sleep 0.1; exit\n".to_owned(),
            )
            .expect("exit input should be acknowledged");
        drop(open_use);
        let released = (0..150).any(|_| {
            if registry.get(&project_id).is_err() {
                true
            } else {
                thread::sleep(Duration::from_millis(20));
                false
            }
        });
        assert!(
            released,
            "a background PTY holder must not retain the actor or Project project_use"
        );
        service
            .close(&project_id, &session.id)
            .expect("retired terminal record should close");
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn terminal_capacity_is_reserved_before_spawning_and_released_on_failure() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let reservations = (0..MAX_TERMINALS_PER_PROJECT)
            .map(|_| service.reserve_terminal(&project_id).unwrap())
            .collect::<Vec<_>>();
        let Err(error) = service.reserve_terminal(&project_id) else {
            panic!("the pre-spawn Project cap should reject the next reservation");
        };
        assert_eq!(error.code(), "terminal_project_limit_reached");
        drop(reservations);
        drop(service.reserve_terminal(&project_id).unwrap());
        drop(open_use);
        registry.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn topology_is_independently_revisioned() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let topology = service
            .subscribe_topology(&project_id)
            .expect("topology should subscribe");
        assert_eq!(topology.snapshot.revision, 0);
        let session = service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        let created = topology.recv().expect("create topology should publish");
        assert_eq!(created.revision, 1);
        assert_eq!(created.sessions.len(), 1);
        service
            .close(&project_id, &session.id)
            .expect("terminal should close");
        let closed = topology.recv().expect("close topology should publish");
        assert_eq!(closed.revision, 2);
        assert!(closed.sessions.is_empty());
        drop(open_use);
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn observer_replacement_is_generation_safe_and_attachment_detach_releases_sequence() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        let session = service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        let first = service
            .observe(&project_id, &session.id, "hub")
            .expect("first observation should start");
        let second = service
            .observe(&project_id, &session.id, "hub")
            .expect("replacement observation should start");
        drop(first);
        assert_eq!(
            service
                .write_input(
                    &project_id,
                    &session.id,
                    "hub",
                    1,
                    "printf one\n".to_owned()
                )
                .expect("replacement observer should remain active"),
            1
        );
        drop(second);
        let third = service
            .observe(&project_id, &session.id, "hub")
            .expect("same attachment should observe again");
        assert_eq!(
            service
                .write_input(&project_id, &session.id, "hub", 1, String::new())
                .expect_err("the same attachment keeps its input sequence")
                .code(),
            "terminal_input_out_of_order"
        );
        drop(third);
        service
            .detach_attachment(&project_id, "hub")
            .expect("attachment state should detach");
        let fourth = service
            .observe(&project_id, &session.id, "hub")
            .expect("a new attachment should observe");
        assert_eq!(
            service
                .write_input(&project_id, &session.id, "hub", 1, String::new())
                .expect("a new attachment starts a new input sequence"),
            1
        );
        drop(fourth);
        service
            .close(&project_id, &session.id)
            .expect("terminal should close");
        drop(open_use);
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn terminal_dimensions_and_input_frames_are_bounded() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        assert_eq!(
            service
                .create(
                    &project_id,
                    CreateTerminalSession {
                        cols: Some(MAX_TERMINAL_COLS + 1),
                        ..CreateTerminalSession::default()
                    },
                )
                .expect_err("oversized terminal should be rejected")
                .code(),
            "terminal_invalid_dimensions"
        );
        assert_eq!(
            service
                .write_input(
                    &project_id,
                    "missing",
                    "hub",
                    1,
                    "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1),
                )
                .expect_err("oversized input should be rejected before admission")
                .code(),
            "terminal_input_too_large"
        );
        drop(open_use);
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }

    #[test]
    fn dropping_the_service_closes_terminal_project_uses() {
        let (root, registry, project_id, open_use) = project_service();
        let service = TerminalService::new(registry.clone());
        service
            .create(&project_id, CreateTerminalSession::default())
            .expect("terminal should start");
        drop(service);
        drop(open_use);
        assert!(
            registry
                .list()
                .expect("registry should remain readable")
                .is_empty()
        );
        registry.close().expect("registry should close");
        fs::remove_dir_all(root).expect("fixture should clean up");
    }
}
