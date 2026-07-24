use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::project::{CanvasFeedbackGeometry, normalize_project_relative_path, replace_file};

use super::RuntimeHttpServiceError;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkingCopies {
    pub text: BTreeMap<String, TextWorkingCopy>,
    pub feedback: Option<FeedbackWorkingCopy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextWorkingCopy {
    pub project_relative_path: String,
    pub content: String,
    pub language: String,
    pub base_revision: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackWorkingCopy {
    pub pending_item: FeedbackWorkingCopyItem,
    pub pending_comment: String,
    pub local_mode: Option<FeedbackLocalMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackWorkingCopyItem {
    pub project_relative_path: String,
    pub kind: FeedbackDraftKind,
    pub scope: FeedbackDraftScope,
    pub moment_time_seconds: Option<f64>,
    pub geometry: Option<CanvasFeedbackGeometry>,
    pub label: Option<FeedbackDraftLabel>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackDraftKind {
    Comment,
    Pin,
    Region,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackDraftScope {
    File,
    Moment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FeedbackDraftLabel {
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackLocalMode {
    Pin,
    Rect,
}

pub struct WorkingCopyStore {
    directory: PathBuf,
    io: Mutex<()>,
}

impl WorkingCopyStore {
    pub fn new(debrute_home: &Path) -> Self {
        Self {
            directory: debrute_home.join("state/working-copies"),
            io: Mutex::new(()),
        }
    }

    pub fn load(&self, project_id: &str) -> Result<ProjectWorkingCopies, RuntimeHttpServiceError> {
        let _io = self.lock();
        self.read(project_id)
    }

    pub fn put_text(
        &self,
        project_id: &str,
        mut working_copy: TextWorkingCopy,
    ) -> Result<TextWorkingCopy, RuntimeHttpServiceError> {
        working_copy.project_relative_path =
            normalize_project_relative_path(&working_copy.project_relative_path)
                .map_err(RuntimeHttpServiceError::from_project)?;
        if working_copy.language.is_empty() || working_copy.base_revision.is_empty() {
            return Err(invalid(
                "Text Working Copy requires language and baseRevision.",
            ));
        }
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project.text.insert(
            working_copy.project_relative_path.clone(),
            working_copy.clone(),
        );
        self.write(project_id, &project)?;
        Ok(working_copy)
    }

    pub fn clear_text(
        &self,
        project_id: &str,
        project_relative_path: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        let project_relative_path = normalize_project_relative_path(project_relative_path)
            .map_err(RuntimeHttpServiceError::from_project)?;
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project.text.remove(&project_relative_path);
        self.write_or_remove(project_id, &project)
    }

    pub fn put_feedback(
        &self,
        project_id: &str,
        mut working_copy: FeedbackWorkingCopy,
    ) -> Result<FeedbackWorkingCopy, RuntimeHttpServiceError> {
        working_copy.pending_item.project_relative_path =
            normalize_project_relative_path(&working_copy.pending_item.project_relative_path)
                .map_err(RuntimeHttpServiceError::from_project)?;
        let item = &working_copy.pending_item;
        if item.scope == FeedbackDraftScope::Moment && item.moment_time_seconds.is_none() {
            return Err(invalid(
                "Moment Feedback Working Copy requires momentTimeSeconds.",
            ));
        }
        if matches!(
            item.kind,
            FeedbackDraftKind::Pin | FeedbackDraftKind::Region
        ) && item.geometry.is_none()
        {
            return Err(invalid("Spatial Feedback Working Copy requires geometry."));
        }
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project.feedback = Some(working_copy.clone());
        self.write(project_id, &project)?;
        Ok(working_copy)
    }

    pub fn clear_feedback(&self, project_id: &str) -> Result<(), RuntimeHttpServiceError> {
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project.feedback = None;
        self.write_or_remove(project_id, &project)
    }

    fn read(&self, project_id: &str) -> Result<ProjectWorkingCopies, RuntimeHttpServiceError> {
        match fs::read(self.path(project_id)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                RuntimeHttpServiceError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "working_copy_invalid",
                    format!("Runtime Working Copy is invalid: {error}"),
                )
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(ProjectWorkingCopies::default())
            }
            Err(error) => Err(persistence(&error)),
        }
    }

    fn write_or_remove(
        &self,
        project_id: &str,
        project: &ProjectWorkingCopies,
    ) -> Result<(), RuntimeHttpServiceError> {
        if project.text.is_empty() && project.feedback.is_none() {
            match fs::remove_file(self.path(project_id)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(persistence(&error)),
            }
        } else {
            self.write(project_id, project)
        }
    }

    fn write(
        &self,
        project_id: &str,
        project: &ProjectWorkingCopies,
    ) -> Result<(), RuntimeHttpServiceError> {
        fs::create_dir_all(&self.directory).map_err(|error| persistence(&error))?;
        let path = self.path(project_id);
        let temporary = self.directory.join(format!(".{}.tmp", Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(project).map_err(|error| {
            RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "working_copy_serialization_failed",
                error.to_string(),
            )
        })?;
        fs::write(&temporary, bytes).map_err(|error| persistence(&error))?;
        if let Err(error) = replace_file(&temporary, &path) {
            let _ = fs::remove_file(&temporary);
            return Err(persistence(&error));
        }
        Ok(())
    }

    fn path(&self, project_id: &str) -> PathBuf {
        let digest = Sha256::digest(project_id.as_bytes());
        self.directory.join(format!("{digest:x}.json"))
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.io.lock().expect("Working Copy I/O lock poisoned")
    }
}

fn invalid(message: &'static str) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(StatusCode::BAD_REQUEST, "working_copy_invalid", message)
}

fn persistence(error: &io::Error) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "working_copy_persistence_failed",
        error.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_copies_persist_by_stable_project_id_and_clear_without_retention() {
        let home = std::env::temp_dir().join(format!("dbrt-working-copy-{}", Uuid::new_v4()));
        let store = WorkingCopyStore::new(&home);
        let text = TextWorkingCopy {
            project_relative_path: "notes/draft.md".to_owned(),
            content: "draft".to_owned(),
            language: "markdown".to_owned(),
            base_revision: "revision-1".to_owned(),
        };
        assert_eq!(store.put_text("project-1", text.clone()).unwrap(), text);
        assert_eq!(
            WorkingCopyStore::new(&home).load("project-1").unwrap().text["notes/draft.md"],
            text
        );
        store.clear_text("project-1", "notes/draft.md").unwrap();
        assert_eq!(
            store.load("project-1").unwrap(),
            ProjectWorkingCopies::default()
        );
        assert!(
            fs::read_dir(home.join("state/working-copies"))
                .unwrap()
                .next()
                .is_none()
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn project_id_is_hashed_before_it_reaches_the_private_file_name() {
        let home = std::env::temp_dir().join(format!("dbrt-working-copy-{}", Uuid::new_v4()));
        let store = WorkingCopyStore::new(&home);
        store
            .put_text(
                "../not-a-path",
                TextWorkingCopy {
                    project_relative_path: "draft.txt".to_owned(),
                    content: "draft".to_owned(),
                    language: "plaintext".to_owned(),
                    base_revision: "revision-1".to_owned(),
                },
            )
            .unwrap();
        assert!(!home.join("state/not-a-path.json").exists());
        assert_eq!(
            fs::read_dir(home.join("state/working-copies"))
                .unwrap()
                .count(),
            1
        );
        fs::remove_dir_all(home).unwrap();
    }
}
