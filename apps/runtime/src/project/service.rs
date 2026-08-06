//! `ProjectTree`, Feedback, and global Canvas workspace composition.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    CanvasFeedbackDiagnosticUpdate, CanvasFeedbackDocument, CanvasImageDimensions, CanvasMediaKind,
    CanvasNodeAvailability, CanvasResource, CanvasResourceView, CanvasState, CanvasStatePatch,
    CanvasVideoPresentation, CanvasWorkspaceDocument, CanvasWorkspaceSnapshot,
    CanvasWorkspaceStore, CanvasWorkspaceUnavailable, ProjectCapabilityFs, ProjectDiagnostic,
    ProjectDiagnosticCounts, ProjectDiagnosticSeverity, ProjectError, ProjectHealthSummary,
    ProjectPathKind, ProjectSnapshot, ProjectTree, ProjectTreeChange, ProjectTreeEntry,
    UpdateCanvasFeedbackInput, apply_canvas_state_patch, canvas_media_kind_from_path,
    normalize_feedback_path, open_no_symlink_existing_project_file, project_content_hash,
    project_media_revision, project_text_file_type_for_path, prune_canvas_state_path,
    read_canvas_feedback_state, resolve_no_symlink_existing_project_path,
    rewrite_canvas_state_path, update_canvas_feedback_document, visible_canvas_entries,
    write_canvas_feedback_document,
};

