use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::project::{
    CanvasFeedbackGeometry, CanvasFeedbackItemKind, CanvasFeedbackScope,
    normalize_project_relative_path, normalized_geometry, replace_file, validate_spatial_geometry,
};

use super::RuntimeHttpServiceError;

const MAX_FEEDBACK_WORKING_COPY_ITEM_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkingCopies {
    pub text: BTreeMap<String, TextWorkingCopy>,
    pub feedback: BTreeMap<String, FeedbackWorkingCopy>,
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
    pub item_id: String,
    pub created_at: String,
    pub project_relative_path: String,
    pub kind: CanvasFeedbackItemKind,
    pub scope: CanvasFeedbackScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moment_time_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<CanvasFeedbackGeometry>,
    pub comment: String,
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
        working_copy.project_relative_path =
            normalize_project_relative_path(&working_copy.project_relative_path)
                .map_err(RuntimeHttpServiceError::from_project)?;
        if working_copy.item_id.is_empty()
            || working_copy.item_id != working_copy.item_id.trim()
            || working_copy.item_id.len() > MAX_FEEDBACK_WORKING_COPY_ITEM_ID_BYTES
        {
            return Err(invalid(
                "Feedback Working Copy itemId must be non-empty, trimmed, and within the byte limit.",
            ));
        }
        if OffsetDateTime::parse(&working_copy.created_at, &Rfc3339).is_err() {
            return Err(invalid(
                "Feedback Working Copy createdAt must be an RFC 3339 timestamp.",
            ));
        }
        if working_copy
            .moment_time_seconds
            .is_some_and(|seconds| !seconds.is_finite() || seconds < 0.0)
        {
            return Err(invalid(
                "Feedback Working Copy momentTimeSeconds must be finite and non-negative.",
            ));
        }
        if working_copy.scope == CanvasFeedbackScope::Moment
            && working_copy.moment_time_seconds.is_none()
        {
            return Err(invalid(
                "Moment Feedback Working Copy requires momentTimeSeconds.",
            ));
        }
        if working_copy.scope == CanvasFeedbackScope::File
            && working_copy.moment_time_seconds.is_some()
        {
            return Err(invalid(
                "File Feedback Working Copy cannot include momentTimeSeconds.",
            ));
        }
        if matches!(
            working_copy.kind,
            CanvasFeedbackItemKind::Pin | CanvasFeedbackItemKind::Region
        ) && working_copy.geometry.is_none()
        {
            return Err(invalid("Spatial Feedback Working Copy requires geometry."));
        }
        if working_copy.kind == CanvasFeedbackItemKind::Comment && working_copy.geometry.is_some() {
            return Err(invalid(
                "Comment Feedback Working Copy cannot include geometry.",
            ));
        }
        if let Some(geometry) = &working_copy.geometry {
            let normalized =
                normalized_geometry(geometry).map_err(RuntimeHttpServiceError::from_project)?;
            validate_spatial_geometry(working_copy.kind, &normalized)
                .map_err(RuntimeHttpServiceError::from_project)?;
            working_copy.geometry = Some(normalized);
        }
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project
            .feedback
            .insert(working_copy.item_id.clone(), working_copy.clone());
        self.write(project_id, &project)?;
        Ok(working_copy)
    }

    pub fn clear_feedback(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        let _io = self.lock();
        let mut project = self.read(project_id)?;
        project.feedback.remove(item_id);
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
        if project.text.is_empty() && project.feedback.is_empty() {
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

    #[test]
    fn feedback_working_copy_rejects_geometry_that_cannot_become_the_same_item_kind() {
        let home = std::env::temp_dir().join(format!("dbrt-working-copy-{}", Uuid::new_v4()));
        let store = WorkingCopyStore::new(&home);
        let invalid_pin = FeedbackWorkingCopy {
            item_id: "feedback-a".to_owned(),
            created_at: "2026-07-23T00:00:00.000Z".to_owned(),
            project_relative_path: "image.png".to_owned(),
            kind: CanvasFeedbackItemKind::Pin,
            scope: CanvasFeedbackScope::File,
            moment_time_seconds: None,
            geometry: Some(CanvasFeedbackGeometry::Rect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.4,
            }),
            comment: "Pin".to_owned(),
        };

        assert!(store.put_feedback("project-1", invalid_pin).is_err());
        assert_eq!(
            store.load("project-1").unwrap(),
            ProjectWorkingCopies::default()
        );
        if home.exists() {
            fs::remove_dir_all(home).unwrap();
        }
    }
}
