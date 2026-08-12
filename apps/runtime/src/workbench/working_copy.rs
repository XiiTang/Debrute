use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::global::root_state_directory;
use crate::project::{
    CanvasFeedbackGeometry, CanvasFeedbackItemKind, CanvasFeedbackScope, ProjectError,
    ProjectPathChangeSet, ProjectPathStateReconciler, ProjectRelativePath, normalized_geometry,
    project_path_is_same_or_descendant, replace_file, rewrite_project_path,
    validate_spatial_geometry,
};

use super::RuntimeHttpServiceError;

const MAX_FEEDBACK_WORKING_COPY_ITEM_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWorkingCopies {
    pub canonical_root: String,
    pub text: BTreeMap<String, TextWorkingCopy>,
    pub feedback: BTreeMap<String, FeedbackWorkingCopy>,
}

impl ProjectWorkingCopies {
    fn empty(canonical_root: &str) -> Self {
        Self {
            canonical_root: canonical_root.to_owned(),
            text: BTreeMap::new(),
            feedback: BTreeMap::new(),
        }
    }
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
    debrute_home: PathBuf,
    io: Mutex<()>,
}

impl WorkingCopyStore {
    pub fn new(debrute_home: &Path) -> Self {
        Self {
            debrute_home: debrute_home.to_path_buf(),
            io: Mutex::new(()),
        }
    }

    pub fn load(
        &self,
        canonical_root: &str,
    ) -> Result<ProjectWorkingCopies, RuntimeHttpServiceError> {
        let _io = self.lock();
        self.read(canonical_root)
    }

    pub fn put_text(
        &self,
        canonical_root: &str,
        mut working_copy: TextWorkingCopy,
    ) -> Result<TextWorkingCopy, RuntimeHttpServiceError> {
        working_copy.project_relative_path =
            ProjectRelativePath::parse(&working_copy.project_relative_path)
                .map_err(RuntimeHttpServiceError::from_project)?
                .into_string();
        if working_copy.language.is_empty() || working_copy.base_revision.is_empty() {
            return Err(invalid(
                "Text Working Copy requires language and baseRevision.",
            ));
        }
        let _io = self.lock();
        let mut project = self.read(canonical_root)?;
        project.text.insert(
            working_copy.project_relative_path.clone(),
            working_copy.clone(),
        );
        self.write(canonical_root, &project)?;
        Ok(working_copy)
    }

    pub fn clear_text(
        &self,
        canonical_root: &str,
        project_relative_path: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        let project_relative_path = ProjectRelativePath::parse(project_relative_path)
            .map_err(RuntimeHttpServiceError::from_project)?;
        let _io = self.lock();
        let mut project = self.read(canonical_root)?;
        project.text.remove(project_relative_path.as_str());
        self.write_or_remove(canonical_root, &project)
    }

    pub fn put_feedback(
        &self,
        canonical_root: &str,
        mut working_copy: FeedbackWorkingCopy,
    ) -> Result<FeedbackWorkingCopy, RuntimeHttpServiceError> {
        working_copy.project_relative_path =
            ProjectRelativePath::parse(&working_copy.project_relative_path)
                .map_err(RuntimeHttpServiceError::from_project)?
                .into_string();
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
        if working_copy.scope == CanvasFeedbackScope::Node
            && working_copy.moment_time_seconds.is_some()
        {
            return Err(invalid(
                "Node Feedback Working Copy cannot include momentTimeSeconds.",
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
        let mut project = self.read(canonical_root)?;
        project
            .feedback
            .insert(working_copy.item_id.clone(), working_copy.clone());
        self.write(canonical_root, &project)?;
        Ok(working_copy)
    }

    pub fn clear_feedback(
        &self,
        canonical_root: &str,
        item_id: &str,
    ) -> Result<(), RuntimeHttpServiceError> {
        let _io = self.lock();
        let mut project = self.read(canonical_root)?;
        project.feedback.remove(item_id);
        self.write_or_remove(canonical_root, &project)
    }

    fn read(&self, canonical_root: &str) -> Result<ProjectWorkingCopies, RuntimeHttpServiceError> {
        match fs::read(self.path(canonical_root)) {
            Ok(bytes) => {
                let state: ProjectWorkingCopies =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        RuntimeHttpServiceError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "working_copy_invalid",
                            format!("Runtime Working Copy is invalid: {error}"),
                        )
                    })?;
                if state.canonical_root != canonical_root {
                    return Err(RuntimeHttpServiceError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "working_copy_root_mismatch",
                        "Runtime Working Copy canonicalRoot does not match its root-state bucket.",
                    ));
                }
                Ok(state)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(ProjectWorkingCopies::empty(canonical_root))
            }
            Err(error) => Err(persistence(&error)),
        }
    }

    fn write_or_remove(
        &self,
        canonical_root: &str,
        project: &ProjectWorkingCopies,
    ) -> Result<(), RuntimeHttpServiceError> {
        if project.text.is_empty() && project.feedback.is_empty() {
            match fs::remove_file(self.path(canonical_root)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(persistence(&error)),
            }
        } else {
            self.write(canonical_root, project)
        }
    }

    fn write(
        &self,
        canonical_root: &str,
        project: &ProjectWorkingCopies,
    ) -> Result<(), RuntimeHttpServiceError> {
        let path = self.path(canonical_root);
        let directory = path.parent().expect("Working Copy path has a parent");
        fs::create_dir_all(directory).map_err(|error| persistence(&error))?;
        let temporary = directory.join(format!(".working-copies.{}.tmp", Uuid::new_v4()));
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

    fn path(&self, canonical_root: &str) -> PathBuf {
        root_state_directory(&self.debrute_home, canonical_root).join("working-copies.json")
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.io.lock().expect("Working Copy I/O lock poisoned")
    }
}