type CanvasNodeAdapterData = (
    Option<CanvasImagePreviewInfo>,
    Option<CanvasVideoPresentation>,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasImagePreviewInfo {
    pub previewable: bool,
    pub dimensions: Option<CanvasImageDimensions>,
}

#[derive(Clone)]
struct CachedCanvasFileInspection {
    identity: debrute_native_fs::PathIdentity,
    size: u64,
    modified: SystemTime,
    resource: CanvasResource,
}

#[derive(Clone)]
pub(crate) struct SnapshotLoadCheckpoint {
    snapshot: ProjectSnapshot,
    canvas_workspace: Result<CanvasWorkspaceDocument, CanvasWorkspaceUnavailable>,
    feedback_document: CanvasFeedbackDocument,
    feedback_hash: Option<String>,
    path_state_diagnostic: Option<ProjectDiagnostic>,
    project_tree: ProjectTree,
    inspection_cache: HashMap<String, CachedCanvasFileInspection>,
}

pub trait ProjectNodeAdapter: Send + Sync {
    /// # Errors
    ///
    /// Returns an error when video metadata cannot be inspected.
    fn video_presentation(
        &self,
        _project_root: &Path,
        _project_relative_path: &str,
    ) -> Result<Option<CanvasVideoPresentation>, ProjectError> {
        Ok(None)
    }

    /// # Errors
    ///
    /// Returns an error when image metadata cannot be inspected.
    fn image_preview_info(
        &self,
        _project_root: &Path,
        _project_relative_path: &str,
    ) -> Result<Option<CanvasImagePreviewInfo>, ProjectError> {
        Ok(None)
    }
}

pub struct DefaultProjectNodeAdapter;

pub(crate) struct CanvasFeedbackUpdate {
    pub feedback: CanvasFeedbackDocument,
    pub changed: bool,
}

pub(crate) struct WatchedProjectRefresh {
    pub snapshot: ProjectSnapshot,
    pub path_state_invalidated: Vec<String>,
    pub path_state_persistence_errors: Vec<String>,
    pub refresh_error: Option<ProjectError>,
}

impl ProjectNodeAdapter for DefaultProjectNodeAdapter {}

pub struct ProjectService {
    root: PathBuf,
    canonical_root: String,
    capability: ProjectCapabilityFs,
    debrute_home: PathBuf,
    node_adapter: Arc<dyn ProjectNodeAdapter>,
    canvas_store: CanvasWorkspaceStore,
    canvas_workspace: Result<CanvasWorkspaceDocument, CanvasWorkspaceUnavailable>,
    snapshot: ProjectSnapshot,
    feedback_document: CanvasFeedbackDocument,
    feedback_hash: Option<String>,
    feedback_render_diagnostics: HashMap<String, ProjectDiagnostic>,
    path_state_diagnostic: Option<ProjectDiagnostic>,
    project_tree: ProjectTree,
    inspection_cache: HashMap<String, CachedCanvasFileInspection>,
}

impl ProjectService {
    #[cfg(test)]
    pub fn open(
        project_root: impl AsRef<Path>,
        debrute_home: impl AsRef<Path>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
    ) -> Result<Self, ProjectError> {
        let mut service = Self::prepare_unloaded(project_root, debrute_home, node_adapter)?;
        service.refresh_loaded_snapshot()?;
        Ok(service)
    }

    pub(crate) fn prepare_unloaded(
        project_root: impl AsRef<Path>,
        debrute_home: impl AsRef<Path>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
    ) -> Result<Self, ProjectError> {
        let requested = project_root.as_ref();
        let root = requested.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::ProjectNotFound(requested.to_string_lossy().into_owned())
            } else {
                ProjectError::from(error)
            }
        })?;
        if !root.is_dir() {
            return Err(ProjectError::service(
                "path_not_directory",
                format!("Project root is not a directory: {}", root.display()),
            ));
        }
        let canonical_root = root
            .to_str()
            .ok_or_else(|| {
                ProjectError::service(
                    "project_path_not_utf8",
                    "Project root must be representable as UTF-8.",
                )
            })?
            .to_owned();
        let capability = ProjectCapabilityFs::bind_session_root(&root)?;
        let debrute_home = debrute_home.as_ref().to_path_buf();
        let canvas_store = CanvasWorkspaceStore::new(&debrute_home, &canonical_root);
        let canvas_workspace = canvas_store.load_or_create();
        let feedback_document = CanvasFeedbackDocument::empty(crate::now_rfc3339())?;
        let project_tree = ProjectTree::new(root.clone());
        let canvas_workspace_snapshot = match &canvas_workspace {
            Ok(workspace) => CanvasWorkspaceSnapshot::Available {
                workspace: workspace.clone(),
                canvas_resources: CanvasResourceView {
                    resources: Vec::new(),
                    diagnostics: Vec::new(),
                },
            },
            Err(unavailable) => CanvasWorkspaceSnapshot::Unavailable {
                code: unavailable.code,
                message: unavailable.message.clone(),
            },
        };
        let snapshot = ProjectSnapshot {
            canonical_root: canonical_root.clone(),
            project_tree: Vec::new(),
            canvas_workspace: canvas_workspace_snapshot,
            diagnostics: Vec::new(),
            health: ProjectHealthSummary {
                project_name: project_name(&root),
                diagnostic_counts: ProjectDiagnosticCounts {
                    errors: 0,
                    warnings: 0,
                },
                runtime_data_location: debrute_home.join("runtime").to_string_lossy().into_owned(),
                checked_at: crate::now_rfc3339(),
            },
        };
        Ok(Self {
            root,
            canonical_root,
            capability,
            debrute_home,
            node_adapter,
            canvas_store,
            canvas_workspace,
            snapshot,
            feedback_document,
            feedback_hash: None,
            feedback_render_diagnostics: HashMap::new(),
            path_state_diagnostic: None,
            project_tree,
            inspection_cache: HashMap::new(),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub(crate) fn is_loaded_watch_path(&self, project_relative_path: &str) -> bool {
        project_relative_path == super::CANVAS_FEEDBACK_PROJECT_PATH
            || self
                .project_tree
                .is_loaded_dependency(project_relative_path)
    }

    pub(crate) fn watch_paths_match_current_documents(
        &self,
        paths: &[super::watcher::ProjectWatchPath],
    ) -> bool {
        paths.len() == 1
            && paths[0].project_relative_path == super::CANVAS_FEEDBACK_PROJECT_PATH
            && self.feedback_hash.as_ref().is_some_and(|expected| {
                fs::read(self.root.join(super::CANVAS_FEEDBACK_PROJECT_PATH))
                    .is_ok_and(|content| project_content_hash(content) == *expected)
            })
    }

    #[must_use]
    pub fn snapshot(&self) -> &ProjectSnapshot {
        &self.snapshot
    }

    pub(crate) fn release_capability_binding(&self) {
        self.capability.unbind_session_root(&self.root);
    }

    pub(crate) fn canvas_feedback(&self) -> &CanvasFeedbackDocument {
        &self.feedback_document
    }

    pub(crate) fn apply_canvas_feedback_diagnostics(
        &mut self,
        update: &CanvasFeedbackDiagnosticUpdate,
    ) -> Result<Option<ProjectSnapshot>, ProjectError> {
        const PREFIX: &str = "canvas-feedback.render_failed:";
        let previous_diagnostics = self.feedback_render_diagnostics.clone();
        for resolved in &update.resolved_diagnostic_ids {
            self.feedback_render_diagnostics.remove(resolved);
        }
        if update.checked_all_entries {
            let retained = update
                .retained_project_relative_paths
                .iter()
                .collect::<HashSet<_>>();
            self.feedback_render_diagnostics.retain(|_, diagnostic| {
                diagnostic
                    .entity_id
                    .as_ref()
                    .is_none_or(|entity| retained.contains(entity))
            });
        }
        for checked in &update.checked_project_relative_paths {
            self.feedback_render_diagnostics.retain(|id, _| {
                let Some(path) = id.strip_prefix(PREFIX) else {
                    return true;
                };
                path != checked && !path.starts_with(&format!("{checked}#"))
            });
        }
        for diagnostic in &update.diagnostics {
            self.feedback_render_diagnostics
                .insert(diagnostic.id.clone(), diagnostic.clone());
        }
        if self.feedback_render_diagnostics == previous_diagnostics {
            return Ok(None);
        }
        self.rebuild_snapshot(&HashSet::new(), false)?;
        Ok(Some(self.snapshot.clone()))
    }

    pub(crate) fn preserve_public_snapshot(&mut self, snapshot: ProjectSnapshot) {
        self.snapshot = snapshot;
    }

    pub fn refresh(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        self.refresh_loaded_snapshot()
    }

    pub(crate) fn refresh_loaded_snapshot(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        let checkpoint = self.snapshot_load_checkpoint();
        let result = (|| {
            let change = self.project_tree.reload_loaded()?;
            let mut invalidated = self.apply_project_tree_change(&change)?;
            invalidated.extend(self.load_canvas_directories()?);
            self.rebuild_snapshot(&invalidated, true)
        })();
        if result.is_err() {
            self.restore_snapshot_load_checkpoint(checkpoint);
        }
        result
    }

    pub(crate) fn refresh_loaded_snapshot_for_watcher(
        &mut self,
    ) -> Result<WatchedProjectRefresh, ProjectError> {
        let change = self.project_tree.reload_loaded()?;
        let (mut invalidated, mut persistence_errors) =
            self.apply_watched_project_tree_change(&change);
        let mut refresh_error = None;
        match self.load_canvas_directories_for_watcher() {
            Ok((active_invalidated, active_errors)) => {
                invalidated.extend(active_invalidated);
                persistence_errors.extend(active_errors);
            }
            Err(error) => refresh_error = Some(error),
        }
        if refresh_error.is_none()
            && let Err(error) = self.refresh_canvas_feedback_from_disk()
        {
            refresh_error = Some(error);
        }
        let snapshot = self
            .rebuild_snapshot(&invalidated, false)
            .expect("accepted Canvas Workspace remains valid while rebuilding a watcher snapshot");
        Ok(WatchedProjectRefresh {
            snapshot,
            path_state_invalidated: invalidated.into_iter().collect(),
            path_state_persistence_errors: persistence_errors,
            refresh_error,
        })
    }

    pub(crate) fn refresh_watched_paths(
        &mut self,
        paths: &[super::watcher::ProjectWatchPath],
    ) -> Result<WatchedProjectRefresh, ProjectError> {
        let change = self.project_tree.refresh_watched_paths(paths)?;
        let (path_state_invalidated, persistence_errors) =
            self.apply_watched_project_tree_change(&change);
        let invalidated = paths
            .iter()
            .map(|path| path.project_relative_path.clone())
            .chain(path_state_invalidated.iter().cloned())
            .collect::<HashSet<_>>();
        let refresh_error = if paths
            .iter()
            .any(|path| path.project_relative_path == super::CANVAS_FEEDBACK_PROJECT_PATH)
        {
            self.refresh_canvas_feedback_from_disk().err()
        } else {
            None
        };
        let snapshot = self
            .rebuild_snapshot(&invalidated, false)
            .expect("accepted Canvas Workspace remains valid while rebuilding a watcher snapshot");
        Ok(WatchedProjectRefresh {
            snapshot,
            path_state_invalidated: path_state_invalidated.into_iter().collect(),
            path_state_persistence_errors: persistence_errors,
            refresh_error,
        })
    }

    pub(crate) fn load_project_directory(
        &mut self,
        project_relative_directory: &str,
    ) -> Result<ProjectSnapshot, ProjectError> {
        self.load_project_directories(&[project_relative_directory.to_owned()])?;
        Ok(self.snapshot.clone())
    }

    fn load_project_directories(&mut self, directories: &[String]) -> Result<(), ProjectError> {
        let checkpoint = self.snapshot_load_checkpoint();
        let result = (|| {
            let change = self.project_tree.load_directories(directories)?;
            let invalidated = self.apply_project_tree_change(&change)?;
            self.rebuild_snapshot(&invalidated, true)?;
            Ok(())
        })();
        if result.is_err() {
            self.restore_snapshot_load_checkpoint(checkpoint);
        }
        result
    }

    pub(crate) fn validate_complete_snapshot(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        let checkpoint = self.snapshot_load_checkpoint();
        let result = (|| {
            let mut invalidated = HashSet::new();
            let mut pending = self
                .project_tree
                .ordered_entries()
                .into_iter()
                .filter(|entry| entry.kind == ProjectPathKind::Directory)
                .map(|entry| entry.project_relative_path)
                .collect::<Vec<_>>();
            while !pending.is_empty() {
                let change = self.project_tree.load_directories(&pending)?;
                invalidated.extend(self.apply_project_tree_change(&change)?);
                pending = self
                    .project_tree
                    .ordered_entries()
                    .into_iter()
                    .filter(|entry| {
                        entry.kind == ProjectPathKind::Directory
                            && entry.directory_state == Some(super::ProjectDirectoryState::Unloaded)
                    })
                    .map(|entry| entry.project_relative_path)
                    .collect();
            }
            self.rebuild_snapshot(&invalidated, true)
        })();
        self.restore_snapshot_load_checkpoint(checkpoint);
        result
    }

    pub fn update_canvas_feedback(
        &mut self,
        input: &UpdateCanvasFeedbackInput,
    ) -> Result<CanvasFeedbackUpdate, ProjectError> {
        for path in input.target_project_relative_paths() {
            let normalized = normalize_feedback_path(path)?;
            let target = resolve_no_symlink_existing_project_path(&self.root, &normalized)
                .map_err(|_| {
                    ProjectError::Validation(format!(
                        "Canvas feedback target is not a current Project Path: {normalized}"
                    ))
                })?;
            let metadata = target.metadata()?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback target is not a file or directory Project Path: {normalized}"
                )));
            }
            if input.requires_file_target() && !metadata.is_file() {
                return Err(ProjectError::Validation(format!(
                    "Canvas feedback spatial and moment items require a file Project Path: {normalized}"
                )));
            }
        }
        let next =
            update_canvas_feedback_document(&self.feedback_document, input, crate::now_rfc3339())?;
        if next == self.feedback_document {
            return Ok(CanvasFeedbackUpdate {
                feedback: next,
                changed: false,
            });
        }
        write_canvas_feedback_document(&self.root, &next, self.feedback_hash.as_deref())?;
        self.feedback_hash = Some(project_content_hash(fs::read(
            self.root.join(super::CANVAS_FEEDBACK_PROJECT_PATH),
        )?));
        self.feedback_document = next.clone();
        self.rebuild_snapshot(&HashSet::new(), false)?;
        Ok(CanvasFeedbackUpdate {
            feedback: next,
            changed: true,
        })
    }

    pub fn watch_refresh_failed(&mut self, path: &str, message: &str) -> ProjectSnapshot {
        let id = format!("project-tree.watch-failed:{}", project_content_hash(path));
        self.snapshot
            .diagnostics
            .retain(|diagnostic| diagnostic.id != id);
        self.snapshot.diagnostics.push(ProjectDiagnostic {
            id,
            severity: ProjectDiagnosticSeverity::Warning,
            code: "project_tree_watch_failed".to_owned(),
            message: message.to_owned(),
            file_path: (!path.is_empty())
                .then(|| self.root.join(path).to_string_lossy().into_owned()),
            line: None,
            column: None,
            entity_id: None,
        });
        self.refresh_health();
        self.snapshot.clone()
    }

    pub(crate) fn record_path_state_persistence_failure(
        &mut self,
        message: &str,
    ) -> ProjectSnapshot {
        const ID: &str = "project-state.path-state-persistence-failed";
        let diagnostic = ProjectDiagnostic {
            id: ID.to_owned(),
            severity: ProjectDiagnosticSeverity::Error,
            code: "project_path_state_persistence_failed".to_owned(),
            message: format!(
                "Project files changed, but path-keyed state could not be persisted: {message}"
            ),
            file_path: None,
            line: None,
            column: None,
            entity_id: None,
        };
        self.path_state_diagnostic = Some(diagnostic.clone());
        self.snapshot
            .diagnostics
            .retain(|diagnostic| diagnostic.id != ID);
        self.snapshot.diagnostics.push(diagnostic);
        self.refresh_health();
        self.snapshot.clone()
    }

    pub(crate) fn complete_path_state_persistence(&mut self, errors: &[String]) -> ProjectSnapshot {
        if !errors.is_empty() {
            return self.record_path_state_persistence_failure(&errors.join("; "));
        }
        if self.path_state_diagnostic.take().is_some() {
            self.snapshot
                .diagnostics
                .retain(|diagnostic| diagnostic.code != "project_path_state_persistence_failed");
            self.refresh_health();
        }
        self.snapshot.clone()
    }

    pub(crate) fn reconcile_committed_content_change(
        &mut self,
        project_relative_path: &str,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let change = self.project_tree.refresh_watched_paths(&[
            super::watcher::ProjectWatchPath::modified(project_relative_path.to_owned()),
        ])?;
        let mut change = change;
        change
            .identity_reset_paths
            .retain(|path| path != project_relative_path);
        let mut invalidated = self.apply_project_tree_change(&change)?;
        invalidated.insert(project_relative_path.to_owned());
        self.rebuild_snapshot(&invalidated, true)
    }

    pub fn patch_canvas_state(
        &mut self,
        patch: &CanvasStatePatch,
    ) -> Result<(ProjectSnapshot, bool), ProjectError> {
        let current = self.available_canvas_workspace()?.state.clone();
        let next = apply_canvas_state_patch(&current, patch)?;
        let directories = disclosed_directory_closure(&next);
        let change = self.project_tree.load_directories(&directories)?;
        let invalidated = self.apply_project_tree_change(&change)?;
        self.validate_canvas_state_paths(&next)?;
        if next == current {
            if invalidated.is_empty() {
                return Ok((self.snapshot.clone(), false));
            }
            return self
                .rebuild_snapshot(&invalidated, false)
                .map(|snapshot| (snapshot, true));
        }
        let mut document = self.available_canvas_workspace()?.clone();
        document.state = next;
        self.persist_workspace(document)?;
        self.rebuild_snapshot(&invalidated, false)
            .map(|snapshot| (snapshot, true))
    }

    fn validate_canvas_state_paths(&self, state: &CanvasState) -> Result<(), ProjectError> {
        for directory in &state.expanded_directories {
            self.require_project_directory(directory)?;
        }
        for path in state.node_states.keys().chain(state.occlusion_order.iter()) {
            self.require_project_path(path)?;
        }
        Ok(())
    }

    pub fn reset_canvas(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        let document = super::default_canvas_workspace(&self.canonical_root);
        self.canvas_store
            .save(&document)
            .map_err(|unavailable| unavailable.to_error())?;
        self.canvas_workspace = Ok(document);
        self.rebuild_snapshot(&HashSet::new(), false)
    }

    fn available_canvas_workspace(&self) -> Result<&CanvasWorkspaceDocument, ProjectError> {
        self.canvas_workspace
            .as_ref()
            .map_err(CanvasWorkspaceUnavailable::to_error)
    }

    fn persist_workspace(&mut self, document: CanvasWorkspaceDocument) -> Result<(), ProjectError> {
        self.canvas_store
            .save(&document)
            .map_err(|unavailable| unavailable.to_error())?;
        self.canvas_workspace = Ok(document);
        Ok(())
    }

    fn load_canvas_directories(&mut self) -> Result<HashSet<String>, ProjectError> {
        let Ok(workspace) = &self.canvas_workspace else {
            return Ok(HashSet::new());
        };
        let directories = disclosed_directory_closure(&workspace.state);
        let change = self.project_tree.load_directories(&directories)?;
        self.apply_project_tree_change(&change)
    }

    fn load_canvas_directories_for_watcher(
        &mut self,
    ) -> Result<(HashSet<String>, Vec<String>), ProjectError> {
        let Ok(workspace) = &self.canvas_workspace else {
            return Ok((HashSet::new(), Vec::new()));
        };
        let directories = disclosed_directory_closure(&workspace.state);
        let change = self.project_tree.load_directories(&directories)?;
        Ok(self.apply_watched_project_tree_change(&change))
    }

    fn refresh_canvas_feedback_from_disk(&mut self) -> Result<(), ProjectError> {
        let state = read_canvas_feedback_state(&self.root, crate::now_rfc3339())?;
        self.feedback_document = state.document;
        self.feedback_hash = state.content_hash;
        Ok(())
    }

    fn apply_project_tree_change(
        &mut self,
        change: &ProjectTreeChange,
    ) -> Result<HashSet<String>, ProjectError> {
        let invalidated = change
            .confirmed_missing_paths
            .iter()
            .chain(&change.identity_reset_paths)
            .cloned()
            .collect::<HashSet<_>>();
        if invalidated.is_empty() {
            return Ok(invalidated);
        }
        self.reconcile_feedback_paths(&invalidated.iter().cloned().collect::<Vec<_>>(), &[])?;
        if let Some(document) = self.pruned_canvas_workspace(&invalidated) {
            self.persist_workspace(document)?;
        }
        Ok(invalidated)
    }

    fn apply_watched_project_tree_change(
        &mut self,
        change: &ProjectTreeChange,
    ) -> (HashSet<String>, Vec<String>) {
        let invalidated = change
            .confirmed_missing_paths
            .iter()
            .chain(&change.identity_reset_paths)
            .cloned()
            .collect::<HashSet<_>>();
        if invalidated.is_empty() {
            return (invalidated, Vec::new());
        }
        let invalidated_paths = invalidated.iter().cloned().collect::<Vec<_>>();
        let mut errors = Vec::new();
        if let Err(error) = self.reconcile_feedback_paths(&invalidated_paths, &[]) {
            errors.push(error.to_string());
        }
        if let Some(document) = self.pruned_canvas_workspace(&invalidated) {
            match self.canvas_store.save(&document) {
                Ok(()) => self.canvas_workspace = Ok(document),
                Err(unavailable) => {
                    errors.push(unavailable.to_error().to_string());
                    self.canvas_workspace = Err(unavailable);
                }
            }
        }
        (invalidated, errors)
    }

    fn pruned_canvas_workspace(
        &self,
        invalidated: &HashSet<String>,
    ) -> Option<CanvasWorkspaceDocument> {
        let workspace = self.canvas_workspace.as_ref().ok()?;
        let mut document = workspace.clone();
        for path in invalidated {
            document.state = prune_canvas_state_path(&document.state, path);
        }
        (workspace != &document).then_some(document)
    }

    // One rebuild owns a closed Project snapshot transaction.
    fn rebuild_snapshot(
        &mut self,
        invalidated_paths: &HashSet<String>,
        refresh_feedback: bool,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let mut diagnostics = Vec::new();
        if refresh_feedback {
            let state = read_canvas_feedback_state(&self.root, crate::now_rfc3339())?;
            self.feedback_document = state.document;
            self.feedback_hash = state.content_hash;
        }
        diagnostics.extend(self.feedback_render_diagnostics.values().cloned());
        diagnostics.extend(self.path_state_diagnostic.iter().cloned());
        let project_tree = self.project_tree.ordered_entries();
        self.inspection_cache.retain(|path, _| {
            !invalidated_paths
                .iter()
                .any(|invalidated| super::project_path_is_same_or_descendant(path, invalidated))
                && project_tree
                    .iter()
                    .any(|entry| entry.project_relative_path == *path)
        });
        let canvas_workspace = match self.canvas_workspace.clone() {
            Ok(workspace) => {
                let resources = visible_canvas_entries(&project_tree, &workspace.state)
                    .iter()
                    .map(|entry| self.canvas_resource(entry))
                    .collect();
                CanvasWorkspaceSnapshot::Available {
                    workspace,
                    canvas_resources: CanvasResourceView {
                        resources,
                        diagnostics: Vec::new(),
                    },
                }
            }
            Err(unavailable) => CanvasWorkspaceSnapshot::Unavailable {
                code: unavailable.code,
                message: unavailable.message,
            },
        };
        diagnostics.sort_by(|left, right| left.id.cmp(&right.id));
        diagnostics.dedup_by(|left, right| left.id == right.id);
        self.snapshot = ProjectSnapshot {
            canonical_root: self.canonical_root.clone(),
            project_tree,
            canvas_workspace,
            diagnostics,
            health: ProjectHealthSummary {
                project_name: project_name(&self.root),
                diagnostic_counts: ProjectDiagnosticCounts {
                    errors: 0,
                    warnings: 0,
                },
                runtime_data_location: self
                    .debrute_home
                    .join("runtime")
                    .to_string_lossy()
                    .into_owned(),
                checked_at: crate::now_rfc3339(),
            },
        };
        self.refresh_health();
        Ok(self.snapshot.clone())
    }

    fn canvas_resource(&mut self, entry: &ProjectTreeEntry) -> CanvasResource {
        if entry.kind == ProjectPathKind::Directory {
            return CanvasResource::Directory {
                project_relative_path: entry.project_relative_path.clone(),
            };
        }
        let media_kind = canvas_media_kind_from_path(&entry.project_relative_path);
        let mut file =
            match open_no_symlink_existing_project_file(&self.root, &entry.project_relative_path) {
                Ok(file) => file,
                Err(error) => {
                    let availability = if matches!(
                        &error,
                        ProjectError::Io(error) if error.kind() == std::io::ErrorKind::NotFound
                    ) {
                        CanvasNodeAvailability::Missing {
                            message: error.to_string(),
                        }
                    } else {
                        CanvasNodeAvailability::Unreadable {
                            message: error.to_string(),
                        }
                    };
                    return unavailable_canvas_file_resource(entry, media_kind, availability);
                }
            };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                return unavailable_canvas_file_resource(
                    entry,
                    media_kind,
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                );
            }
        };
        let identity = match debrute_native_fs::file_identity(&file) {
            Ok(identity) => identity,
            Err(error) => {
                return unavailable_canvas_file_resource(
                    entry,
                    media_kind,
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                );
            }
        };
        let modified = match metadata.modified() {
            Ok(modified) => modified,
            Err(error) => {
                return unavailable_canvas_file_resource(
                    entry,
                    media_kind,
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                );
            }
        };
        if let Some(cached) = self.inspection_cache.get(&entry.project_relative_path)
            && cached.identity == identity
            && cached.size == metadata.len()
            && cached.modified == modified
        {
            return cached.resource.clone();
        }
        let mtime_ms = system_time_ms(modified);
        let resource = self.inspect_canvas_file(entry, media_kind, &mut file, &metadata, mtime_ms);
        self.inspection_cache.insert(
            entry.project_relative_path.clone(),
            CachedCanvasFileInspection {
                identity,
                size: metadata.len(),
                modified,
                resource: resource.clone(),
            },
        );
        resource
    }

    fn inspect_canvas_file(
        &self,
        entry: &ProjectTreeEntry,
        media_kind: CanvasMediaKind,
        file: &mut fs::File,
        metadata: &fs::Metadata,
        mtime_ms: f64,
    ) -> CanvasResource {
        let revision = match project_media_revision(file) {
            Ok(revision) => revision,
            Err(error) => {
                return unavailable_canvas_file_resource(
                    entry,
                    media_kind,
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                );
            }
        };
        let text_line = if media_kind == CanvasMediaKind::Text {
            match read_text_classification_line(file) {
                Ok(line) => line,
                Err(error) => {
                    return unavailable_canvas_file_resource(
                        entry,
                        media_kind,
                        CanvasNodeAvailability::Unreadable {
                            message: error.to_string(),
                        },
                    );
                }
            }
        } else {
            None
        };
        let (preview, presentation) =
            match self.inspect_node_adapter_data(&entry.project_relative_path, media_kind) {
                Ok(adapter) => adapter,
                Err(availability) => {
                    return unavailable_canvas_file_resource(entry, media_kind, availability);
                }
            };
        let (mime_type, text_language) = project_content_type(
            &entry.project_relative_path,
            media_kind,
            text_line.as_deref(),
        );
        CanvasResource::File {
            project_relative_path: entry.project_relative_path.clone(),
            media_kind,
            availability: Box::new(CanvasNodeAvailability::Available {
                size: metadata.len(),
                mime_type,
                file_url: String::new(),
                canvas_image_previewable: preview.map(|preview| preview.previewable),
                canvas_image_preview_source_width: preview
                    .and_then(|preview| preview.dimensions.map(|dimensions| dimensions.width)),
                mtime_ms: Some(mtime_ms),
                revision,
            }),
            image_dimensions: preview.and_then(|preview| preview.dimensions),
            text_language,
            video_presentation: presentation,
        }
    }

    fn inspect_node_adapter_data(
        &self,
        project_relative_path: &str,
        media_kind: CanvasMediaKind,
    ) -> Result<CanvasNodeAdapterData, CanvasNodeAvailability> {
        let preview = if media_kind == CanvasMediaKind::Image {
            self.node_adapter
                .image_preview_info(&self.root, project_relative_path)
                .map_err(|error| CanvasNodeAvailability::Unreadable {
                    message: error.to_string(),
                })?
        } else {
            None
        };
        let presentation = if media_kind == CanvasMediaKind::Video {
            self.node_adapter
                .video_presentation(&self.root, project_relative_path)
                .map_err(|error| CanvasNodeAvailability::Unreadable {
                    message: error.to_string(),
                })?
        } else {
            None
        };
        Ok((preview, presentation))
    }

    pub(crate) fn reconcile_canvas_path_mutation(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> Result<ProjectSnapshot, ProjectError> {
        self.project_tree
            .refresh_after_mutation(removed_paths, rewrites)?;
        let next_workspace = self.canvas_workspace.as_ref().ok().map(|workspace| {
            let mut document = workspace.clone();
            for removed in removed_paths {
                document.state = prune_canvas_state_path(&document.state, removed);
            }
            for (source, target) in rewrites {
                document.state = rewrite_canvas_state_path(&document.state, source, target);
            }
            document
        });
        let mut persistence_errors = Vec::new();
        if let Err(error) = self.reconcile_feedback_paths(removed_paths, rewrites) {
            persistence_errors.push(error.to_string());
        }
        if let Some(document) = next_workspace
            && let Err(error) = self.persist_workspace(document)
        {
            persistence_errors.push(error.to_string());
        }
        let changed = removed_paths
            .iter()
            .cloned()
            .chain(
                rewrites
                    .iter()
                    .flat_map(|(source, target)| [source.clone(), target.clone()]),
            )
            .collect::<HashSet<_>>();
        self.rebuild_snapshot(&changed, false)?;
        if persistence_errors.is_empty() {
            Ok(self.snapshot.clone())
        } else {
            Ok(self.record_path_state_persistence_failure(&persistence_errors.join("; ")))
        }
    }

    fn reconcile_feedback_paths(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> Result<(), ProjectError> {
        if removed_paths.is_empty() && rewrites.is_empty() {
            return Ok(());
        }
        let mut next = self.feedback_document.clone();
        let rewritten = next
            .entries
            .iter()
            .filter_map(|(path, entry)| {
                rewrites
                    .iter()
                    .map(|(source, target)| super::rewrite_project_path(path, source, target))
                    .find(|target| target != path)
                    .map(|target| {
                        let mut entry = entry.clone();
                        entry.project_relative_path.clone_from(&target);
                        (target, entry)
                    })
            })
            .collect::<Vec<_>>();
        next.entries.retain(|path, _| {
            !removed_paths
                .iter()
                .any(|removed| super::project_path_is_same_or_descendant(path, removed))
                && !rewrites
                    .iter()
                    .any(|(source, _)| super::project_path_is_same_or_descendant(path, source))
        });
        next.entries.extend(rewritten);
        if next == self.feedback_document {
            return Ok(());
        }
        next.updated_at = crate::now_rfc3339();
        write_canvas_feedback_document(&self.root, &next, self.feedback_hash.as_deref())?;
        self.feedback_hash = Some(project_content_hash(fs::read(
            self.root.join(super::CANVAS_FEEDBACK_PROJECT_PATH),
        )?));
        self.feedback_document = next;
        Ok(())
    }

    pub(crate) fn reconcile_committed_path_mutation(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> Result<ProjectSnapshot, ProjectError> {
        self.reconcile_canvas_path_mutation(removed_paths, rewrites)
    }

    fn require_project_directory(&self, path: &str) -> Result<(), ProjectError> {
        let normalized = if path.is_empty() {
            String::new()
        } else {
            super::normalize_project_relative_path(path)?
        };
        match self.project_tree.entry(&normalized) {
            Some(entry) if entry.kind == ProjectPathKind::Directory => Ok(()),
            _ => Err(ProjectError::Validation(format!(
                "Project directory not found: {path}"
            ))),
        }
    }

    fn require_project_path(&self, path: &str) -> Result<(), ProjectError> {
        self.project_tree
            .entry(path)
            .map(|_| ())
            .ok_or_else(|| ProjectError::Validation(format!("Project path not found: {path}")))
    }

    pub(crate) fn snapshot_load_checkpoint(&self) -> SnapshotLoadCheckpoint {
        SnapshotLoadCheckpoint {
            snapshot: self.snapshot.clone(),
            canvas_workspace: self.canvas_workspace.clone(),
            feedback_document: self.feedback_document.clone(),
            feedback_hash: self.feedback_hash.clone(),
            path_state_diagnostic: self.path_state_diagnostic.clone(),
            project_tree: self.project_tree.clone(),
            inspection_cache: self.inspection_cache.clone(),
        }
    }

    pub(crate) fn restore_snapshot_load_checkpoint(&mut self, checkpoint: SnapshotLoadCheckpoint) {
        self.snapshot = checkpoint.snapshot;
        self.canvas_workspace = checkpoint.canvas_workspace;
        self.feedback_document = checkpoint.feedback_document;
        self.feedback_hash = checkpoint.feedback_hash;
        self.path_state_diagnostic = checkpoint.path_state_diagnostic;
        self.project_tree = checkpoint.project_tree;
        self.inspection_cache = checkpoint.inspection_cache;
    }

    fn refresh_health(&mut self) {
        self.snapshot.health.diagnostic_counts = ProjectDiagnosticCounts {
            errors: self
                .snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == ProjectDiagnosticSeverity::Error)
                .count(),
            warnings: self
                .snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == ProjectDiagnosticSeverity::Warning)
                .count(),
        };
        self.snapshot.health.checked_at = crate::now_rfc3339();
    }
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(root.to_string_lossy().as_ref())
        .to_owned()
}

