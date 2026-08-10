//! `ProjectTree`, Feedback, and global Canvas workspace composition.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::Arc,
    time::SystemTime,
};

use super::{
    CanonicalProjectRoot, CanvasFeedbackDiagnosticUpdate, CanvasFeedbackDocument,
    CanvasImageDimensions, CanvasMediaKind, CanvasNodeAvailability, CanvasNodeStateChange,
    CanvasResolvedSource, CanvasResource, CanvasResourceView, CanvasSourceResolutionView,
    CanvasSourceTarget, CanvasState, CanvasStateChange, CanvasStatePatch, CanvasStatePatchOutcome,
    CanvasVideoPresentation, CanvasVideoTextTrack, CanvasWorkspaceDocument,
    CanvasWorkspaceSnapshot, CanvasWorkspaceStore, CanvasWorkspaceUnavailable, ProjectCapabilityFs,
    ProjectDiagnostic, ProjectDiagnosticCounts, ProjectDiagnosticSeverity, ProjectDirectoryPath,
    ProjectError, ProjectHealthSummary, ProjectPathKind, ProjectRelativePath, ProjectSnapshot,
    ProjectSourceDigestResolver, ProjectTree, ProjectTreeChange, ProjectTreeEntry,
    UpdateCanvasFeedbackInput, apply_canvas_state_patch, canvas_media_kind_from_path,
    canvas_path_is_visible, normalize_feedback_path, open_no_symlink_existing_project_file,
    project_content_hash, project_content_type, project_media_kind_from_content_type,
    project_text_file_type_for_path, prune_canvas_state_path, read_canvas_feedback_state,
    resolve_no_symlink_existing_project_path, rewrite_canvas_state_path,
    update_canvas_feedback_document, visible_canvas_entries, write_canvas_feedback_document,
};

type CanvasNodeAdapterData = (
    Option<CanvasImagePreviewInfo>,
    Option<CanvasVideoPresentation>,
);

fn resolved_canvas_source(source_token: String, resource: &CanvasResource) -> CanvasResolvedSource {
    let CanvasResource::File {
        project_relative_path,
        availability,
        video_presentation,
        ..
    } = resource
    else {
        unreachable!("a resolved Canvas source is a file");
    };
    CanvasResolvedSource {
        source_token,
        project_relative_path: project_relative_path.clone(),
        availability: availability.as_ref().clone(),
        video_text_tracks: video_presentation
            .as_ref()
            .map(|presentation| presentation.text_tracks.clone()),
    }
}

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
    source_token: String,
    resource: CanvasResource,
}

#[derive(Debug)]
pub(crate) struct ProjectSourceLease {
    project_root: std::path::PathBuf,
    project_relative_path: ProjectRelativePath,
    revision: String,
    file: fs::File,
    identity: debrute_native_fs::PathIdentity,
    size: u64,
    modified: SystemTime,
}

impl ProjectSourceLease {
    #[cfg(test)]
    pub(crate) fn for_test(
        project_root: &Path,
        project_relative_path: &str,
        revision: String,
    ) -> Result<Self, ProjectError> {
        let relative = ProjectRelativePath::parse(project_relative_path)?;
        let file = open_no_symlink_existing_project_file(project_root, &relative)?;
        let metadata = file.metadata()?;
        Ok(Self {
            project_root: project_root.to_path_buf(),
            project_relative_path: relative,
            revision,
            identity: debrute_native_fs::file_identity(&file)?,
            size: metadata.len(),
            modified: metadata.modified()?,
            file,
        })
    }

    pub(crate) fn project_root(&self) -> &Path {
        &self.project_root
    }

    pub(crate) fn project_relative_path(&self) -> &ProjectRelativePath {
        &self.project_relative_path
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }

    pub(crate) fn size(&self) -> u64 {
        self.size
    }

    pub(crate) fn try_clone_file(&self) -> Result<fs::File, ProjectError> {
        Ok(self.file.try_clone()?)
    }