impl ProjectPathStateReconciler for WorkingCopyStore {
    fn reconcile(
        &self,
        canonical_root: &str,
        changes: &ProjectPathChangeSet,
    ) -> Result<(), ProjectError> {
        self.reconcile_paths(
            canonical_root,
            changes.invalidated_paths(),
            changes.rewrites(),
        )
    }

    fn prune(&self, canonical_root: &str, removed: &[String]) -> Result<(), ProjectError> {
        self.reconcile_paths(canonical_root, removed, &[])
    }
}

impl WorkingCopyStore {
    fn reconcile_paths(
        &self,
        canonical_root: &str,
        removed: &[String],
        rewrites: &[(String, String)],
    ) -> Result<(), ProjectError> {
        if removed.is_empty() && rewrites.is_empty() {
            return Ok(());
        }
        let _io = self.lock();
        let mut copies = self
            .read(canonical_root)
            .map_err(working_copy_project_error)?;
        copies.text = reconcile_map(copies.text, removed, rewrites, |copy, path| {
            copy.project_relative_path = path;
        });
        copies.feedback = reconcile_feedback_map(copies.feedback, removed, rewrites);
        self.write_or_remove(canonical_root, &copies)
            .map_err(working_copy_project_error)
    }
}

fn reconcile_map<T>(
    source: BTreeMap<String, T>,
    removed: &[String],
    rewrites: &[(String, String)],
    mut set_path: impl FnMut(&mut T, String),
) -> BTreeMap<String, T> {
    let mut unchanged = BTreeMap::new();
    let mut rewritten = Vec::new();
    for (path, mut value) in source {
        if let Some(next) = rewrites
            .iter()
            .map(|(from, to)| rewrite_project_path(&path, from, to))
            .find(|next| next != &path)
        {
            set_path(&mut value, next.clone());
            rewritten.push((next, value));
        } else if !removed
            .iter()
            .any(|root| project_path_is_same_or_descendant(&path, root))
        {
            unchanged.insert(path, value);
        }
    }
    for (path, value) in rewritten {
        unchanged.insert(path, value);
    }
    unchanged
}

fn reconcile_feedback_map(
    source: BTreeMap<String, FeedbackWorkingCopy>,
    removed: &[String],
    rewrites: &[(String, String)],
) -> BTreeMap<String, FeedbackWorkingCopy> {
    source
        .into_iter()
        .filter_map(|(item_id, mut copy)| {
            if let Some(next) = rewrites
                .iter()
                .map(|(from, to)| rewrite_project_path(&copy.project_relative_path, from, to))
                .find(|next| next != &copy.project_relative_path)
            {
                copy.project_relative_path = next;
                return Some((item_id, copy));
            }
            (!removed
                .iter()
                .any(|root| project_path_is_same_or_descendant(&copy.project_relative_path, root)))
            .then_some((item_id, copy))
        })
        .collect()
}

fn working_copy_project_error(error: RuntimeHttpServiceError) -> ProjectError {
    ProjectError::service(error.code, error.message)
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
    fn working_copies_persist_in_the_canonical_root_bucket() {
        let home = std::env::temp_dir().join(format!("dbrt-working-copy-{}", Uuid::new_v4()));
        let store = WorkingCopyStore::new(&home);
        let text = TextWorkingCopy {
            project_relative_path: "notes/draft.md".to_owned(),
            content: "draft".to_owned(),
            language: "markdown".to_owned(),
            base_revision: "revision-1".to_owned(),
        };
        let root = "/projects/campaign";
        assert_eq!(store.put_text(root, text.clone()).unwrap(), text);
        assert_eq!(
            WorkingCopyStore::new(&home).load(root).unwrap().text["notes/draft.md"],
            text
        );
        store.clear_text(root, "notes/draft.md").unwrap();
        assert_eq!(store.load(root).unwrap(), ProjectWorkingCopies::empty(root));
        assert!(
            !root_state_directory(&home, root)
                .join("working-copies.json")
                .exists()
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn canonical_root_is_hashed_before_it_reaches_the_private_directory_name() {
        let home = std::env::temp_dir().join(format!("dbrt-working-copy-{}", Uuid::new_v4()));
        let store = WorkingCopyStore::new(&home);
        store
            .put_text(
                "/projects/../literal-root",
                TextWorkingCopy {
                    project_relative_path: "draft.txt".to_owned(),
                    content: "draft".to_owned(),
                    language: "plaintext".to_owned(),
                    base_revision: "revision-1".to_owned(),
                },
            )
            .unwrap();
        assert!(!home.join("state/literal-root/working-copies.json").exists());
        assert_eq!(fs::read_dir(home.join("state/roots")).unwrap().count(), 1);
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
            scope: CanvasFeedbackScope::Node,
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
            ProjectWorkingCopies::empty("project-1")
        );
        if home.exists() {
            fs::remove_dir_all(home).unwrap();
        }
    }
}
