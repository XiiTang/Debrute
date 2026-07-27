use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Condvar, Mutex, MutexGuard, mpsc as std_mpsc},
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

use crate::project::ProjectUse;

use super::DesktopLaunchBinding;

pub const WORKBENCH_CONNECTION_HEADER: &str = "x-debrute-workbench-connection";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkbenchConnectionCounts {
    pub(crate) connections: usize,
    pub(crate) bound_projects: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkbenchConnectionDrainOutcome {
    Completed(WorkbenchConnectionCounts),
    TimedOut(WorkbenchConnectionCounts),
}

pub(crate) struct WorkbenchConnectionCloser {
    connections: Arc<WorkbenchConnectionRegistry>,
    sender: std_mpsc::Sender<WorkbenchConnectionCloseCommand>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

enum WorkbenchConnectionCloseCommand {
    Connection(String),
    All(std_mpsc::SyncSender<()>),
    Shutdown,
}

pub struct WorkbenchConnectionRegistry {
    binding_transaction: Mutex<()>,
    inner: Mutex<ConnectionRegistryInner>,
}

#[derive(Default)]
struct ConnectionRegistryInner {
    records: HashMap<String, ConnectionRecord>,
    credentials_by_browser_session: HashMap<String, HashSet<String>>,
    owner_by_project: HashMap<String, String>,
}

struct ConnectionRecord {
    browser_session: String,
    binding: Option<ConnectionProjectBinding>,
    binding_generation: u64,
    command_gate: Arc<ConnectionCommandGate>,
    desktop: Option<DesktopLaunchBinding>,
    events: mpsc::Sender<Value>,
    cancellation: Option<oneshot::Sender<()>>,
    project_cancellation: broadcast::Sender<()>,
    closing: bool,
}

struct ConnectionProjectBinding {
    project_id: String,
    _project_use: ProjectUse,
}

pub(crate) struct ProjectBindingCommit {
    pub(crate) project_id: String,
    pub(crate) project_use: ProjectUse,
    pub(crate) bound_event: Value,
}

#[derive(Debug, Default)]
struct ConnectionCommandGate {
    state: Mutex<ConnectionCommandGateState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct ConnectionCommandGateState {
    active_project_requests: usize,
    transitioning: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectBindingLease {
    _inner: Arc<ProjectBindingLeaseInner>,
}

#[derive(Debug)]
struct ProjectBindingLeaseInner {
    gate: Arc<ConnectionCommandGate>,
}

struct ConnectionTransition {
    gate: Arc<ConnectionCommandGate>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkbenchConnectionContext {
    pub(crate) credential: String,
    pub(crate) browser_session: String,
    pub(crate) project_id: Option<String>,
    pub(crate) binding_generation: u64,
    pub(crate) desktop: Option<DesktopLaunchBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectBindOutcome {
    Bound {
        generation: u64,
        preempted: Option<PreemptedConnection>,
    },
    AlreadyBound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectBindError {
    Stale,
    EventQueueUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreemptedConnection {
    pub(crate) credential: String,
    pub(crate) desktop: Option<DesktopLaunchBinding>,
}

impl ConnectionCommandGate {
    fn try_acquire(self: &Arc<Self>) -> Option<ProjectBindingLease> {
        let mut state = self
            .state
            .lock()
            .expect("Workbench connection command gate lock poisoned");
        if state.transitioning {
            return None;
        }
        state.active_project_requests = state
            .active_project_requests
            .checked_add(1)
            .expect("Workbench connection active request count overflowed");
        drop(state);
        Some(ProjectBindingLease {
            _inner: Arc::new(ProjectBindingLeaseInner {
                gate: Arc::clone(self),
            }),
        })
    }

    fn begin_transition(self: &Arc<Self>) -> ConnectionTransition {
        let mut state = self
            .state
            .lock()
            .expect("Workbench connection command gate lock poisoned");
        while state.transitioning {
            state = self
                .changed
                .wait(state)
                .expect("Workbench connection command gate wait lock poisoned");
        }
        state.transitioning = true;
        while state.active_project_requests != 0 {
            state = self
                .changed
                .wait(state)
                .expect("Workbench connection command gate wait lock poisoned");
        }
        drop(state);
        ConnectionTransition {
            gate: Arc::clone(self),
        }
    }
}

impl Drop for ProjectBindingLeaseInner {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .expect("Workbench connection command gate lock poisoned");
        state.active_project_requests = state
            .active_project_requests
            .checked_sub(1)
            .expect("Workbench connection active request count underflowed");
        if state.active_project_requests == 0 {
            self.gate.changed.notify_all();
        }
    }
}

impl Drop for ConnectionTransition {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .expect("Workbench connection command gate lock poisoned");
        assert!(
            state.transitioning,
            "Workbench connection transition ended without owning the gate"
        );
        state.transitioning = false;
        self.gate.changed.notify_all();
    }
}

impl WorkbenchConnectionRegistry {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            binding_transaction: Mutex::new(()),
            inner: Mutex::new(ConnectionRegistryInner::default()),
        }
    }

    pub(crate) fn open(
        &self,
        browser_session: String,
        desktop: Option<DesktopLaunchBinding>,
        events: mpsc::Sender<Value>,
    ) -> (WorkbenchConnectionContext, oneshot::Receiver<()>) {
        let credential = Uuid::new_v4().to_string();
        let (cancellation, cancelled) = oneshot::channel();
        let (project_cancellation, _) = broadcast::channel(1);
        let record = ConnectionRecord {
            browser_session: browser_session.clone(),
            binding: None,
            binding_generation: 0,
            command_gate: Arc::new(ConnectionCommandGate::default()),
            desktop: desktop.clone(),
            events,
            cancellation: Some(cancellation),
            project_cancellation,
            closing: false,
        };
        let mut inner = self.lock_inner();
        inner
            .credentials_by_browser_session
            .entry(browser_session.clone())
            .or_default()
            .insert(credential.clone());
        inner.records.insert(credential.clone(), record);
        (
            WorkbenchConnectionContext {
                credential,
                browser_session,
                project_id: None,
                binding_generation: 0,
                desktop,
            },
            cancelled,
        )
    }

    #[must_use]
    pub(crate) fn authorize(
        &self,
        browser_session: &str,
        credential: &str,
    ) -> Option<WorkbenchConnectionContext> {
        let inner = self.lock_inner();
        if inner
            .credentials_by_browser_session
            .get(browser_session)
            .is_none_or(|credentials| !credentials.contains(credential))
        {
            return None;
        }
        let record = inner.records.get(credential)?;
        if record.closing {
            return None;
        }
        Some(WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session.clone(),
            project_id: record
                .binding
                .as_ref()
                .map(|binding| binding.project_id.clone()),
            binding_generation: record.binding_generation,
            desktop: record.desktop.clone(),
        })
    }

    #[must_use]
    pub(crate) fn context(&self, credential: &str) -> Option<WorkbenchConnectionContext> {
        let inner = self.lock_inner();
        let record = inner.records.get(credential)?;
        Some(WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session.clone(),
            project_id: record
                .binding
                .as_ref()
                .map(|binding| binding.project_id.clone()),
            binding_generation: record.binding_generation,
            desktop: record.desktop.clone(),
        })
    }

    #[must_use]
    pub(crate) fn context_for_browser_session_project(
        &self,
        browser_session: &str,
        project_id: &str,
    ) -> Option<WorkbenchConnectionContext> {
        let inner = self.lock_inner();
        let credential = inner.owner_by_project.get(project_id)?;
        let record = inner.records.get(credential)?;
        if record.closing
            || record.browser_session != browser_session
            || record
                .binding
                .as_ref()
                .map(|binding| binding.project_id.as_str())
                != Some(project_id)
        {
            return None;
        }
        Some(WorkbenchConnectionContext {
            credential: credential.clone(),
            browser_session: record.browser_session.clone(),
            project_id: Some(project_id.to_owned()),
            binding_generation: record.binding_generation,
            desktop: record.desktop.clone(),
        })
    }

    #[must_use]
    pub(crate) fn browser_session_is_live(&self, browser_session: &str) -> bool {
        let inner = self.lock_inner();
        inner
            .credentials_by_browser_session
            .get(browser_session)
            .is_some_and(|credentials| {
                credentials.iter().any(|credential| {
                    inner
                        .records
                        .get(credential)
                        .is_some_and(|record| !record.closing)
                })
            })
    }

    #[must_use]
    pub(crate) fn counts(&self) -> WorkbenchConnectionCounts {
        let inner = self.lock_inner();
        WorkbenchConnectionCounts {
            connections: inner.records.len(),
            bound_projects: inner.owner_by_project.len(),
        }
    }

    #[must_use]
    pub fn event_sender(&self, credential: &str) -> Option<mpsc::Sender<Value>> {
        self.lock_inner()
            .records
            .get(credential)
            .map(|record| record.events.clone())
    }

    #[must_use]
    pub(crate) fn project_owner(&self, project_id: &str) -> Option<WorkbenchConnectionContext> {
        let credential = self
            .lock_inner()
            .owner_by_project
            .get(project_id)
            .cloned()?;
        self.context(&credential)
    }

    #[must_use]
    pub(crate) fn acquire_project_binding_with_lifetime(
        &self,
        browser_session: &str,
        credential: &str,
        project_id: &str,
        generation: u64,
    ) -> Option<(ProjectBindingLease, broadcast::Receiver<()>)> {
        let inner = self.lock_inner();
        if inner
            .credentials_by_browser_session
            .get(browser_session)
            .is_none_or(|credentials| !credentials.contains(credential))
        {
            return None;
        }
        let record = inner.records.get(credential)?;
        if record.closing || !binding_matches(record, project_id, generation) {
            return None;
        }
        let lifetime = record.project_cancellation.subscribe();
        let lease = record.command_gate.try_acquire()?;
        Some((lease, lifetime))
    }

    #[must_use]
    pub fn subscribe_project_lifetime(
        &self,
        browser_session: &str,
        credential: &str,
        project_id: &str,
    ) -> Option<broadcast::Receiver<()>> {
        let inner = self.lock_inner();
        if inner
            .credentials_by_browser_session
            .get(browser_session)
            .is_none_or(|credentials| !credentials.contains(credential))
        {
            return None;
        }
        let record = inner.records.get(credential)?;
        if record.closing {
            return None;
        }
        if record
            .binding
            .as_ref()
            .map(|binding| binding.project_id.as_str())
            != Some(project_id)
        {
            return None;
        }
        Some(record.project_cancellation.subscribe())
    }

    pub(crate) fn bind_project(
        &self,
        credential: &str,
        expected_generation: u64,
        commit: ProjectBindingCommit,
    ) -> Result<ProjectBindOutcome, ProjectBindError> {
        let ProjectBindingCommit {
            project_id,
            project_use,
            bound_event,
        } = commit;
        assert_eq!(
            project_use.project_id(),
            project_id,
            "Workbench Project Use must own the bound Project"
        );
        let binding_transaction = self.lock_binding_transaction();
        let (gates, bound_permit) = {
            let inner = self.lock_inner();
            let record = inner
                .records
                .get(credential)
                .ok_or(ProjectBindError::Stale)?;
            if record.closing || record.binding_generation != expected_generation {
                return Err(ProjectBindError::Stale);
            }
            if record
                .binding
                .as_ref()
                .is_some_and(|binding| binding.project_id == project_id)
            {
                return Ok(ProjectBindOutcome::AlreadyBound);
            }
            if record.binding.is_some() {
                return Err(ProjectBindError::Stale);
            }
            let bound_permit = reserve_bound_event(record)?;
            (
                Self::binding_gates(
                    &inner,
                    [
                        Some(credential),
                        inner.owner_by_project.get(&project_id).map(String::as_str),
                    ],
                ),
                bound_permit,
            )
        };
        let transitions = begin_transitions(&gates);

        let mut inner = self.lock_inner();
        let record = inner
            .records
            .get(credential)
            .ok_or(ProjectBindError::Stale)?;
        if record.closing
            || record.binding_generation != expected_generation
            || record.binding.is_some()
        {
            return Err(ProjectBindError::Stale);
        }
        if record.events.is_closed() {
            return Err(ProjectBindError::EventQueueUnavailable);
        }
        bound_permit.send(bound_event);

        let mut released_bindings = Vec::new();
        let (preempted, close_preempted, released_binding) =
            preempt_project_owner(&mut inner, credential, &project_id);
        if let Some(binding) = released_binding {
            released_bindings.push(binding);
        }
        inner
            .owner_by_project
            .insert(project_id.clone(), credential.to_owned());
        let record = inner
            .records
            .get_mut(credential)
            .ok_or(ProjectBindError::Stale)?;
        let _ = record.project_cancellation.send(());
        let generation = next_binding_generation(record.binding_generation);
        record.binding_generation = generation;
        record.binding = Some(ConnectionProjectBinding {
            project_id,
            _project_use: project_use,
        });
        drop(inner);
        drop(released_bindings);
        drop(transitions);
        drop(binding_transaction);
        if close_preempted && let Some(preempted) = preempted.as_ref() {
            self.close(&preempted.credential);
        }
        Ok(ProjectBindOutcome::Bound {
            generation,
            preempted,
        })
    }

    pub(crate) fn replace_project(
        &self,
        credential: &str,
        source_project_id: &str,
        expected_generation: u64,
        commit: ProjectBindingCommit,
    ) -> Result<ProjectBindOutcome, ProjectBindError> {
        let ProjectBindingCommit {
            project_id: target_project_id,
            project_use,
            bound_event,
        } = commit;
        assert_eq!(
            project_use.project_id(),
            target_project_id,
            "Workbench Project Use must own the replacement Project"
        );
        let binding_transaction = self.lock_binding_transaction();
        let (gates, bound_permit) = {
            let inner = self.lock_inner();
            let record = inner
                .records
                .get(credential)
                .ok_or(ProjectBindError::Stale)?;
            if record.closing || !binding_matches(record, source_project_id, expected_generation) {
                return Err(ProjectBindError::Stale);
            }
            if source_project_id == target_project_id {
                return Ok(ProjectBindOutcome::AlreadyBound);
            }
            let bound_permit = reserve_bound_event(record)?;
            (
                Self::binding_gates(
                    &inner,
                    [
                        Some(credential),
                        inner
                            .owner_by_project
                            .get(&target_project_id)
                            .map(String::as_str),
                    ],
                ),
                bound_permit,
            )
        };
        let transitions = begin_transitions(&gates);

        let mut inner = self.lock_inner();
        let record = inner
            .records
            .get(credential)
            .ok_or(ProjectBindError::Stale)?;
        if record.closing || !binding_matches(record, source_project_id, expected_generation) {
            return Err(ProjectBindError::Stale);
        }
        if record.events.is_closed() {
            return Err(ProjectBindError::EventQueueUnavailable);
        }
        bound_permit.send(bound_event);

        remove_source_owner(&mut inner, credential, source_project_id);
        let mut released_bindings = Vec::new();
        let (preempted, close_preempted, released_binding) =
            preempt_project_owner(&mut inner, credential, &target_project_id);
        if let Some(binding) = released_binding {
            released_bindings.push(binding);
        }
        inner
            .owner_by_project
            .insert(target_project_id.clone(), credential.to_owned());
        let record = inner
            .records
            .get_mut(credential)
            .ok_or(ProjectBindError::Stale)?;
        let _ = record.project_cancellation.send(());
        let source_binding = record
            .binding
            .replace(ConnectionProjectBinding {
                project_id: target_project_id,
                _project_use: project_use,
            })
            .expect("replacement source Project binding must exist");
        assert_eq!(
            source_binding.project_id, source_project_id,
            "replacement source binding must match its owner index"
        );
        released_bindings.push(source_binding);
        let generation = next_binding_generation(record.binding_generation);
        record.binding_generation = generation;
        drop(inner);
        drop(released_bindings);
        drop(transitions);
        drop(binding_transaction);
        if close_preempted && let Some(preempted) = preempted.as_ref() {
            self.close(&preempted.credential);
        }
        Ok(ProjectBindOutcome::Bound {
            generation,
            preempted,
        })
    }

    pub(crate) fn close(&self, credential: &str) -> Option<WorkbenchConnectionContext> {
        let binding_transaction = self.lock_binding_transaction();
        let gate = {
            let mut inner = self.lock_inner();
            let record = inner.records.get_mut(credential)?;
            signal_connection_close(record);
            Arc::clone(&record.command_gate)
        };
        let transition = gate.begin_transition();
        let context = self.remove_connection(credential);
        drop(transition);
        drop(binding_transaction);
        context
    }

    pub(crate) fn close_project_stream(
        &self,
        credential: &str,
        project_id: &str,
        generation: u64,
    ) -> bool {
        let binding_transaction = self.lock_binding_transaction();
        let gate = {
            let mut inner = self.lock_inner();
            let Some(record) = inner.records.get_mut(credential) else {
                return false;
            };
            if !binding_matches(record, project_id, generation) {
                return false;
            }
            signal_connection_close(record);
            Arc::clone(&record.command_gate)
        };
        let transition = gate.begin_transition();
        let is_current = self
            .lock_inner()
            .records
            .get(credential)
            .is_some_and(|record| binding_matches(record, project_id, generation));
        if !is_current {
            return false;
        }
        let closed = self.remove_connection(credential).is_some();
        drop(transition);
        drop(binding_transaction);
        closed
    }

    fn remove_connection(&self, credential: &str) -> Option<WorkbenchConnectionContext> {
        let mut inner = self.lock_inner();
        let mut record = inner.records.remove(credential)?;
        if let Some(credentials) = inner
            .credentials_by_browser_session
            .get_mut(&record.browser_session)
        {
            credentials.remove(credential);
            if credentials.is_empty() {
                inner
                    .credentials_by_browser_session
                    .remove(&record.browser_session);
            }
        }
        let binding = record.binding.take();
        let project_id = binding.as_ref().map(|binding| binding.project_id.clone());
        if let Some(project_id) = project_id.as_ref()
            && inner
                .owner_by_project
                .get(project_id)
                .is_some_and(|owner| owner == credential)
        {
            inner.owner_by_project.remove(project_id);
        }
        let context = WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session,
            project_id,
            binding_generation: record.binding_generation,
            desktop: record.desktop,
        };
        drop(inner);
        drop(binding);
        Some(context)
    }

    pub(crate) fn close_all(&self) {
        let binding_transaction = self.lock_binding_transaction();
        let gates = {
            let mut inner = self.lock_inner();
            inner
                .records
                .values_mut()
                .map(|record| {
                    signal_connection_close(record);
                    Arc::clone(&record.command_gate)
                })
                .collect::<Vec<_>>()
        };
        let transitions = gates
            .iter()
            .map(ConnectionCommandGate::begin_transition)
            .collect::<Vec<_>>();
        let records = {
            let mut inner = self.lock_inner();
            inner.credentials_by_browser_session.clear();
            inner.owner_by_project.clear();
            std::mem::take(&mut inner.records)
        };
        drop(records);
        drop(transitions);
        drop(binding_transaction);
    }

    pub(crate) fn request_close(&self, credential: &str) -> bool {
        self.lock_inner()
            .records
            .get_mut(credential)
            .is_some_and(signal_connection_close)
    }

    pub(crate) fn request_close_all(&self) {
        for record in self.lock_inner().records.values_mut() {
            signal_connection_close(record);
        }
    }

    fn binding_gates<'a>(
        inner: &ConnectionRegistryInner,
        credentials: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Vec<Arc<ConnectionCommandGate>> {
        let mut credentials = credentials
            .into_iter()
            .flatten()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        credentials.sort_unstable();
        credentials.dedup();
        credentials
            .into_iter()
            .map(|credential| {
                Arc::clone(
                    &inner
                        .records
                        .get(&credential)
                        .expect("Workbench Project owner must reference a live connection")
                        .command_gate,
                )
            })
            .collect()
    }

    fn lock_binding_transaction(&self) -> MutexGuard<'_, ()> {
        self.binding_transaction
            .lock()
            .expect("Workbench Project binding transaction lock poisoned")
    }

    fn lock_inner(&self) -> MutexGuard<'_, ConnectionRegistryInner> {
        self.inner
            .lock()
            .expect("Workbench connection registry lock poisoned")
    }
}