    pub(crate) fn verify_current(&self) -> Result<(), ProjectError> {
        let file =
            open_no_symlink_existing_project_file(&self.project_root, &self.project_relative_path)?;
        let metadata = file.metadata()?;
        let current_identity = debrute_native_fs::file_identity(&file)?;
        if current_identity == self.identity
            && metadata.len() == self.size
            && metadata.modified()? == self.modified
        {
            Ok(())
        } else {
            Err(ProjectError::service(
                "canvas_source_changed",
                format!("Canvas source changed: {}", self.project_relative_path),
            ))
        }
    }
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

    /// Discovers text tracks only after the exact saved-file video source has been resolved.
    ///
    /// # Errors
    ///
    /// Returns an error when related text tracks cannot be inspected.
    fn video_text_tracks(
        &self,
        _project_root: &Path,
        _project_relative_path: &ProjectRelativePath,
    ) -> Result<Vec<CanvasVideoTextTrack>, ProjectError> {
        Ok(Vec::new())
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
    root: CanonicalProjectRoot,
    capability: ProjectCapabilityFs,
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
        let root = CanonicalProjectRoot::open_existing(project_root.as_ref())?;
        let mut service = Self::prepare_unloaded(root, debrute_home, node_adapter)?;
        service.refresh_loaded_snapshot()?;
        Ok(service)
    }