fn disclosed_directory_closure(state: &CanvasState) -> Vec<String> {
    let mut directories = state
        .expanded_directories
        .iter()
        .flat_map(|directory| {
            project_path_ancestors(directory)
                .into_iter()
                .chain(std::iter::once(directory.clone()))
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(|path| path.matches('/').count());
    directories.dedup();
    directories
}

fn project_path_ancestors(path: &str) -> Vec<String> {
    if path.is_empty() {
        return Vec::new();
    }
    let segments = path.split('/').collect::<Vec<_>>();
    std::iter::once(String::new())
        .chain((1..segments.len()).map(|length| segments[..length].join("/")))
        .collect()
}

fn system_time_ms(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

fn project_content_type(
    project_relative_path: &str,
    media_kind: CanvasMediaKind,
    first_line: Option<&str>,
) -> (String, Option<String>) {
    match media_kind {
        CanvasMediaKind::Image => (mime_guess_for_path(project_relative_path, "image/*"), None),
        CanvasMediaKind::Video => (mime_guess_for_path(project_relative_path, "video/*"), None),
        CanvasMediaKind::Audio => (mime_guess_for_path(project_relative_path, "audio/*"), None),
        CanvasMediaKind::Text => project_text_file_type_for_path(project_relative_path, first_line)
            .map_or_else(
                || ("text/plain".to_owned(), Some("plaintext".to_owned())),
                |(language, mime_type)| (mime_type.to_owned(), Some(language.to_owned())),
            ),
        CanvasMediaKind::Unknown => ("application/octet-stream".to_owned(), None),
    }
}

fn unavailable_canvas_file_resource(
    entry: &ProjectTreeEntry,
    media_kind: CanvasMediaKind,
    availability: CanvasNodeAvailability,
) -> CanvasResource {
    CanvasResource::File {
        project_relative_path: entry.project_relative_path.clone(),
        media_kind,
        availability: Box::new(availability),
        image_dimensions: None,
        text_language: None,
        video_presentation: None,
    }
}

fn mime_guess_for_path(path: &str, fallback: &str) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => fallback,
    }
    .to_owned()
}

fn read_text_classification_line(file: &mut fs::File) -> Result<Option<String>, ProjectError> {
    file.seek(SeekFrom::Start(0))?;
    let mut buffer = vec![0_u8; 4096];
    let length = file.read(&mut buffer)?;
    buffer.truncate(length);
    file.seek(SeekFrom::Start(0))?;
    let content = String::from_utf8_lossy(&buffer);
    Ok(content.lines().next().map(str::to_owned))
}