impl WorkbenchConnectionCloser {
    #[must_use]
    pub(crate) fn start(connections: Arc<WorkbenchConnectionRegistry>) -> Self {
        let (sender, receiver) = std_mpsc::channel();
        let worker_connections = Arc::clone(&connections);
        let worker = thread::Builder::new()
            .name("debrute-workbench-connection-closer".to_owned())
            .spawn(move || {
                while let Ok(command) = receiver.recv() {
                    match command {
                        WorkbenchConnectionCloseCommand::Connection(credential) => {
                            worker_connections.close(&credential);
                        }
                        WorkbenchConnectionCloseCommand::All(completed) => {
                            worker_connections.close_all();
                            let _ = completed.send(());
                        }
                        WorkbenchConnectionCloseCommand::Shutdown => return,
                    }
                }
            })
            .expect("Workbench connection closer thread must start");
        Self {
            connections,
            sender,
            thread: Mutex::new(Some(worker)),
        }
    }

    pub(crate) fn request_close(&self, credential: String) {
        if !self.connections.request_close(&credential) {
            return;
        }
        self.sender
            .send(WorkbenchConnectionCloseCommand::Connection(credential))
            .expect("Workbench connection closer must remain available");
    }

    pub(crate) fn shutdown(&self) {
        let worker = self
            .thread
            .lock()
            .expect("Workbench connection closer thread lock poisoned")
            .take();
        let Some(worker) = worker else {
            return;
        };
        let _ = self.sender.send(WorkbenchConnectionCloseCommand::Shutdown);
        worker
            .join()
            .expect("Workbench connection closer thread panicked");
    }