    pub(crate) fn prepare_unloaded(
        root: CanonicalProjectRoot,
        debrute_home: impl AsRef<Path>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
    ) -> Result<Self, ProjectError> {
        let capability = ProjectCapabilityFs::bind_session_root(root.as_path())?;
        let canvas_store = CanvasWorkspaceStore::new(debrute_home.as_ref(), root.as_wire());
        let canvas_workspace = canvas_store.load_or_create();
        let feedback_document = CanvasFeedbackDocument::empty(crate::now_rfc3339())?;
        let project_tree = ProjectTree::new(root.as_path().to_path_buf());
        let canvas_workspace_snapshot = match &canvas_workspace {
            Ok(workspace) => CanvasWorkspaceSnapshot::Available {
                workspace: workspace.clone(),
                canvas_resources: CanvasResourceView {
                    resources: Vec::new(),
                },
            },
            Err(unavailable) => CanvasWorkspaceSnapshot::Unavailable {
                code: unavailable.code,
                message: unavailable.message.clone(),
            },
        };
        let snapshot = ProjectSnapshot {
            canonical_root: root.as_wire().to_owned(),
            project_tree: Vec::new(),
            canvas_workspace: canvas_workspace_snapshot,
            diagnostics: Vec::new(),
            health: ProjectHealthSummary {
                project_name: project_name(root.as_path()),
                diagnostic_counts: ProjectDiagnosticCounts {
                    errors: 0,
                    warnings: 0,
                },
                checked_at: crate::now_rfc3339(),
            },
        };
        Ok(Self {
            root,
            capability,
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
        self.root.as_path()
    }

    #[must_use]
    pub(crate) fn project_root(&self) -> &CanonicalProjectRoot {
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
            let normalized_path = ProjectDirectoryPath::parse(&normalized)?;
            if !input.requires_existing_target() {
                continue;
            }
            let target = resolve_no_symlink_existing_project_path(&self.root, &normalized_path)
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
        self.record_project_refresh_failure(
            format!("project-tree.watch-failed:{}", project_content_hash(path)),
            ProjectDiagnosticSeverity::Warning,
            "project_tree_watch_failed",
            path,
            message,
        )
    }

    fn committed_project_refresh_failed(
        &mut self,
        path: &str,
        error: &ProjectError,
    ) -> ProjectSnapshot {
        let subject = if path.is_empty() {
            "Project files changed"
        } else {
            "Project file changed"
        };
        self.record_project_refresh_failure(
            "project.refresh-failed".to_owned(),
            ProjectDiagnosticSeverity::Error,
            "project_refresh_failed",
            path,
            &format!("{subject}, but Project state could not refresh: {error}"),
        )
    }

    fn record_project_refresh_failure(
        &mut self,
        id: String,
        severity: ProjectDiagnosticSeverity,
        code: &str,
        path: &str,
        message: &str,
    ) -> ProjectSnapshot {
        self.snapshot
            .diagnostics
            .retain(|diagnostic| diagnostic.id != id);
        self.snapshot.diagnostics.push(ProjectDiagnostic {
            id,
            severity,
            code: code.to_owned(),
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
        expected_identity: debrute_native_fs::PathIdentity,
    ) -> ProjectSnapshot {
        let refresh = self
            .project_tree
            .refresh_committed_content_change(project_relative_path, expected_identity);
        let (mut invalidated, refresh_error) = match refresh {
            Ok(change) => match self.apply_project_tree_change(&change) {
                Ok(invalidated) => (invalidated, None),
                Err(error) => (HashSet::new(), Some(error)),
            },
            Err(error) => (HashSet::new(), Some(error)),
        };
        invalidated.insert(project_relative_path.to_owned());
        let snapshot = match self.rebuild_snapshot(&invalidated, true) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return self.committed_project_refresh_failed(project_relative_path, &error);
            }
        };
        refresh_error.map_or(snapshot, |error| {
            self.committed_project_refresh_failed(project_relative_path, &error)
        })
    }

    pub fn patch_canvas_state(
        &mut self,
        patch: &CanvasStatePatch,
    ) -> Result<CanvasStatePatchOutcome, ProjectError> {
        let current = self.available_canvas_workspace()?.state.clone();
        let mut next = apply_canvas_state_patch(&current, patch)?;
        if next.expanded_directories == current.expanded_directories {
            Self::validate_canvas_state_paths_in(&self.project_tree, &next)?;
            if next == current {
                return Ok(CanvasStatePatchOutcome::Unchanged);
            }
            let change = canvas_state_change(&current, &next);
            let mut document = self.available_canvas_workspace()?.clone();
            document.state = next;
            self.persist_workspace(document.clone())?;
            let CanvasWorkspaceSnapshot::Available { workspace, .. } =
                &mut self.snapshot.canvas_workspace
            else {
                unreachable!("an available Canvas Workspace has an available snapshot");
            };
            workspace.clone_from(&document);
            return Ok(CanvasStatePatchOutcome::StateChanged(change));
        }
        let directories = disclosed_directory_closure(&next);
        let mut project_tree = self.project_tree.clone();
        let change = project_tree.load_directories(&directories)?;
        let invalidated = project_tree_invalidated_paths(&change);
        for path in &invalidated {
            next = prune_canvas_state_path(&next, path);
        }
        Self::validate_canvas_state_paths_in(&project_tree, &next)?;
        let canvas_changed = next != current;
        if !canvas_changed && invalidated.is_empty() {
            return Ok(CanvasStatePatchOutcome::Unchanged);
        }
        if canvas_changed {
            let mut document = self.available_canvas_workspace()?.clone();
            document.state = next;
            self.persist_workspace(document)?;
        }
        self.project_tree = project_tree;
        let feedback_error = self
            .reconcile_feedback_paths(&invalidated.iter().cloned().collect::<Vec<_>>(), &[])
            .err();
        let snapshot = self
            .rebuild_snapshot(&invalidated, false)
            .expect("accepted Canvas Workspace remains valid while rebuilding a patch snapshot");
        let snapshot = feedback_error.map_or(snapshot, |error| {
            self.record_path_state_persistence_failure(&error.to_string())
        });
        Ok(CanvasStatePatchOutcome::ProjectChanged(Box::new(snapshot)))
    }

    fn validate_canvas_state_paths_in(
        project_tree: &ProjectTree,
        state: &CanvasState,
    ) -> Result<(), ProjectError> {
        for directory in &state.expanded_directories {
            Self::require_project_directory_in(project_tree, directory)?;
        }
        for path in state.node_states.keys().chain(state.occlusion_order.iter()) {
            Self::require_project_path_in(project_tree, path)?;
        }
        Ok(())
    }

    pub fn reset_canvas(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        let document = super::default_canvas_workspace(self.root.as_wire());
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
        let invalidated = project_tree_invalidated_paths(change);
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
        let invalidated = project_tree_invalidated_paths(change);
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
                    canvas_resources: CanvasResourceView { resources },
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
            canonical_root: self.root.as_wire().to_owned(),
            project_tree,
            canvas_workspace,
            diagnostics,
            health: ProjectHealthSummary {
                project_name: project_name(&self.root),
                diagnostic_counts: ProjectDiagnosticCounts {
                    errors: 0,
                    warnings: 0,
                },
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
        let relative = ProjectRelativePath::parse(&entry.project_relative_path);
        let mut file = match relative
            .and_then(|relative| open_no_symlink_existing_project_file(&self.root, &relative))
        {
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
        let source_token = uuid::Uuid::new_v4().to_string();
        let resource = self.describe_canvas_file(entry, &mut file, &metadata, &source_token);
        self.inspection_cache.insert(
            entry.project_relative_path.clone(),
            CachedCanvasFileInspection {
                identity,
                size: metadata.len(),
                modified,
                source_token,
                resource: resource.clone(),
            },
        );
        resource
    }

    fn describe_canvas_file(
        &self,
        entry: &ProjectTreeEntry,
        file: &mut fs::File,
        metadata: &fs::Metadata,
        source_token: &str,
    ) -> CanvasResource {
        let (media_kind, mime_type, text_language) =
            match classify_canvas_file(&entry.project_relative_path, file) {
                Ok(classification) => classification,
                Err(error) => {
                    return unavailable_canvas_file_resource(
                        entry,
                        canvas_media_kind_from_path(&entry.project_relative_path),
                        CanvasNodeAvailability::Unreadable {
                            message: error.to_string(),
                        },
                    );
                }
            };
        let relative = match ProjectRelativePath::parse(&entry.project_relative_path) {
            Ok(relative) => relative,
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
        let (preview, presentation) = match self.inspect_node_adapter_data(&relative, media_kind) {
            Ok(adapter) => adapter,
            Err(availability) => {
                return unavailable_canvas_file_resource(entry, media_kind, availability);
            }
        };
        CanvasResource::File {
            project_relative_path: entry.project_relative_path.clone(),
            media_kind,
            availability: Box::new(CanvasNodeAvailability::Resolving {
                size: metadata.len(),
                mime_type,
                source_token: source_token.to_owned(),
                canvas_image_previewable: preview.map(|preview| preview.previewable),
                canvas_image_preview_source_width: preview
                    .and_then(|preview| preview.dimensions.map(|dimensions| dimensions.width)),
            }),
            image_dimensions: preview.and_then(|preview| preview.dimensions),
            text_language,
            video_presentation: presentation,
        }
    }

    fn resolve_canvas_file_descriptor(
        &self,
        entry: &ProjectTreeEntry,
        project_relative_path: &ProjectRelativePath,
        descriptor: &CanvasResource,
        revision: String,
    ) -> CanvasResource {
        let CanvasResource::File {
            media_kind,
            availability,
            image_dimensions,
            text_language,
            video_presentation,
            ..
        } = descriptor
        else {
            unreachable!("a Canvas source descriptor always represents a file");
        };
        let CanvasNodeAvailability::Resolving {
            size,
            mime_type,
            canvas_image_previewable,
            canvas_image_preview_source_width,
            ..
        } = availability.as_ref()
        else {
            return descriptor.clone();
        };
        let mut video_presentation = video_presentation.clone();
        if let Some(presentation) = &mut video_presentation {
            presentation.text_tracks = match self
                .node_adapter
                .video_text_tracks(&self.root, project_relative_path)
            {
                Ok(tracks) => tracks,
                Err(error) => {
                    return unavailable_canvas_file_resource(
                        entry,
                        *media_kind,
                        CanvasNodeAvailability::Unreadable {
                            message: error.to_string(),
                        },
                    );
                }
            };
        }
        CanvasResource::File {
            project_relative_path: entry.project_relative_path.clone(),
            media_kind: *media_kind,
            availability: Box::new(CanvasNodeAvailability::Available {
                size: *size,
                mime_type: mime_type.clone(),
                file_url: String::new(),
                canvas_image_previewable: *canvas_image_previewable,
                canvas_image_preview_source_width: *canvas_image_preview_source_width,
                revision,
            }),
            image_dimensions: *image_dimensions,
            text_language: text_language.clone(),
            video_presentation,
        }
    }

    pub(crate) fn resolve_canvas_sources(
        &mut self,
        targets: &[CanvasSourceTarget],
        source_digests: &ProjectSourceDigestResolver,
    ) -> Result<CanvasSourceResolutionView, ProjectError> {
        self.canvas_workspace.as_ref().map_err(|unavailable| {
            ProjectError::service("canvas_workspace_unavailable", unavailable.message.clone())
        })?;
        let mut sources = Vec::with_capacity(targets.len());
        for target in targets {
            let path = target.project_relative_path.as_str();
            let entry = self
                .project_tree
                .entry(path)
                .filter(|_| {
                    self.canvas_workspace
                        .as_ref()
                        .is_ok_and(|workspace| canvas_path_is_visible(path, &workspace.state))
                })
                .cloned()
                .ok_or_else(|| {
                    ProjectError::service(
                        "canvas_source_not_visible",
                        format!("Canvas source is not in the current Folder Disclosure: {path}"),
                    )
                })?;
            if entry.kind != ProjectPathKind::File {
                return Err(ProjectError::service(
                    "canvas_source_not_file",
                    format!("Canvas source is not a file: {path}"),
                ));
            }
            let cached = self.inspection_cache.get(path).ok_or_else(|| {
                ProjectError::service(
                    "canvas_source_changed",
                    format!("Canvas source changed: {path}"),
                )
            })?;
            if cached.source_token != target.source_token {
                return Err(ProjectError::service(
                    "canvas_source_changed",
                    format!("Canvas source changed: {path}"),
                ));
            }
            let descriptor = cached.resource.clone();
            if matches!(
                &cached.resource,
                CanvasResource::File {
                    availability,
                    ..
                } if matches!(availability.as_ref(), CanvasNodeAvailability::Available { .. })
            ) {
                sources.push(resolved_canvas_source(
                    target.source_token.clone(),
                    &cached.resource,
                ));
                continue;
            }
            let mut file =
                open_no_symlink_existing_project_file(&self.root, &target.project_relative_path)?;
            let metadata = file.metadata()?;
            let identity = debrute_native_fs::file_identity(&file)?;
            let modified = metadata.modified()?;
            if identity != cached.identity
                || metadata.len() != cached.size
                || modified != cached.modified
            {
                self.inspection_cache.remove(path);
                return Err(ProjectError::service(
                    "canvas_source_changed",
                    format!("Canvas source changed: {path}"),
                ));
            }
            let media_kind = match &descriptor {
                CanvasResource::File { media_kind, .. } => *media_kind,
                CanvasResource::Directory { .. } => unreachable!("a source target is a file"),
            };
            let mut resource = match source_digests.resolve(&mut file) {
                Ok(revision) => self.resolve_canvas_file_descriptor(
                    &entry,
                    &target.project_relative_path,
                    &descriptor,
                    revision,
                ),
                Err(error) => unavailable_canvas_file_resource(
                    &entry,
                    media_kind,
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                ),
            };
            self.resolve_video_text_track_sources(&mut resource, source_digests)?;
            self.inspection_cache.insert(
                path.to_owned(),
                CachedCanvasFileInspection {
                    identity,
                    size: metadata.len(),
                    modified,
                    source_token: target.source_token.clone(),
                    resource: resource.clone(),
                },
            );
            sources.push(resolved_canvas_source(
                target.source_token.clone(),
                &resource,
            ));
        }
        Ok(CanvasSourceResolutionView { sources })
    }

    fn resolve_video_text_track_sources(
        &mut self,
        resource: &mut CanvasResource,
        source_digests: &ProjectSourceDigestResolver,
    ) -> Result<(), ProjectError> {
        let track_paths = match resource {
            CanvasResource::File {
                video_presentation: Some(presentation),
                ..
            } => presentation
                .text_tracks
                .iter()
                .map(|track| track.project_relative_path.clone())
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        if track_paths.is_empty() {
            return Ok(());
        }
        let targets = track_paths
            .iter()
            .map(|track_path| {
                let project_relative_path = ProjectRelativePath::parse(track_path)?;
                let source_token = self
                    .inspection_cache
                    .get(project_relative_path.as_str())
                    .ok_or_else(|| {
                        ProjectError::service(
                            "canvas_source_changed",
                            format!("Canvas source changed: {project_relative_path}"),
                        )
                    })?
                    .source_token
                    .clone();
                Ok(CanvasSourceTarget {
                    project_relative_path,
                    source_token,
                })
            })
            .collect::<Result<Vec<_>, ProjectError>>()?;
        let resolved = self.resolve_canvas_sources(&targets, source_digests)?;
        let revisions = resolved
            .sources
            .iter()
            .filter_map(|source| match &source.availability {
                CanvasNodeAvailability::Available { revision, .. } => {
                    Some((source.project_relative_path.clone(), revision.clone()))
                }
                _ => None,
            })
            .collect::<HashMap<_, _>>();
        let CanvasResource::File {
            video_presentation: Some(presentation),
            ..
        } = resource
        else {
            unreachable!("video presentation existed before resolving its text tracks");
        };
        for track in &mut presentation.text_tracks {
            track.revision = revisions
                .get(&track.project_relative_path)
                .cloned()
                .ok_or_else(|| {
                    ProjectError::service(
                        "canvas_source_unresolved",
                        format!(
                            "Canvas video text track could not be resolved: {}",
                            track.project_relative_path
                        ),
                    )
                })?;
        }
        Ok(())
    }

    pub(crate) fn canvas_source_lease(
        &self,
        project_relative_path: &ProjectRelativePath,
        expected_revision: &str,
    ) -> Result<ProjectSourceLease, ProjectError> {
        let path = project_relative_path.as_str();
        let cached = self.inspection_cache.get(path).ok_or_else(|| {
            ProjectError::service(
                "canvas_source_unresolved",
                format!("Canvas source has not been resolved: {path}"),
            )
        })?;
        let revision = match &cached.resource {
            CanvasResource::File { availability, .. } => match availability.as_ref() {
                CanvasNodeAvailability::Available { revision, .. } => revision,
                _ => {
                    return Err(ProjectError::service(
                        "canvas_source_unresolved",
                        format!("Canvas source has not been resolved: {path}"),
                    ));
                }
            },
            CanvasResource::Directory { .. } => {
                return Err(ProjectError::service(
                    "canvas_source_not_file",
                    format!("Canvas source is not a file: {path}"),
                ));
            }
        };
        if revision != expected_revision {
            return Err(ProjectError::service(
                "stale_revision",
                format!("Canvas source revision does not match: {path}"),
            ));
        }
        let file = open_no_symlink_existing_project_file(&self.root, project_relative_path)?;
        let metadata = file.metadata()?;
        let identity = debrute_native_fs::file_identity(&file)?;
        if identity != cached.identity
            || metadata.len() != cached.size
            || metadata.modified()? != cached.modified
        {
            return Err(ProjectError::service(
                "canvas_source_changed",
                format!("Canvas source changed: {path}"),
            ));
        }
        Ok(ProjectSourceLease {
            project_root: self.root.to_path_buf(),
            project_relative_path: project_relative_path.clone(),
            revision: revision.clone(),
            file,
            identity,
            size: metadata.len(),
            modified: cached.modified,
        })
    }

    fn inspect_node_adapter_data(
        &self,
        project_relative_path: &ProjectRelativePath,
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

    pub(crate) fn reconcile_committed_path_mutation(
        &mut self,
        removed_paths: &[String],
        rewrites: &[(String, String)],
    ) -> ProjectSnapshot {
        let (project_tree_change, project_tree_refresh_error) = match self
            .project_tree
            .refresh_after_mutation(removed_paths, rewrites)
        {
            Ok(change) => (change, None),
            Err(error) => (ProjectTreeChange::default(), Some(error)),
        };
        let mut reconciled_removed_paths = removed_paths.to_vec();
        reconciled_removed_paths.extend(
            project_tree_change
                .confirmed_missing_paths
                .iter()
                .chain(&project_tree_change.identity_reset_paths)
                .cloned(),
        );
        reconciled_removed_paths.sort();
        reconciled_removed_paths.dedup();
        let next_workspace = self.canvas_workspace.as_ref().ok().map(|workspace| {
            let mut document = workspace.clone();
            for removed in &reconciled_removed_paths {
                document.state = prune_canvas_state_path(&document.state, removed);
            }
            for (source, target) in rewrites {
                document.state = rewrite_canvas_state_path(&document.state, source, target);
            }
            document
        });
        let mut persistence_errors = Vec::new();
        if let Err(error) = self.reconcile_feedback_paths(&reconciled_removed_paths, rewrites) {
            persistence_errors.push(error.to_string());
        }
        if let Some(document) = next_workspace
            && let Err(error) = self.persist_workspace(document)
        {
            persistence_errors.push(error.to_string());
        }
        let changed = reconciled_removed_paths
            .iter()
            .cloned()
            .chain(
                rewrites
                    .iter()
                    .flat_map(|(source, target)| [source.clone(), target.clone()]),
            )
            .collect::<HashSet<_>>();
        let mut snapshot = self
            .rebuild_snapshot(&changed, false)
            .expect("rebuilding without a Feedback refresh is infallible");
        if let Some(error) = project_tree_refresh_error {
            snapshot = self.committed_project_refresh_failed("", &error);
        }
        if !persistence_errors.is_empty() {
            snapshot = self.record_path_state_persistence_failure(&persistence_errors.join("; "));
        }
        snapshot
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
            .filter(|(path, _)| {
                !removed_paths
                    .iter()
                    .any(|removed| super::project_path_is_same_or_descendant(path, removed))
            })
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

    fn require_project_directory_in(
        project_tree: &ProjectTree,
        path: &str,
    ) -> Result<(), ProjectError> {
        let normalized = if path.is_empty() {
            String::new()
        } else {
            super::ProjectRelativePath::parse(path)?.into_string()
        };
        match project_tree.entry(&normalized) {
            Some(entry) if entry.kind == ProjectPathKind::Directory => Ok(()),
            _ => Err(ProjectError::Validation(format!(
                "Project directory not found: {path}"
            ))),
        }
    }

    fn require_project_path_in(project_tree: &ProjectTree, path: &str) -> Result<(), ProjectError> {
        project_tree
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

fn canvas_state_change(current: &CanvasState, next: &CanvasState) -> CanvasStateChange {
    let paths = current
        .node_states
        .keys()
        .chain(next.node_states.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let node_states = paths
        .into_iter()
        .filter(|path| current.node_states.get(*path) != next.node_states.get(*path))
        .map(|path| CanvasNodeStateChange {
            project_relative_path: path.clone(),
            state: next.node_states.get(path).cloned(),
        })
        .collect();
    CanvasStateChange {
        node_states,
        occlusion_order: (current.occlusion_order != next.occlusion_order)
            .then(|| next.occlusion_order.clone()),
    }
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(root.to_string_lossy().as_ref())
        .to_owned()
}

fn project_tree_invalidated_paths(change: &ProjectTreeChange) -> HashSet<String> {
    change
        .confirmed_missing_paths
        .iter()
        .chain(&change.identity_reset_paths)
        .cloned()
        .collect()
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

fn classify_canvas_file(
    project_relative_path: &str,
    file: &mut fs::File,
) -> Result<(CanvasMediaKind, String, Option<String>), ProjectError> {
    let content_type = project_content_type(project_relative_path);
    let media_kind = project_media_kind_from_content_type(content_type);
    if media_kind != CanvasMediaKind::Unknown {
        return Ok((media_kind, content_type.to_owned(), None));
    }
    if let Some((language, mime_type)) =
        project_text_file_type_for_path(project_relative_path, None)
    {
        return Ok((
            CanvasMediaKind::Text,
            mime_type.to_owned(),
            Some(language.to_owned()),
        ));
    }
    let first_line = read_text_classification_line(file)?;
    Ok(
        project_text_file_type_for_path(project_relative_path, first_line.as_deref()).map_or_else(
            || (CanvasMediaKind::Unknown, content_type.to_owned(), None),
            |(language, mime_type)| {
                (
                    CanvasMediaKind::Text,
                    mime_type.to_owned(),
                    Some(language.to_owned()),
                )
            },
        ),
    )
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

fn read_text_classification_line(file: &mut fs::File) -> Result<Option<String>, ProjectError> {
    file.seek(SeekFrom::Start(0))?;
    let mut buffer = vec![0_u8; 4096];
    let length = file.read(&mut buffer)?;
    buffer.truncate(length);
    file.seek(SeekFrom::Start(0))?;
    let content = String::from_utf8_lossy(&buffer);
    Ok(content.lines().next().map(str::to_owned))
}
