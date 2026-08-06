use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::now_rfc3339;

pub(crate) type ActivityObserver = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivitySource {
    Project,
    Canvas,
    Explorer,
    ModelRequest,
    Photoshop,
    Workbench,
    Update,
    Integration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityProjectContext {
    pub canonical_root: String,
    pub project_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectActivityOperation {
    Open,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CanvasActivityOperation {
    FeedbackUnavailable,
    FeedbackSave,
    SaveTextViewport,
    SaveLayout,
    SaveVideoPlayback,
    SetDirectoryDisclosure,
    RevealPath,
    RaiseSelection,
    Create,
    Rename,
    Delete,
    Reorder,
    ResetAutoLayout,
    ResetLayout,
    CopyPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExplorerActivityOperation {
    LoadDirectory,
    Copy,
    Move,
    Import,
    CopyPath,
    Reveal,
    Delete,
    Paste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkbenchActivityOperation {
    WindowState,
    WindowCommand,
    MenuCommand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrationActivityOperation {
    Install,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelRequestKind {
    Image,
    Video,
    Tts,
    Music,
    SoundEffect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ActivityNoticeReport {
    ProjectOpened {},
    ProjectViewStateReset {},
    ProjectOperationFailed {
        operation: ProjectActivityOperation,
    },
    CanvasOperationFailed {
        operation: CanvasActivityOperation,
    },
    ExplorerOperationFailed {
        operation: ExplorerActivityOperation,
    },
    WorkbenchOperationFailed {
        operation: WorkbenchActivityOperation,
    },
    UpdateInstallFailed {},
}

impl ActivityNoticeReport {
    #[must_use]
    pub const fn is_project_scoped(self) -> bool {
        matches!(
            self,
            Self::ProjectOpened {}
                | Self::ProjectViewStateReset {}
                | Self::ProjectOperationFailed { .. }
                | Self::CanvasOperationFailed { .. }
                | Self::ExplorerOperationFailed { .. }
        )
    }
}

impl From<ActivityNoticeReport> for ActivityMessage {
    fn from(report: ActivityNoticeReport) -> Self {
        match report {
            ActivityNoticeReport::ProjectOpened {} => Self::ProjectOpened,
            ActivityNoticeReport::ProjectViewStateReset {} => Self::ProjectViewStateReset,
            ActivityNoticeReport::ProjectOperationFailed { operation } => {
                Self::ProjectOperationFailed { operation }
            }
            ActivityNoticeReport::CanvasOperationFailed { operation } => {
                Self::CanvasOperationFailed { operation }
            }
            ActivityNoticeReport::ExplorerOperationFailed { operation } => {
                Self::ExplorerOperationFailed { operation }
            }
            ActivityNoticeReport::WorkbenchOperationFailed { operation } => {
                Self::WorkbenchOperationFailed { operation }
            }
            ActivityNoticeReport::UpdateInstallFailed {} => Self::UpdateInstallFailed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityMessage {
    ProjectOpened,
    ProjectViewStateReset,
    ProjectOperationFailed {
        operation: ProjectActivityOperation,
    },
    CanvasOperationFailed {
        operation: CanvasActivityOperation,
    },
    ExplorerOperationFailed {
        operation: ExplorerActivityOperation,
    },
    WorkbenchOperationFailed {
        operation: WorkbenchActivityOperation,
    },
    UpdateInstallFailed,
    ModelRequest {
        model_kind: ModelRequestKind,
        item_count: usize,
    },
    PhotoshopSend {
        project_relative_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        document_title: Option<String>,
    },
    IntegrationOperation {
        integration_id: String,
        operation: IntegrationActivityOperation,
    },
}

impl ActivityMessage {
    #[must_use]
    pub const fn source(&self) -> ActivitySource {
        match self {
            Self::ProjectOpened
            | Self::ProjectViewStateReset
            | Self::ProjectOperationFailed { .. } => ActivitySource::Project,
            Self::CanvasOperationFailed { .. } => ActivitySource::Canvas,
            Self::ExplorerOperationFailed { .. } => ActivitySource::Explorer,
            Self::WorkbenchOperationFailed { .. } => ActivitySource::Workbench,
            Self::UpdateInstallFailed => ActivitySource::Update,
            Self::ModelRequest { .. } => ActivitySource::ModelRequest,
            Self::PhotoshopSend { .. } => ActivitySource::Photoshop,
            Self::IntegrationOperation { .. } => ActivitySource::Integration,
        }
    }

    #[must_use]
    pub const fn is_task(&self) -> bool {
        matches!(
            self,
            Self::ModelRequest { .. }
                | Self::PhotoshopSend { .. }
                | Self::IntegrationOperation { .. }
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityTaskStatus {
    Running,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
}

impl ActivityTaskStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityProgress {
    Indeterminate,
    Determinate { completed: usize, total: usize },
}

impl ActivityProgress {
    fn is_valid(&self) -> bool {
        match self {
            Self::Indeterminate => true,
            Self::Determinate { completed, total } => *total > 0 && completed <= total,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityPayload {
    Notice {
        message: ActivityMessage,
    },
    Task {
        status: ActivityTaskStatus,
        progress: ActivityProgress,
        message: ActivityMessage,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    pub id: String,
    pub source: ActivitySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ActivityProjectContext>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub payload: ActivityPayload,
}

impl ActivityRecord {
    #[must_use]
    pub const fn is_active_task(&self) -> bool {
        matches!(
            self.payload,
            ActivityPayload::Task { status, .. } if !status.is_terminal()
        )
    }

    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        !self.is_active_task()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub revision: u64,
    pub records: Vec<ActivityRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ActivityChange {
    Upsert { record: ActivityRecord },
    Remove { activity_ids: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub revision: u64,
    #[serde(flatten)]
    pub change: ActivityChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityUpdateError {
    NotFound,
    NotActive,
    InvalidProgress,
}

struct ActivityState {
    revision: u64,
    records: Vec<ActivityRecord>,
    observer: Option<ActivityObserver>,
}

pub struct ActivityService {
    state: Mutex<ActivityState>,
    next_published_revision: Mutex<u64>,
    publish_changed: Condvar,
}

impl Default for ActivityService {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityService {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ActivityState {
                revision: 0,
                records: Vec::new(),
                observer: None,
            }),
            next_published_revision: Mutex::new(1),
            publish_changed: Condvar::new(),
        }
    }

    pub(crate) fn install_observer(&self, observer: ActivityObserver) -> bool {
        let mut state = self.lock_state();
        if state.observer.is_some() {
            return false;
        }
        state.observer = Some(observer);
        true
    }

    #[must_use]
    pub fn sync_snapshot(&self) -> ActivitySnapshot {
        let state = self.lock_state();
        ActivitySnapshot {
            revision: state.revision,
            records: state.records.clone(),
        }
    }

    pub fn publish_notice(
        &self,
        project: Option<ActivityProjectContext>,
        report: ActivityNoticeReport,
    ) -> ActivityRecord {
        self.insert(
            project,
            ActivityPayload::Notice {
                message: ActivityMessage::from(report),
            },
        )
    }

    /// Starts one Runtime-owned Activity task.
    ///
    /// # Panics
    ///
    /// Panics when the message is not a task message or the initial progress is invalid.
    pub fn start_task(
        &self,
        project: Option<ActivityProjectContext>,
        message: ActivityMessage,
        progress: ActivityProgress,
    ) -> ActivityRecord {
        assert!(progress.is_valid(), "Activity progress must be valid");
        assert!(
            message.is_task(),
            "Activity task message must describe a task"
        );
        self.insert(
            project,
            ActivityPayload::Task {
                status: ActivityTaskStatus::Running,
                progress,
                message,
            },
        )
    }

    /// Creates or advances the Runtime projection of an externally owned task.
    ///
    /// # Errors
    ///
    /// Returns an error when progress is invalid or an existing record is not an active task.
    ///
    /// # Panics
    ///
    /// Panics when the message is not a task message.
    pub fn upsert_task(
        &self,
        id: String,
        project: Option<ActivityProjectContext>,
        message: ActivityMessage,
        status: ActivityTaskStatus,
        progress: ActivityProgress,
    ) -> Result<ActivityRecord, ActivityUpdateError> {
        if !progress.is_valid() {
            return Err(ActivityUpdateError::InvalidProgress);
        }
        assert!(
            message.is_task(),
            "Activity task message must describe a task"
        );
        let source = message.source();
        let (event, observer, record) = {
            let mut state = self.lock_state();
            let now = now_rfc3339();
            let record =
                if let Some(index) = state.records.iter().position(|record| record.id == id) {
                    let existing = &mut state.records[index];
                    let ActivityPayload::Task {
                        status: current_status,
                        progress: current_progress,
                        message: current_message,
                    } = &mut existing.payload
                    else {
                        return Err(ActivityUpdateError::NotActive);
                    };
                    if current_status.is_terminal() {
                        return Err(ActivityUpdateError::NotActive);
                    }
                    *current_status = status;
                    *current_progress = progress;
                    *current_message = message;
                    existing.project = project;
                    existing.source = source;
                    existing.updated_at = now;
                    existing.clone()
                } else {
                    let record = ActivityRecord {
                        id,
                        source,
                        project,
                        created_at: now.clone(),
                        updated_at: now,
                        payload: ActivityPayload::Task {
                            status,
                            progress,
                            message,
                        },
                    };
                    state.records.insert(0, record.clone());
                    record
                };
            let (event, observer) = next_event(
                &mut state,
                ActivityChange::Upsert {
                    record: record.clone(),
                },
            );
            (event, observer, record)
        };
        self.publish_ordered(observer, event);
        Ok(record)
    }

    /// Advances an Activity task that was started by this service.
    ///
    /// # Errors
    ///
    /// Returns an error when the record is missing, is not active, or progress is invalid.
    pub fn update_task(
        &self,
        id: &str,
        status: ActivityTaskStatus,
        progress: ActivityProgress,
    ) -> Result<ActivityRecord, ActivityUpdateError> {
        if !progress.is_valid() {
            return Err(ActivityUpdateError::InvalidProgress);
        }
        let (event, observer, record) = {
            let mut state = self.lock_state();
            let Some(index) = state.records.iter().position(|record| record.id == id) else {
                return Err(ActivityUpdateError::NotFound);
            };
            let now = now_rfc3339();
            {
                let record = &mut state.records[index];
                let ActivityPayload::Task {
                    status: current_status,
                    progress: current_progress,
                    ..
                } = &mut record.payload
                else {
                    return Err(ActivityUpdateError::NotActive);
                };
                if current_status.is_terminal() {
                    return Err(ActivityUpdateError::NotActive);
                }
                *current_status = status;
                *current_progress = progress;
                record.updated_at = now;
            }
            let record = state.records[index].clone();
            let (event, observer) = next_event(
                &mut state,
                ActivityChange::Upsert {
                    record: record.clone(),
                },
            );
            (event, observer, record)
        };
        self.publish_ordered(observer, event);
        Ok(record)
    }

    pub fn dismiss_terminal(&self, id: &str) -> bool {
        let published = {
            let mut state = self.lock_state();
            let Some(index) = state
                .records
                .iter()
                .position(|record| record.id == id && record.is_terminal())
            else {
                return false;
            };
            let removed = state.records.remove(index);
            next_event(
                &mut state,
                ActivityChange::Remove {
                    activity_ids: vec![removed.id],
                },
            )
        };
        self.publish_ordered(published.1, published.0);
        true
    }

    pub fn clear_terminal(&self) -> usize {
        let published = {
            let mut state = self.lock_state();
            let removed = state
                .records
                .iter()
                .filter(|record| record.is_terminal())
                .map(|record| record.id.clone())
                .collect::<Vec<_>>();
            if removed.is_empty() {
                return 0;
            }
            state.records.retain(ActivityRecord::is_active_task);
            let count = removed.len();
            let (event, observer) = next_event(
                &mut state,
                ActivityChange::Remove {
                    activity_ids: removed,
                },
            );
            (event, observer, count)
        };
        self.publish_ordered(published.1, published.0);
        published.2
    }

    fn insert(
        &self,
        project: Option<ActivityProjectContext>,
        payload: ActivityPayload,
    ) -> ActivityRecord {
        let source = match &payload {
            ActivityPayload::Notice { message } | ActivityPayload::Task { message, .. } => {
                message.source()
            }
        };
        let now = now_rfc3339();
        let record = ActivityRecord {
            id: Uuid::new_v4().to_string(),
            source,
            project,
            created_at: now.clone(),
            updated_at: now,
            payload,
        };
        let (event, observer) = {
            let mut state = self.lock_state();
            state.records.insert(0, record.clone());
            next_event(
                &mut state,
                ActivityChange::Upsert {
                    record: record.clone(),
                },
            )
        };
        self.publish_ordered(observer, event);
        record
    }

    fn publish_ordered(&self, observer: Option<ActivityObserver>, event: ActivityEvent) {
        let mut next_revision = self
            .next_published_revision
            .lock()
            .expect("Activity publication lock poisoned");
        assert!(
            event.revision >= *next_revision,
            "Activity event revision was already published"
        );
        while event.revision > *next_revision {
            next_revision = self
                .publish_changed
                .wait(next_revision)
                .expect("Activity publication lock poisoned");
        }
        if let Some(observer) = observer {
            observer(event);
        }
        *next_revision = next_revision
            .checked_add(1)
            .expect("Activity published revision exhausted");
        self.publish_changed.notify_all();
    }

    fn lock_state(&self) -> MutexGuard<'_, ActivityState> {
        self.state.lock().expect("Activity state lock poisoned")
    }
}

fn next_event(
    state: &mut ActivityState,
    change: ActivityChange,
) -> (ActivityEvent, Option<ActivityObserver>) {
    state.revision = state
        .revision
        .checked_add(1)
        .expect("Activity revision exhausted");
    (
        ActivityEvent {
            revision: state.revision,
            change,
        },
        state.observer.clone(),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex, mpsc},
        thread,
        time::Duration,
    };

    use super::{
        ActivityMessage, ActivityNoticeReport, ActivityProgress, ActivityProjectContext,
        ActivityService, ActivityTaskStatus, CanvasActivityOperation, ModelRequestKind,
    };

    fn project() -> ActivityProjectContext {
        ActivityProjectContext {
            canonical_root: "project-1".to_owned(),
            project_name: "Project One".to_owned(),
        }
    }

    #[test]
    fn runtime_activity_lifetime_updates_tasks_in_place_and_clears_only_terminal_records() {
        let service = ActivityService::new();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_events = Arc::clone(&observed);
        assert!(service.install_observer(Arc::new(move |event| {
            observed_events.lock().unwrap().push(event);
        })));

        let notice = service.publish_notice(
            Some(project()),
            ActivityNoticeReport::CanvasOperationFailed {
                operation: CanvasActivityOperation::SaveLayout,
            },
        );
        let task = service.start_task(
            Some(project()),
            ActivityMessage::ModelRequest {
                model_kind: ModelRequestKind::Video,
                item_count: 4,
            },
            ActivityProgress::Determinate {
                completed: 0,
                total: 4,
            },
        );
        service
            .update_task(
                &task.id,
                ActivityTaskStatus::Running,
                ActivityProgress::Determinate {
                    completed: 3,
                    total: 4,
                },
            )
            .unwrap();

        assert_eq!(service.clear_terminal(), 1);
        let active = service.sync_snapshot();
        assert_eq!(active.records.len(), 1);
        assert_eq!(active.records[0].id, task.id);
        assert!(active.records[0].is_active_task());

        service
            .update_task(
                &task.id,
                ActivityTaskStatus::Succeeded,
                ActivityProgress::Determinate {
                    completed: 4,
                    total: 4,
                },
            )
            .unwrap();
        assert!(service.dismiss_terminal(&task.id));
        assert!(service.sync_snapshot().records.is_empty());
        assert!(!service.dismiss_terminal(&notice.id));

        let events = observed.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.revision)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6]
        );
    }

    #[test]
    fn notice_reports_reject_arbitrary_frontend_fields() {
        assert!(
            serde_json::from_value::<ActivityNoticeReport>(serde_json::json!({
                "kind": "project-opened",
                "message": "raw frontend text"
            }))
            .is_err()
        );
    }

    #[test]
    fn concurrent_activity_publication_preserves_revision_order() {
        let service = Arc::new(ActivityService::new());
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&revisions);
        let (first_entered_sender, first_entered_receiver) = mpsc::channel();
        let (release_first_sender, release_first_receiver) = mpsc::channel();
        let release_first_receiver = Mutex::new(release_first_receiver);
        assert!(service.install_observer(Arc::new(move |event| {
            if event.revision == 1 {
                first_entered_sender.send(()).unwrap();
                release_first_receiver.lock().unwrap().recv().unwrap();
            }
            observed.lock().unwrap().push(event.revision);
        })));

        let first_service = Arc::clone(&service);
        let first = thread::spawn(move || {
            first_service.publish_notice(None, ActivityNoticeReport::UpdateInstallFailed {});
        });
        first_entered_receiver.recv().unwrap();

        let second_service = Arc::clone(&service);
        let (second_done_sender, second_done_receiver) = mpsc::channel();
        let second = thread::spawn(move || {
            second_service.publish_notice(None, ActivityNoticeReport::UpdateInstallFailed {});
            second_done_sender.send(()).unwrap();
        });
        assert!(
            second_done_receiver
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        release_first_sender.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();

        assert_eq!(*revisions.lock().unwrap(), vec![1, 2]);
    }
}
