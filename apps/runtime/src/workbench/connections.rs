use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, PoisonError},
};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

use super::DesktopLaunchBinding;

pub const WORKBENCH_CONNECTION_HEADER: &str = "x-debrute-workbench-connection";

pub(crate) struct WorkbenchConnectionRegistry {
    inner: Mutex<ConnectionRegistryInner>,
}

#[derive(Default)]
struct ConnectionRegistryInner {
    records: HashMap<String, ConnectionRecord>,
    credential_by_browser_session: HashMap<String, String>,
    owner_by_project: HashMap<String, String>,
}

struct ConnectionRecord {
    browser_session: String,
    project_id: Option<String>,
    desktop: Option<DesktopLaunchBinding>,
    events: mpsc::Sender<Value>,
    cancellation: Option<oneshot::Sender<()>>,
    project_cancellation: broadcast::Sender<()>,
}

#[derive(Debug, Clone)]
pub(crate) struct WorkbenchConnectionContext {
    pub(crate) credential: String,
    pub(crate) browser_session: String,
    pub(crate) project_id: Option<String>,
    pub(crate) desktop: Option<DesktopLaunchBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProjectBindOutcome {
    Bound {
        preempted: Option<PreemptedConnection>,
    },
    AlreadyBound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreemptedConnection {
    pub(crate) credential: String,
    pub(crate) desktop: Option<DesktopLaunchBinding>,
}

impl WorkbenchConnectionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(ConnectionRegistryInner::default()),
        }
    }

    pub fn open(
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
            project_id: None,
            desktop: desktop.clone(),
            events,
            cancellation: Some(cancellation),
            project_cancellation,
        };
        let mut inner = self.lock_inner();
        inner
            .credential_by_browser_session
            .insert(browser_session.clone(), credential.clone());
        inner.records.insert(credential.clone(), record);
        (
            WorkbenchConnectionContext {
                credential,
                browser_session,
                project_id: None,
                desktop,
            },
            cancelled,
        )
    }

    #[must_use]
    pub fn authorize(
        &self,
        browser_session: &str,
        credential: &str,
    ) -> Option<WorkbenchConnectionContext> {
        let inner = self.lock_inner();
        if inner
            .credential_by_browser_session
            .get(browser_session)
            .is_none_or(|current| current != credential)
        {
            return None;
        }
        let record = inner.records.get(credential)?;
        Some(WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session.clone(),
            project_id: record.project_id.clone(),
            desktop: record.desktop.clone(),
        })
    }

    #[must_use]
    pub fn context(&self, credential: &str) -> Option<WorkbenchConnectionContext> {
        let inner = self.lock_inner();
        let record = inner.records.get(credential)?;
        Some(WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session.clone(),
            project_id: record.project_id.clone(),
            desktop: record.desktop.clone(),
        })
    }

    #[must_use]
    pub fn context_for_browser_session(
        &self,
        browser_session: &str,
    ) -> Option<WorkbenchConnectionContext> {
        let credential = self
            .lock_inner()
            .credential_by_browser_session
            .get(browser_session)
            .cloned()?;
        self.context(&credential)
    }

    #[must_use]
    pub fn event_sender(&self, credential: &str) -> Option<mpsc::Sender<Value>> {
        self.lock_inner()
            .records
            .get(credential)
            .map(|record| record.events.clone())
    }

    #[must_use]
    pub fn project_owner(&self, project_id: &str) -> Option<WorkbenchConnectionContext> {
        let credential = self
            .lock_inner()
            .owner_by_project
            .get(project_id)
            .cloned()?;
        self.context(&credential)
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
            .credential_by_browser_session
            .get(browser_session)
            .is_none_or(|current| current != credential)
        {
            return None;
        }
        let record = inner.records.get(credential)?;
        if record.project_id.as_deref() != Some(project_id) {
            return None;
        }
        Some(record.project_cancellation.subscribe())
    }

    pub fn bind_project(
        &self,
        credential: &str,
        project_id: &str,
    ) -> Result<ProjectBindOutcome, ()> {
        let mut inner = self.lock_inner();
        let current = inner.records.get(credential).ok_or(())?.project_id.clone();
        if current.as_deref() == Some(project_id) {
            return Ok(ProjectBindOutcome::AlreadyBound);
        }
        if current.is_some() {
            return Err(());
        }
        let previous = inner
            .owner_by_project
            .insert(project_id.to_owned(), credential.to_owned());
        let mut close_preempted = false;
        let preempted = if let Some(previous) = previous.as_ref()
            && previous != credential
            && let Some(record) = inner.records.get_mut(previous)
        {
            let _ = record.project_cancellation.send(());
            record.project_id = None;
            close_preempted = record
                .events
                .try_send(json!({
                    "type": "project.preempted",
                    "projectId": project_id
                }))
                .is_err();
            Some(PreemptedConnection {
                credential: previous.clone(),
                desktop: record.desktop.clone(),
            })
        } else {
            None
        };
        let record = inner.records.get_mut(credential).ok_or(())?;
        let _ = record.project_cancellation.send(());
        record.project_id = Some(project_id.to_owned());
        drop(inner);
        if close_preempted && let Some(preempted) = preempted.as_ref() {
            self.close(&preempted.credential);
        }
        Ok(ProjectBindOutcome::Bound { preempted })
    }

    pub fn replace_project(
        &self,
        credential: &str,
        source_project_id: &str,
        target_project_id: &str,
    ) -> Result<ProjectBindOutcome, ()> {
        let mut inner = self.lock_inner();
        let record = inner.records.get(credential).ok_or(())?;
        if record.project_id.as_deref() != Some(source_project_id) {
            return Err(());
        }
        if source_project_id == target_project_id {
            return Ok(ProjectBindOutcome::AlreadyBound);
        }
        inner.owner_by_project.remove(source_project_id);
        let previous = inner
            .owner_by_project
            .insert(target_project_id.to_owned(), credential.to_owned());
        let mut close_preempted = false;
        let preempted = if let Some(previous) = previous.as_ref()
            && previous != credential
            && let Some(record) = inner.records.get_mut(previous)
        {
            let _ = record.project_cancellation.send(());
            record.project_id = None;
            close_preempted = record
                .events
                .try_send(json!({
                    "type": "project.preempted",
                    "projectId": target_project_id
                }))
                .is_err();
            Some(PreemptedConnection {
                credential: previous.clone(),
                desktop: record.desktop.clone(),
            })
        } else {
            None
        };
        let record = inner.records.get_mut(credential).ok_or(())?;
        let _ = record.project_cancellation.send(());
        record.project_id = Some(target_project_id.to_owned());
        drop(inner);
        if close_preempted && let Some(preempted) = preempted.as_ref() {
            self.close(&preempted.credential);
        }
        Ok(ProjectBindOutcome::Bound { preempted })
    }

    pub fn close(&self, credential: &str) -> Option<WorkbenchConnectionContext> {
        let mut inner = self.lock_inner();
        let mut record = inner.records.remove(credential)?;
        inner
            .credential_by_browser_session
            .remove(&record.browser_session);
        if let Some(project_id) = record.project_id.as_ref()
            && inner
                .owner_by_project
                .get(project_id)
                .is_some_and(|owner| owner == credential)
        {
            inner.owner_by_project.remove(project_id);
        }
        if let Some(cancellation) = record.cancellation.take() {
            let _ = cancellation.send(());
        }
        let _ = record.project_cancellation.send(());
        Some(WorkbenchConnectionContext {
            credential: credential.to_owned(),
            browser_session: record.browser_session,
            project_id: record.project_id,
            desktop: record.desktop,
        })
    }

    pub fn close_all(&self) {
        let records = {
            let mut inner = self.lock_inner();
            inner.credential_by_browser_session.clear();
            inner.owner_by_project.clear();
            std::mem::take(&mut inner.records)
        };
        for (_, mut record) in records {
            if let Some(cancellation) = record.cancellation.take() {
                let _ = cancellation.send(());
            }
            let _ = record.project_cancellation.send(());
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, ConnectionRegistryInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for WorkbenchConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tokio::sync::mpsc;

    use super::WorkbenchConnectionRegistry;

    #[test]
    fn project_lifetime_ends_on_replacement_and_connection_close() {
        let registry = WorkbenchConnectionRegistry::new();
        let (events, _receiver) = mpsc::channel::<Value>(4);
        let (connection, _closed) = registry.open("browser-1".to_owned(), None, events);
        registry
            .bind_project(&connection.credential, "project-1")
            .expect("initial Project should bind");
        let mut first = registry
            .subscribe_project_lifetime("browser-1", &connection.credential, "project-1")
            .expect("bound Project lifetime should be observable");

        registry
            .replace_project(&connection.credential, "project-1", "project-2")
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
            .bind_project(&first.credential, "project-1")
            .expect("first project should bind");
        let mut first_project_closed = registry
            .subscribe_project_lifetime("browser-1", &first.credential, "project-1")
            .expect("first project lifetime should exist");

        let (second_events, _second_receiver) = mpsc::channel::<Value>(4);
        let (second, mut second_closed) =
            registry.open("browser-2".to_owned(), None, second_events);
        registry
            .bind_project(&second.credential, "project-2")
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
}