    #[must_use]
    pub(crate) fn close_all(&self, timeout: Duration) -> WorkbenchConnectionDrainOutcome {
        let counts = self.connections.counts();
        self.connections.request_close_all();
        let worker_running = self
            .thread
            .lock()
            .expect("Workbench connection closer thread lock poisoned")
            .is_some();
        if !worker_running {
            self.connections.close_all();
            return WorkbenchConnectionDrainOutcome::Completed(counts);
        }
        let (completed, completion) = std_mpsc::sync_channel(0);
        self.sender
            .send(WorkbenchConnectionCloseCommand::All(completed))
            .expect("Workbench connection closer must remain available");
        match completion.recv_timeout(timeout) {
            Ok(()) => WorkbenchConnectionDrainOutcome::Completed(counts),
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                WorkbenchConnectionDrainOutcome::TimedOut(counts)
            }
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                panic!("Workbench connection closer stopped before completing the drain")
            }
        }
    }
}

fn signal_connection_close(record: &mut ConnectionRecord) -> bool {
    if record.closing {
        return false;
    }
    record.closing = true;
    if let Some(cancellation) = record.cancellation.take() {
        let _ = cancellation.send(());
    }
    let _ = record.project_cancellation.send(());
    true
}

impl Drop for WorkbenchConnectionCloser {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn binding_matches(record: &ConnectionRecord, project_id: &str, generation: u64) -> bool {
    record.binding_generation == generation
        && record
            .binding
            .as_ref()
            .is_some_and(|binding| binding.project_id == project_id)
}

fn reserve_bound_event(
    record: &ConnectionRecord,
) -> Result<mpsc::OwnedPermit<Value>, ProjectBindError> {
    record
        .events
        .clone()
        .try_reserve_owned()
        .map_err(|_| ProjectBindError::EventQueueUnavailable)
}

fn begin_transitions(gates: &[Arc<ConnectionCommandGate>]) -> Vec<ConnectionTransition> {
    gates
        .iter()
        .map(ConnectionCommandGate::begin_transition)
        .collect()
}

fn preempt_project_owner(
    inner: &mut ConnectionRegistryInner,
    new_owner: &str,
    project_id: &str,
) -> (
    Option<PreemptedConnection>,
    bool,
    Option<ConnectionProjectBinding>,
) {
    let Some(previous) = inner.owner_by_project.get(project_id).cloned() else {
        return (None, false, None);
    };
    if previous == new_owner {
        return (None, false, None);
    }
    let record = inner
        .records
        .get_mut(&previous)
        .expect("Workbench Project owner must reference a live connection");
    let _ = record.project_cancellation.send(());
    let binding = record
        .binding
        .take()
        .expect("Workbench Project owner must have a binding");
    assert_eq!(
        binding.project_id, project_id,
        "Workbench Project owner binding must match its owner index"
    );
    record.binding_generation = next_binding_generation(record.binding_generation);
    let close_preempted = record
        .events
        .try_send(json!({
            "type": "project.preempted",
            "projectId": project_id
        }))
        .is_err();
    (
        Some(PreemptedConnection {
            credential: previous,
            desktop: record.desktop.clone(),
        }),
        close_preempted,
        Some(binding),
    )
}

fn remove_source_owner(inner: &mut ConnectionRegistryInner, credential: &str, project_id: &str) {
    assert_eq!(
        inner.owner_by_project.get(project_id).map(String::as_str),
        Some(credential),
        "bound Workbench connection must own its source Project"
    );
    inner.owner_by_project.remove(project_id);
}

fn next_binding_generation(generation: u64) -> u64 {
    generation
        .checked_add(1)
        .expect("Workbench Project binding generation overflowed")
}

impl Default for WorkbenchConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, mpsc as std_mpsc},
        time::Duration,
    };

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use crate::project::ProjectUse;

    use super::{
        ProjectBindError, ProjectBindingCommit, WorkbenchConnectionCloser,
        WorkbenchConnectionDrainOutcome, WorkbenchConnectionRegistry,
    };

    fn project_use(project_id: &str) -> ProjectUse {
        ProjectUse::detached_for_test(project_id)
    }

    fn binding(project_id: &str) -> ProjectBindingCommit {
        ProjectBindingCommit {
            project_id: project_id.to_owned(),
            project_use: project_use(project_id),
            bound_event: json!({"type": "project.bound"}),
        }
    }

    #[test]
    fn project_lifetime_ends_on_replacement_and_connection_close() {
        let registry = WorkbenchConnectionRegistry::new();
        let (events, _receiver) = mpsc::channel::<Value>(4);
        let (connection, _closed) = registry.open("browser-1".to_owned(), None, events);
        registry
            .bind_project(&connection.credential, 0, binding("project-1"))
            .expect("initial Project should bind");
        let mut first = registry
            .subscribe_project_lifetime("browser-1", &connection.credential, "project-1")
            .expect("bound Project lifetime should be observable");

        registry
            .replace_project(&connection.credential, "project-1", 1, binding("project-2"))
            .expect("Project should replace");
        assert_eq!(first.try_recv(), Ok(()));

        let mut second = registry
            .subscribe_project_lifetime("browser-1", &connection.credential, "project-2")
            .expect("replacement Project lifetime should be observable");
        registry.close(&connection.credential);
        assert_eq!(second.try_recv(), Ok(()));
    }

    #[test]
    fn close_all_ends_every_connection_and_project_lifetime() {
        let registry = WorkbenchConnectionRegistry::new();
        let (first_events, _first_receiver) = mpsc::channel::<Value>(4);
        let (first, mut first_closed) = registry.open("browser-1".to_owned(), None, first_events);
        registry
            .bind_project(&first.credential, 0, binding("project-1"))
            .expect("first project should bind");
        let mut first_project_closed = registry
            .subscribe_project_lifetime("browser-1", &first.credential, "project-1")
            .expect("first project lifetime should exist");

        let (second_events, _second_receiver) = mpsc::channel::<Value>(4);
        let (second, mut second_closed) =
            registry.open("browser-2".to_owned(), None, second_events);
        registry
            .bind_project(&second.credential, 0, binding("project-2"))
            .expect("second project should bind");
        let mut second_project_closed = registry
            .subscribe_project_lifetime("browser-2", &second.credential, "project-2")
            .expect("second project lifetime should exist");

        registry.close_all();

        assert!(first_closed.try_recv().is_ok());
        assert!(second_closed.try_recv().is_ok());
        assert!(first_project_closed.try_recv().is_ok());
        assert!(second_project_closed.try_recv().is_ok());
        assert!(registry.context(&first.credential).is_none());
        assert!(registry.context(&second.credential).is_none());
        assert!(registry.project_owner("project-1").is_none());
        assert!(registry.project_owner("project-2").is_none());
    }

    #[test]
    fn connection_closer_deadline_does_not_abort_an_accepted_project_request() {
        let registry = Arc::new(WorkbenchConnectionRegistry::new());
        let closer = WorkbenchConnectionCloser::start(Arc::clone(&registry));
        let (events, _receiver) = mpsc::channel::<Value>(4);
        let (connection, mut connection_closed) =
            registry.open("browser-1".to_owned(), None, events);
        registry
            .bind_project(&connection.credential, 0, binding("project-1"))
            .expect("Project should bind");
        let lease = registry
            .acquire_project_binding_with_lifetime(
                "browser-1",
                &connection.credential,
                "project-1",
                1,
            )
            .map(|(lease, _lifetime)| lease)
            .expect("accepted Project request should own a lease");

        assert_eq!(
            closer.close_all(Duration::from_millis(10)),
            WorkbenchConnectionDrainOutcome::TimedOut(super::WorkbenchConnectionCounts {
                connections: 1,
                bound_projects: 1,
            })
        );
        assert!(connection_closed.try_recv().is_ok());
        assert!(registry.context(&connection.credential).is_some());

        drop(lease);
        for _ in 0..50 {
            if registry.context(&connection.credential).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("connection closer did not finish after the accepted request ended");
    }

    #[test]
    fn close_all_signals_every_connection_before_a_queued_retirement_can_finish() {
        let registry = Arc::new(WorkbenchConnectionRegistry::new());
        let closer = WorkbenchConnectionCloser::start(Arc::clone(&registry));
        let (first_events, _first_receiver) = mpsc::channel::<Value>(4);
        let (first, mut first_closed) = registry.open("browser-1".to_owned(), None, first_events);
        registry
            .bind_project(&first.credential, 0, binding("project-1"))
            .expect("first Project should bind");
        let lease = registry
            .acquire_project_binding_with_lifetime("browser-1", &first.credential, "project-1", 1)
            .map(|(lease, _lifetime)| lease)
            .expect("accepted Project request should own a lease");

        let (second_events, _second_receiver) = mpsc::channel::<Value>(4);
        let (second, mut second_closed) =
            registry.open("browser-2".to_owned(), None, second_events);
        registry
            .bind_project(&second.credential, 0, binding("project-2"))
            .expect("second Project should bind");
        let mut second_project_closed = registry
            .subscribe_project_lifetime("browser-2", &second.credential, "project-2")
            .expect("second Project lifetime should exist");

        closer.request_close(first.credential.clone());
        assert_eq!(
            closer.close_all(Duration::from_millis(10)),
            WorkbenchConnectionDrainOutcome::TimedOut(super::WorkbenchConnectionCounts {
                connections: 2,
                bound_projects: 2,
            })
        );
        assert!(first_closed.try_recv().is_ok());
        assert!(second_closed.try_recv().is_ok());
        assert!(second_project_closed.try_recv().is_ok());
        assert!(
            registry
                .authorize("browser-2", &second.credential)
                .is_none(),
            "a signalled connection must stop admitting new work"
        );

        drop(lease);
        for _ in 0..100 {
            if registry.context(&first.credential).is_none()
                && registry.context(&second.credential).is_none()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("queued connection retirements did not finish after the accepted request ended");
    }

    #[test]
    fn replacement_preparation_failure_preserves_both_project_owners() {
        let registry = WorkbenchConnectionRegistry::new();
        let (target_events, mut target_receiver) = mpsc::channel::<Value>(4);
        let (target_owner, _target_closed) =
            registry.open("browser-1".to_owned(), None, target_events);
        registry
            .bind_project(&target_owner.credential, 0, binding("project-b"))
            .expect("target Project should bind");
        assert!(target_receiver.try_recv().is_ok());
        let mut target_lifetime = registry
            .subscribe_project_lifetime("browser-1", &target_owner.credential, "project-b")
            .expect("target Project lifetime should exist");

        let (source_events, _source_receiver) = mpsc::channel::<Value>(1);
        let (source_owner, _source_closed) =
            registry.open("browser-2".to_owned(), None, source_events);
        registry
            .bind_project(&source_owner.credential, 0, binding("project-a"))
            .expect("source Project should bind");
        let mut source_lifetime = registry
            .subscribe_project_lifetime("browser-2", &source_owner.credential, "project-a")
            .expect("source Project lifetime should exist");

        let error = registry
            .replace_project(
                &source_owner.credential,
                "project-a",
                1,
                binding("project-b"),
            )
            .expect_err("a full source event queue must reject preparation");

        assert_eq!(error, ProjectBindError::EventQueueUnavailable);
        assert_eq!(
            registry
                .project_owner("project-a")
                .expect("source owner should remain")
                .credential,
            source_owner.credential
        );
        assert_eq!(
            registry
                .project_owner("project-b")
                .expect("target owner should remain")
                .credential,
            target_owner.credential
        );
        assert!(source_lifetime.try_recv().is_err());
        assert!(target_lifetime.try_recv().is_err());
        assert!(target_receiver.try_recv().is_err());
    }

    #[test]
    fn replacement_waits_for_old_generation_requests_before_committing() {
        let registry = Arc::new(WorkbenchConnectionRegistry::new());
        let (events, mut receiver) = mpsc::channel::<Value>(4);
        let (connection, _closed) = registry.open("browser-1".to_owned(), None, events);
        registry
            .bind_project(&connection.credential, 0, binding("project-a"))
            .expect("source Project should bind");
        assert!(receiver.try_recv().is_ok());
        let lease = registry
            .acquire_project_binding_with_lifetime(
                "browser-1",
                &connection.credential,
                "project-a",
                1,
            )
            .map(|(lease, _lifetime)| lease)
            .expect("current generation should authorize a Project request");

        let (started_sender, started_receiver) = std_mpsc::channel();
        let (result_sender, result_receiver) = std_mpsc::channel();
        let replacing_registry = Arc::clone(&registry);
        let credential = connection.credential.clone();
        let worker = std::thread::spawn(move || {
            started_sender.send(()).expect("test should observe worker");
            let result = replacing_registry.replace_project(
                &credential,
                "project-a",
                1,
                binding("project-b"),
            );
            result_sender
                .send(result)
                .expect("test should receive replacement result");
        });
        started_receiver
            .recv()
            .expect("replacement worker should start");
        assert!(
            result_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "replacement must wait while the old generation request is active"
        );

        drop(lease);
        result_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("replacement should finish after the request ends")
            .expect("replacement should succeed");
        worker.join().expect("replacement worker should finish");

        let context = registry
            .context(&connection.credential)
            .expect("connection should remain live");
        assert_eq!(context.project_id.as_deref(), Some("project-b"));
        assert_eq!(context.binding_generation, 2);
        assert!(
            registry
                .acquire_project_binding_with_lifetime(
                    "browser-1",
                    &connection.credential,
                    "project-a",
                    1,
                )
                .is_none()
        );
        assert!(
            !registry.close_project_stream(&connection.credential, "project-a", 1),
            "an ended source stream must not close the replacement binding"
        );
        assert_eq!(
            registry
                .context(&connection.credential)
                .expect("replacement connection should remain live")
                .project_id
                .as_deref(),
            Some("project-b")
        );
    }

    #[test]
    fn browser_session_keeps_each_document_connection_live_until_the_last_closes() {
        let registry = WorkbenchConnectionRegistry::new();
        let (first_events, _first_receiver) = mpsc::channel::<Value>(4);
        let (first, _first_closed) = registry.open("browser-1".to_owned(), None, first_events);
        let (second_events, _second_receiver) = mpsc::channel::<Value>(4);
        let (second, _second_closed) = registry.open("browser-1".to_owned(), None, second_events);

        assert!(registry.authorize("browser-1", &first.credential).is_some());
        assert!(
            registry
                .authorize("browser-1", &second.credential)
                .is_some()
        );

        registry.close(&second.credential);

        assert!(registry.authorize("browser-1", &first.credential).is_some());
        assert!(registry.browser_session_is_live("browser-1"));

        registry.close(&first.credential);

        assert!(!registry.browser_session_is_live("browser-1"));
    }
}
