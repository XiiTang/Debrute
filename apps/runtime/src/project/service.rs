//! Project snapshot and Canvas service composition.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use uuid::Uuid;

use super::{
    CANVAS_INDEX_FILE, CanvasDesiredLayoutRow, CanvasDesiredNode, CanvasDocument,
    CanvasFeedbackDiagnosticUpdate, CanvasFeedbackDocument, CanvasLayoutSize, CanvasMapPathRuleSet,
    CanvasMediaKind, CanvasNodeAvailability, CanvasNodeElement, CanvasNodeKind,
    CanvasNodeLayoutUpdate, CanvasProjection, CanvasRegistryDocument, CanvasRegistryState,
    CanvasTextViewportUpdate, CanvasVideoPlaybackUpdate, CanvasVideoPresentation,
    DebruteProjectIdentity, DebruteProjectMetadata, DebruteProjectPaths, ExpandedCanvasMap,
    ProjectCapabilityFs, ProjectDiagnostic, ProjectDiagnosticCounts, ProjectDiagnosticSeverity,
    ProjectDocumentDelete, ProjectDocumentRead, ProjectDocumentTransaction, ProjectDocumentWrite,
    ProjectError, ProjectFileEntry, ProjectHealthSummary, ProjectSnapshot,
    UpdateCanvasFeedbackEntryInput, bring_canvas_node_to_front, canvas_map_path,
    canvas_media_kind_from_path, clear_canvas_manual_layouts, commit_project_document_transaction,
    create_canvas_document, debrute_project_paths, expand_canvas_map, expand_canvas_map_path_rules,
    is_valid_stable_project_id, list_project_files, normalize_canvas_name, parse_canvas_map,
    project_canvas, project_canvas_with_known_projection, project_content_hash,
    project_document_directory_hash, project_document_file_hash, project_file_revision,
    project_text_file_type_for_path, read_canvas_feedback_state, reconcile_canvas_nodes,
    replace_file, resolve_existing_project_path, resolve_no_symlink_project_path_for_write,
    serialize_canvas_map_with_rule, update_canvas_feedback_document, update_canvas_node_layouts,
    update_canvas_text_viewports, update_canvas_video_playback, validate_canvas_document,
    validate_canvas_feedback_document, validate_canvas_id, validate_feedback_media_targets,
    write_canvas_feedback_document,
};

const EMPTY_CANVAS_MAP: &str = "paths: []\n";
type CanvasNodeAdapterData = (Option<(bool, Option<u64>)>, Option<CanvasVideoPresentation>);

struct CanvasMetadataFile {
    id: String,
    path: PathBuf,
    content: Vec<u8>,
}

struct CanvasRegistryRepairInventory {
    map_files: Vec<CanvasMetadataFile>,
    canvas_files: Vec<CanvasMetadataFile>,
    map_directory_hash: Option<String>,
    canvas_directory_hash: Option<String>,
}

pub trait ProjectNodeAdapter: Send + Sync {
    /// Resolves the initial layout size for a projected Canvas node.
    ///
    /// # Errors
    ///
    /// Returns an error when the node's dimensions cannot be resolved.
    fn layout_size(
        &self,
        project_root: &Path,
        node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError>;

    /// Loads Runtime-owned video presentation metadata for a projected node.
    ///
    /// # Errors
    ///
    /// Returns an error when the presentation cannot be inspected.
    fn video_presentation(
        &self,
        _project_root: &Path,
        _project_relative_path: &str,
    ) -> Result<Option<CanvasVideoPresentation>, ProjectError> {
        Ok(None)
    }

    /// Loads image-preview capability metadata for a projected node.
    ///
    /// # Errors
    ///
    /// Returns an error when preview capability cannot be inspected.
    fn image_preview_info(
        &self,
        _project_root: &Path,
        _project_relative_path: &str,
    ) -> Result<Option<(bool, Option<u64>)>, ProjectError> {
        Ok(None)
    }
}

pub struct DefaultProjectNodeAdapter;

impl ProjectNodeAdapter for DefaultProjectNodeAdapter {
    fn layout_size(
        &self,
        _project_root: &Path,
        node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        match (node.node_kind, node.media_kind) {
            (CanvasNodeKind::Directory, _)
            | (CanvasNodeKind::File, Some(CanvasMediaKind::Unknown) | None) => {
                Ok(generic_layout_size(&node.project_relative_path))
            }
            (CanvasNodeKind::File, Some(CanvasMediaKind::Text)) => Ok(CanvasLayoutSize {
                width: 4200.0,
                height: 2800.0,
            }),
            (CanvasNodeKind::File, Some(CanvasMediaKind::Audio)) => Ok(CanvasLayoutSize {
                width: 3200.0,
                height: 960.0,
            }),
            (CanvasNodeKind::File, Some(CanvasMediaKind::Image | CanvasMediaKind::Video)) => {
                Err(ProjectError::service(
                    "canvas_media_dimensions_unavailable",
                    format!(
                        "Canvas media dimensions are unavailable: {}",
                        node.project_relative_path
                    ),
                ))
            }
        }
    }
}

pub struct ProjectService {
    root: PathBuf,
    capability: ProjectCapabilityFs,
    debrute_home: PathBuf,
    node_adapter: Arc<dyn ProjectNodeAdapter>,
    snapshot: ProjectSnapshot,
    registry_hash: Option<String>,
    canvas_hashes: HashMap<String, String>,
    canvas_map_hashes: HashMap<String, String>,
    feedback_document: CanvasFeedbackDocument,
    feedback_hash: Option<String>,
    feedback_valid: bool,
    feedback_render_diagnostics: HashMap<String, ProjectDiagnostic>,
}

impl ProjectService {
    /// Opens or initializes a Project and loads its complete current snapshot.
    ///
    /// # Errors
    /// Returns an error when initialization, validation, synchronization, or inspection fails.
    pub fn open(
        project_root: impl AsRef<Path>,
        debrute_home: impl AsRef<Path>,
        node_adapter: Arc<dyn ProjectNodeAdapter>,
    ) -> Result<Self, ProjectError> {
        let root = project_root.as_ref().canonicalize()?;
        let capability = ProjectCapabilityFs::bind_session_root(&root)?;
        let debrute_home = debrute_home.as_ref().to_path_buf();
        initialize_project_if_missing(&root, &debrute_home)?;
        ensure_default_canvas(&root, &debrute_home)?;
        let feedback_document = CanvasFeedbackDocument::empty(crate::now_rfc3339())?;
        let empty = ProjectSnapshot {
            project_root: root.to_string_lossy().into_owned(),
            metadata: read_project_metadata(&root, &debrute_home)?,
            files: Vec::new(),
            canvases: Vec::new(),
            projections: Vec::new(),
            diagnostics: Vec::new(),
            canvas_registry: CanvasRegistryState::Invalid {
                code: "canvas_registry_missing".to_owned(),
                message: "Canvas registry is missing.".to_owned(),
            },
            health: ProjectHealthSummary {
                project_name: String::new(),
                canvas_count: 0,
                diagnostic_counts: ProjectDiagnosticCounts {
                    errors: 0,
                    warnings: 0,
                },
                runtime_data_location: debrute_home.join("runtime").to_string_lossy().into_owned(),
                checked_at: crate::now_rfc3339(),
            },
        };
        let mut service = Self {
            root,
            capability,
            debrute_home,
            node_adapter,
            snapshot: empty,
            registry_hash: None,
            canvas_hashes: HashMap::new(),
            canvas_map_hashes: HashMap::new(),
            feedback_document,
            feedback_hash: None,
            feedback_valid: true,
            feedback_render_diagnostics: HashMap::new(),
        };
        service.snapshot = service.load_snapshot_transactional(true)?;
        Ok(service)
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn snapshot(&self) -> &ProjectSnapshot {
        &self.snapshot
    }

    pub(crate) fn release_capability_binding(&self) {
        self.capability.unbind_session_root(&self.root);
    }

    pub(crate) fn canvas_feedback(&self) -> Result<&CanvasFeedbackDocument, ProjectError> {
        if self.feedback_valid {
            Ok(&self.feedback_document)
        } else {
            Err(ProjectError::service(
                "canvas_feedback_invalid",
                "Canvas feedback document is invalid.",
            ))
        }
    }

    pub(crate) fn apply_canvas_feedback_diagnostics(
        &mut self,
        update: &CanvasFeedbackDiagnosticUpdate,
    ) -> Option<ProjectSnapshot> {
        const PREFIX: &str = "canvas-feedback.render_failed:";
        const RUNTIME_ID: &str = "canvas-feedback.runtime_failed";
        const CLEANUP_ID: &str = "canvas-feedback.cleanup_failed";
        for resolved in &update.resolved_diagnostic_ids {
            self.feedback_render_diagnostics.remove(resolved);
        }
        if update.checked_all_entries {
            let retained = update
                .retained_project_relative_paths
                .iter()
                .collect::<HashSet<_>>();
            self.feedback_render_diagnostics.retain(|_, diagnostic| {
                !diagnostic.id.starts_with(PREFIX)
                    || diagnostic
                        .entity_id
                        .as_ref()
                        .is_some_and(|entity| retained.contains(entity))
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
        let mut diagnostics = self
            .snapshot
            .diagnostics
            .iter()
            .filter(|diagnostic| {
                !diagnostic.id.starts_with(PREFIX)
                    && diagnostic.id != RUNTIME_ID
                    && diagnostic.id != CLEANUP_ID
            })
            .cloned()
            .chain(self.feedback_render_diagnostics.values().cloned())
            .collect::<Vec<_>>();
        diagnostics.sort_by(|left, right| left.id.cmp(&right.id));
        diagnostics.dedup_by(|left, right| left.id == right.id);
        if diagnostics == self.snapshot.diagnostics {
            return None;
        }
        self.snapshot.diagnostics = diagnostics;
        self.snapshot.health = project_health(
            &self.snapshot.metadata,
            self.snapshot.canvases.len(),
            &self.snapshot.diagnostics,
            &self.debrute_home,
        );
        Some(self.snapshot.clone())
    }

    pub(crate) fn preserve_public_snapshot(&mut self, snapshot: ProjectSnapshot) {
        self.snapshot = snapshot;
    }

    /// Reloads the Project and commits valid Canvas Map projection drift.
    ///
    /// # Errors
    /// Returns an error when Project state cannot be read, validated, or synchronized.
    pub fn refresh(&mut self) -> Result<ProjectSnapshot, ProjectError> {
        self.snapshot = self.load_snapshot_transactional(true)?;
        Ok(self.snapshot.clone())
    }

    /// Applies one closed Canvas feedback mutation as a structured-document transaction.
    ///
    /// # Errors
    /// Returns an error for invalid feedback, unsupported media targets, or write conflicts.
    pub fn update_canvas_feedback(
        &mut self,
        input: &UpdateCanvasFeedbackEntryInput,
    ) -> Result<CanvasFeedbackDocument, ProjectError> {
        let current = self.canvas_feedback()?.clone();
        let next = update_canvas_feedback_document(&current, input, crate::now_rfc3339())?;
        validate_feedback_media_targets(&next)?;
        write_canvas_feedback_document(&self.root, &next, self.feedback_hash.as_deref())?;
        self.finish_committed_change(super::CANVAS_FEEDBACK_PROJECT_PATH)?;
        Ok(self.canvas_feedback()?.clone())
    }

    /// Records a watched refresh failure without discarding the last good snapshot.
    ///
    pub fn watch_refresh_failed(
        &mut self,
        project_relative_path: &str,
        error_message: &str,
    ) -> ProjectSnapshot {
        let id = format!("project.watch.refresh_failed:{project_relative_path}");
        let mut snapshot = self.snapshot.clone();
        snapshot
            .diagnostics
            .retain(|diagnostic| diagnostic.id != id);
        snapshot.diagnostics.insert(
            0,
            ProjectDiagnostic {
                id,
                severity: ProjectDiagnosticSeverity::Error,
                code: "project.watch.refresh_failed".to_owned(),
                message: error_message.to_owned(),
                file_path: Some(
                    self.root
                        .join(project_relative_path)
                        .to_string_lossy()
                        .into_owned(),
                ),
                line: None,
                column: None,
                entity_id: None,
            },
        );
        snapshot.health = project_health(
            &snapshot.metadata,
            snapshot.canvases.len(),
            &snapshot.diagnostics,
            &self.debrute_home,
        );
        self.snapshot = snapshot.clone();
        snapshot
    }

    pub(crate) fn finish_committed_change(
        &mut self,
        project_relative_path: &str,
    ) -> Result<ProjectSnapshot, ProjectError> {
        match self.load_snapshot_transactional(true) {
            Ok(snapshot) => self.snapshot = snapshot,
            Err(error) if error.leaves_mutation_outcome_uncertain() => return Err(error),
            Err(error) => {
                self.watch_refresh_failed(project_relative_path, &error.to_string());
            }
        }
        Ok(self.snapshot.clone())
    }

    /// Creates and registers the next deterministic Canvas pair.
    ///
    /// # Errors
    /// Returns an error for invalid registry state, conflicts, or commit failure.
    pub fn create_canvas(&mut self) -> Result<(String, ProjectSnapshot), ProjectError> {
        let order = self.ready_order()?;
        let id = next_canvas_id(&order);
        let paths = debrute_project_paths(&self.root, &self.debrute_home);
        let canvas = create_canvas_document(&id)?;
        let registry = CanvasRegistryDocument {
            canvas_order: order.into_iter().chain([id.clone()]).collect(),
        };
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-registry".to_owned(),
            reads: vec![
                ProjectDocumentRead {
                    absolute_path: paths.canvas_index_file.clone(),
                    expected_hash: self.required_registry_hash()?,
                },
                ProjectDocumentRead {
                    absolute_path: paths.canvas_maps_dir.join(format!("{id}.yaml")),
                    expected_hash: None,
                },
                ProjectDocumentRead {
                    absolute_path: paths.canvases_dir.join(format!("{id}.json")),
                    expected_hash: None,
                },
            ],
            writes: vec![
                ProjectDocumentWrite {
                    absolute_path: paths.canvas_maps_dir.join(format!("{id}.yaml")),
                    content: EMPTY_CANVAS_MAP.to_owned(),
                },
                ProjectDocumentWrite {
                    absolute_path: paths.canvases_dir.join(format!("{id}.json")),
                    content: json_pretty(&canvas)?,
                },
                ProjectDocumentWrite {
                    absolute_path: paths.canvas_index_file,
                    content: json_pretty(&registry)?,
                },
            ],
            deletes: Vec::new(),
        })?;
        self.finish_committed_change(".debrute/canvases/index.json")?;
        Ok((id, self.snapshot.clone()))
    }

    /// Renames one registered Canvas.
    ///
    /// # Errors
    /// Returns an error for invalid input, missing state, conflicts, or commit failure.
    pub fn rename_canvas(
        &mut self,
        canvas_id: &str,
        name: &str,
    ) -> Result<ProjectSnapshot, ProjectError> {
        validate_canvas_id(canvas_id)?;
        let name = normalize_canvas_name(name)?;
        if !self.ready_order()?.iter().any(|id| id == canvas_id) {
            return Err(ProjectError::service(
                "canvas_registry_invalid",
                format!("Canvas is not in registry: {canvas_id}"),
            ));
        }
        let mut canvas = self
            .snapshot
            .canvases
            .iter()
            .find(|canvas| canvas.id == canvas_id)
            .cloned()
            .ok_or_else(|| {
                ProjectError::service(
                    "canvas_registry_invalid",
                    format!("Canvas JSON is missing: {canvas_id}"),
                )
            })?;
        canvas.name = name;
        self.write_canvas("canvas-registry", &canvas)?;
        self.finish_committed_change(&format!(".debrute/canvases/{canvas_id}.json"))?;
        Ok(self.snapshot.clone())
    }

    /// Replaces Canvas order with one complete permutation.
    ///
    /// # Errors
    /// Returns an error for invalid permutations, conflicts, or commit failure.
    pub fn reorder_canvases(&mut self, order: &[String]) -> Result<ProjectSnapshot, ProjectError> {
        let current = self.ready_order()?;
        assert_complete_permutation(order, &current)?;
        self.write_registry(order)?;
        self.finish_committed_change(".debrute/canvases/index.json")?;
        Ok(self.snapshot.clone())
    }

    /// Deletes one non-final registered Canvas pair and selects its neighbor.
    ///
    /// # Errors
    /// Returns an error for final/missing Canvases, conflicts, or commit failure.
    pub fn delete_canvas(
        &mut self,
        canvas_id: &str,
    ) -> Result<(String, ProjectSnapshot), ProjectError> {
        validate_canvas_id(canvas_id)?;
        let order = self.ready_order()?;
        if order.len() <= 1 {
            return Err(ProjectError::service(
                "canvas_registry_invalid",
                "Cannot delete the final canvas.",
            ));
        }
        let index = order.iter().position(|id| id == canvas_id).ok_or_else(|| {
            ProjectError::service(
                "canvas_registry_invalid",
                format!("Canvas is not in registry: {canvas_id}"),
            )
        })?;
        let paths = debrute_project_paths(&self.root, &self.debrute_home);
        let map_path = paths.canvas_maps_dir.join(format!("{canvas_id}.yaml"));
        let canvas_path = paths.canvases_dir.join(format!("{canvas_id}.json"));
        let next_order: Vec<_> = order
            .iter()
            .filter(|id| id.as_str() != canvas_id)
            .cloned()
            .collect();
        let active = order
            .get(index + 1)
            .or_else(|| {
                index
                    .checked_sub(1)
                    .and_then(|previous| order.get(previous))
            })
            .cloned()
            .ok_or_else(|| {
                ProjectError::service(
                    "canvas_registry_invalid",
                    "Cannot select an active Canvas after deletion.",
                )
            })?;
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-registry".to_owned(),
            reads: vec![
                ProjectDocumentRead {
                    absolute_path: paths.canvas_index_file.clone(),
                    expected_hash: self.required_registry_hash()?,
                },
                ProjectDocumentRead {
                    absolute_path: map_path.clone(),
                    expected_hash: Some(self.required_canvas_map_hash(canvas_id)?),
                },
                ProjectDocumentRead {
                    absolute_path: canvas_path.clone(),
                    expected_hash: Some(self.required_canvas_hash(canvas_id)?),
                },
            ],
            writes: vec![ProjectDocumentWrite {
                absolute_path: paths.canvas_index_file,
                content: json_pretty(&CanvasRegistryDocument {
                    canvas_order: next_order.clone(),
                })?,
            }],
            deletes: vec![
                ProjectDocumentDelete {
                    absolute_path: map_path,
                },
                ProjectDocumentDelete {
                    absolute_path: canvas_path,
                },
            ],
        })?;
        self.finish_committed_change(".debrute/canvases/index.json")?;
        Ok((active, self.snapshot.clone()))
    }

    /// Rebuilds Canvas metadata from valid Canvas Maps.
    ///
    /// # Errors
    /// Returns an error when a valid Map cannot be pushed or the repair cannot commit.
    pub fn repair_canvas_registry(&mut self) -> Result<(String, ProjectSnapshot), ProjectError> {
        let paths = debrute_project_paths(&self.root, &self.debrute_home);
        let inventory = CanvasRegistryRepairInventory {
            map_directory_hash: project_document_directory_hash(&paths.canvas_maps_dir)?,
            canvas_directory_hash: project_document_directory_hash(&paths.canvases_dir)?,
            map_files: read_canvas_metadata_files(&paths.canvas_maps_dir, ".yaml", None)?,
            canvas_files: read_canvas_metadata_files(
                &paths.canvases_dir,
                ".json",
                Some("index.json"),
            )?,
        };
        let project_files = list_project_files(&self.root)?;

        let valid_canvases = inventory
            .canvas_files
            .iter()
            .filter_map(|file| {
                let canvas = serde_json::from_slice::<CanvasDocument>(&file.content).ok()?;
                (canvas.id == file.id && validate_canvas_document(&canvas).is_ok())
                    .then_some((file.id.clone(), canvas))
            })
            .collect::<HashMap<_, _>>();
        let valid_maps = inventory
            .map_files
            .iter()
            .filter_map(|file| {
                let content = std::str::from_utf8(&file.content).ok()?;
                let source_path = canvas_map_path(&file.id).ok()?;
                let map = parse_canvas_map(&file.id, &source_path, content).ok()?;
                expand_canvas_map(&map, &project_files).ok()?;
                Some((file.id.clone(), content.to_owned()))
            })
            .collect::<HashMap<_, _>>();

        let mut ids: Vec<_> = valid_maps.keys().cloned().collect();
        ids.sort();
        let mut writes = Vec::new();
        for id in &ids {
            let base = valid_canvases
                .get(id)
                .cloned()
                .unwrap_or(create_canvas_document(id)?);
            let rebuilt = self.prepare_canvas_map(&base, &valid_maps[id], &project_files)?;
            if valid_canvases.get(id) != Some(&rebuilt) {
                writes.push(ProjectDocumentWrite {
                    absolute_path: paths.canvases_dir.join(format!("{id}.json")),
                    content: json_pretty(&rebuilt)?,
                });
            }
        }
        if ids.is_empty() {
            ids.push("canvas-1".to_owned());
            writes.extend([
                ProjectDocumentWrite {
                    absolute_path: paths.canvas_maps_dir.join("canvas-1.yaml"),
                    content: EMPTY_CANVAS_MAP.to_owned(),
                },
                ProjectDocumentWrite {
                    absolute_path: paths.canvases_dir.join("canvas-1.json"),
                    content: json_pretty(&create_canvas_document("canvas-1")?)?,
                },
            ]);
        }
        writes.push(ProjectDocumentWrite {
            absolute_path: paths.canvas_index_file.clone(),
            content: json_pretty(&CanvasRegistryDocument {
                canvas_order: ids.clone(),
            })?,
        });

        commit_canvas_registry_repair(&self.root, &paths, &inventory, &valid_maps, writes)?;
        self.finish_committed_change(".debrute/canvases/index.json")?;
        Ok((ids[0].clone(), self.snapshot.clone()))
    }

    /// Applies manual layout updates and returns the resulting projection.
    ///
    /// # Errors
    /// Returns an error for missing state, projection failure, conflicts, or commit failure.
    pub fn update_canvas_layouts(
        &mut self,
        canvas_id: &str,
        updates: &[CanvasNodeLayoutUpdate],
    ) -> Result<(CanvasDocument, CanvasProjection, bool), ProjectError> {
        self.update_visual_canvas(canvas_id, |canvas| {
            update_canvas_node_layouts(canvas, updates)
        })
    }

    /// Raises one Canvas node to the front of its stack.
    ///
    /// # Errors
    /// Returns an error for missing nodes, projection failure, conflicts, or commit failure.
    pub fn bring_canvas_node_to_front(
        &mut self,
        canvas_id: &str,
        path: &str,
    ) -> Result<(CanvasDocument, CanvasProjection, bool), ProjectError> {
        self.update_visual_canvas(canvas_id, |canvas| bring_canvas_node_to_front(canvas, path))
    }

    /// Persists video playback updates for one Canvas.
    ///
    /// # Errors
    /// Returns an error for invalid targets, projection failure, conflicts, or commit failure.
    pub fn update_canvas_video_playback(
        &mut self,
        canvas_id: &str,
        updates: &[CanvasVideoPlaybackUpdate],
    ) -> Result<(CanvasDocument, CanvasProjection, bool), ProjectError> {
        self.update_visual_canvas(canvas_id, |canvas| {
            update_canvas_video_playback(canvas, updates)
        })
    }

    /// Persists text viewport updates for one Canvas.
    ///
    /// # Errors
    /// Returns an error for invalid targets, projection failure, conflicts, or commit failure.
    pub fn update_canvas_text_viewports(
        &mut self,
        canvas_id: &str,
        updates: &[CanvasTextViewportUpdate],
    ) -> Result<(CanvasDocument, CanvasProjection, bool), ProjectError> {
        self.update_visual_canvas(canvas_id, |canvas| {
            update_canvas_text_viewports(canvas, updates)
        })
    }

    /// Validates and pushes one Canvas Map source into its Canvas document.
    ///
    /// # Errors
    /// Returns an error for invalid maps, conflicts, layout failure, or commit failure.
    pub fn push_canvas_map(&mut self, canvas_id: &str) -> Result<ProjectSnapshot, ProjectError> {
        let (source_path, content) = self.read_canvas_map(canvas_id)?;
        let canvas = self.required_canvas(canvas_id)?.clone();
        let files = list_project_files(&self.root)?;
        let next = self.prepare_canvas_map(&canvas, &content, &files)?;
        let canvas_path = debrute_project_paths(&self.root, &self.debrute_home)
            .canvases_dir
            .join(format!("{canvas_id}.json"));
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-map".to_owned(),
            reads: vec![
                ProjectDocumentRead {
                    absolute_path: source_path,
                    expected_hash: Some(project_content_hash(&content)),
                },
                ProjectDocumentRead {
                    absolute_path: canvas_path.clone(),
                    expected_hash: Some(self.required_canvas_hash(canvas_id)?),
                },
            ],
            writes: vec![ProjectDocumentWrite {
                absolute_path: canvas_path,
                content: json_pretty(&next)?,
            }],
            deletes: Vec::new(),
        })?;
        self.finish_committed_change(&format!(".debrute/canvases/{canvas_id}.json"))?;
        Ok(self.snapshot.clone())
    }

    /// Adds one existing Project path rule and atomically pushes the Canvas Map.
    ///
    /// # Errors
    /// Returns an error for invalid targets, drift, conflicts, or commit failure.
    pub fn add_project_path_to_canvas_map(
        &mut self,
        canvas_id: &str,
        project_relative_path: &str,
    ) -> Result<(CanvasDocument, CanvasProjection, String), ProjectError> {
        let relative = super::normalize_project_relative_path(project_relative_path)?;
        let absolute = resolve_existing_project_path(&self.root, &relative).map_err(|_| {
            ProjectError::service(
                "canvas_map_target_missing",
                format!("Canvas Map target path is missing: {relative}"),
            )
        })?;
        let metadata = fs::metadata(&absolute)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(ProjectError::service(
                "canvas_map_target_missing",
                format!("Canvas Map target path must be a file or directory: {relative}"),
            ));
        }
        let (source_path, content) = self.read_canvas_map(canvas_id)?;
        let current_source_hash = project_content_hash(&content);
        if self.required_canvas_map_hash(canvas_id)? != current_source_hash {
            return Err(ProjectError::service(
                "canvas_map_conflict",
                "Canvas Map changed since the last successful push. Push the map, then retry.",
            ));
        }
        let rule = if metadata.is_dir() {
            format!("{relative}/")
        } else {
            relative.clone()
        };
        let next_content = serialize_canvas_map_with_rule(&content, &rule)?;
        let current = self.required_canvas(canvas_id)?.clone();
        let next =
            self.prepare_canvas_map(&current, &next_content, &list_project_files(&self.root)?)?;
        let canvas_path = debrute_project_paths(&self.root, &self.debrute_home)
            .canvases_dir
            .join(format!("{canvas_id}.json"));
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-map".to_owned(),
            reads: vec![
                ProjectDocumentRead {
                    absolute_path: source_path.clone(),
                    expected_hash: Some(current_source_hash),
                },
                ProjectDocumentRead {
                    absolute_path: canvas_path.clone(),
                    expected_hash: Some(self.required_canvas_hash(canvas_id)?),
                },
            ],
            writes: vec![
                ProjectDocumentWrite {
                    absolute_path: source_path,
                    content: next_content,
                },
                ProjectDocumentWrite {
                    absolute_path: canvas_path,
                    content: json_pretty(&next)?,
                },
            ],
            deletes: Vec::new(),
        })?;
        self.finish_committed_change(&format!(".debrute/canvas-maps/{canvas_id}.yaml"))?;
        let canvas = self.required_canvas(canvas_id)?.clone();
        let projection = self.required_projection(canvas_id)?.clone();
        Ok((canvas, projection, relative))
    }

    /// Clears manual layout for all nodes or a selected path-rule expansion.
    ///
    /// # Errors
    /// Returns an error for invalid rules, missing state, conflicts, or commit failure.
    pub fn reset_canvas_layout(
        &mut self,
        canvas_id: &str,
        rules: Option<&CanvasMapPathRuleSet>,
    ) -> Result<(CanvasDocument, CanvasProjection, usize), ProjectError> {
        let current = self.required_canvas(canvas_id)?.clone();
        let files = list_project_files(&self.root)?;
        let reset_paths = rules
            .map(|rules| {
                expand_canvas_map_path_rules(rules, &files).map(|nodes| {
                    nodes
                        .into_iter()
                        .map(|node| node.project_relative_path)
                        .collect::<BTreeSet<_>>()
                })
            })
            .transpose()?;
        let (cleared, count) = clear_canvas_manual_layouts(&current, reset_paths.as_ref());
        let (source_path, content) = self.read_canvas_map(canvas_id)?;
        let next = self.prepare_canvas_map(&cleared, &content, &files)?;
        let canvas_path = debrute_project_paths(&self.root, &self.debrute_home)
            .canvases_dir
            .join(format!("{canvas_id}.json"));
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-map".to_owned(),
            reads: vec![
                ProjectDocumentRead {
                    absolute_path: source_path,
                    expected_hash: Some(project_content_hash(&content)),
                },
                ProjectDocumentRead {
                    absolute_path: canvas_path.clone(),
                    expected_hash: Some(self.required_canvas_hash(canvas_id)?),
                },
            ],
            writes: vec![ProjectDocumentWrite {
                absolute_path: canvas_path,
                content: json_pretty(&next)?,
            }],
            deletes: Vec::new(),
        })?;
        self.finish_committed_change(&format!(".debrute/canvases/{canvas_id}.json"))?;
        Ok((
            self.required_canvas(canvas_id)?.clone(),
            self.required_projection(canvas_id)?.clone(),
            count,
        ))
    }

    fn update_visual_canvas(
        &mut self,
        canvas_id: &str,
        mutate: impl FnOnce(&CanvasDocument) -> Result<CanvasDocument, ProjectError>,
    ) -> Result<(CanvasDocument, CanvasProjection, bool), ProjectError> {
        let current = self.required_canvas(canvas_id)?.clone();
        let current_projection = self.required_projection(canvas_id)?.clone();
        let next = mutate(&current)?;
        if next == current {
            return Ok((current, current_projection, false));
        }
        validate_canvas_document(&next)?;
        let projection = project_canvas_with_known_projection(&next, &current_projection)?;
        self.write_canvas("canvas", &next)?;
        self.snapshot.canvases = self
            .snapshot
            .canvases
            .iter()
            .map(|canvas| {
                if canvas.id == canvas_id {
                    next.clone()
                } else {
                    canvas.clone()
                }
            })
            .collect();
        self.snapshot.projections = self
            .snapshot
            .projections
            .iter()
            .map(|current| {
                if current.canvas_id == canvas_id {
                    projection.clone()
                } else {
                    current.clone()
                }
            })
            .collect();
        Ok((next, projection, true))
    }

    fn load_snapshot(
        &mut self,
        write_canvas_changes: bool,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let metadata = read_project_metadata(&self.root, &self.debrute_home)?;
        let files = list_project_files(&self.root)?;
        let (canvases, document_diagnostics) = self.load_canvas_documents()?;
        let mut feedback_diagnostics = Vec::new();
        match read_canvas_feedback_state(&self.root, crate::now_rfc3339()).and_then(|state| {
            validate_canvas_feedback_document(&state.document)?;
            validate_feedback_media_targets(&state.document)?;
            Ok(state)
        }) {
            Ok(state) => {
                self.feedback_document = state.document;
                self.feedback_hash = state.content_hash;
                self.feedback_valid = true;
            }
            Err(error) => {
                self.feedback_hash = None;
                self.feedback_valid = false;
                feedback_diagnostics.push(document_diagnostic(
                    "document.invalid_canvas_feedback".to_owned(),
                    "document_invalid_canvas_feedback",
                    error.to_string(),
                    &self.root.join(super::CANVAS_FEEDBACK_PROJECT_PATH),
                    Some(super::CANVAS_FEEDBACK_PROJECT_PATH.to_owned()),
                    ProjectDiagnosticSeverity::Error,
                ));
            }
        }
        let mut canvas_map_diagnostics = Vec::new();
        let registry = self.read_registry()?;
        let registry = match current_canvas_map_ids(&self.root, &self.debrute_home) {
            Ok(maps) => validate_registry_pairs(registry, &canvases, &maps),
            Err(error) => CanvasRegistryState::Invalid {
                code: "canvas_registry_invalid".to_owned(),
                message: error.to_string(),
            },
        };
        let mut ordered = Vec::new();
        if let CanvasRegistryState::Ready { canvas_order } = &registry {
            let by_id: HashMap<_, _> = canvases
                .into_iter()
                .map(|canvas| (canvas.id.clone(), canvas))
                .collect();
            ordered = canvas_order
                .iter()
                .filter_map(|id| by_id.get(id).cloned())
                .collect();
            ordered = self.synchronize_canvas_maps(
                ordered,
                &files,
                write_canvas_changes,
                &mut canvas_map_diagnostics,
            )?;
        }
        let mut projections = Vec::new();
        if matches!(registry, CanvasRegistryState::Ready { .. }) {
            for canvas in &ordered {
                let projection =
                    self.project_canvas_document(canvas, canvas_map_diagnostics.clone());
                projections.push(projection);
            }
        }
        let mut unique = HashMap::new();
        for diagnostic in document_diagnostics
            .into_iter()
            .chain(feedback_diagnostics)
            .chain(self.feedback_render_diagnostics.values().cloned())
            .chain(canvas_map_diagnostics)
            .chain(
                projections
                    .iter()
                    .flat_map(|projection| projection.diagnostics.clone()),
            )
        {
            unique.insert(diagnostic.id.clone(), diagnostic);
        }
        let mut diagnostics: Vec<_> = unique.into_values().collect();
        diagnostics.sort_by(|left, right| left.id.cmp(&right.id));
        let health = project_health(&metadata, ordered.len(), &diagnostics, &self.debrute_home);
        Ok(ProjectSnapshot {
            project_root: self.root.to_string_lossy().into_owned(),
            metadata,
            files,
            canvases: ordered,
            projections,
            diagnostics,
            canvas_registry: registry,
            health,
        })
    }

    fn load_snapshot_transactional(
        &mut self,
        write_canvas_changes: bool,
    ) -> Result<ProjectSnapshot, ProjectError> {
        let previous_registry_hash = self.registry_hash.clone();
        let previous_canvas_hashes = self.canvas_hashes.clone();
        let previous_canvas_map_hashes = self.canvas_map_hashes.clone();
        let previous_feedback_document = self.feedback_document.clone();
        let previous_feedback_hash = self.feedback_hash.clone();
        let previous_feedback_valid = self.feedback_valid;
        match self.load_snapshot(write_canvas_changes) {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                self.registry_hash = previous_registry_hash;
                self.canvas_hashes = previous_canvas_hashes;
                self.canvas_map_hashes = previous_canvas_map_hashes;
                self.feedback_document = previous_feedback_document;
                self.feedback_hash = previous_feedback_hash;
                self.feedback_valid = previous_feedback_valid;
                Err(error)
            }
        }
    }

    fn load_canvas_documents(
        &mut self,
    ) -> Result<(Vec<CanvasDocument>, Vec<ProjectDiagnostic>), ProjectError> {
        let mut files: Vec<_> = list_project_files(&self.root)?
            .into_iter()
            .filter_map(|entry| {
                if entry.project_relative_path == CANVAS_INDEX_FILE {
                    return None;
                }
                let id = entry
                    .project_relative_path
                    .strip_prefix(".debrute/canvases/")?
                    .strip_suffix(".json")?
                    .to_owned();
                if id.contains('/') {
                    return None;
                }
                Some((entry, id))
            })
            .collect();
        files.sort_by(|left, right| {
            left.0
                .project_relative_path
                .cmp(&right.0.project_relative_path)
        });
        self.canvas_hashes.clear();
        let mut canvases = Vec::new();
        let mut diagnostics = Vec::new();
        for (file, id) in files {
            let path = self.root.join(&file.project_relative_path);
            match fs::read_to_string(&path)
                .map_err(ProjectError::from)
                .and_then(|content| {
                    let canvas: CanvasDocument = serde_json::from_str(&content)?;
                    validate_canvas_document(&canvas)?;
                    if canvas.id != id {
                        return Err(ProjectError::Validation(format!(
                            "Canvas document id must match file name: {}",
                            path.display()
                        )));
                    }
                    self.canvas_hashes
                        .insert(canvas.id.clone(), project_content_hash(content.as_bytes()));
                    Ok(canvas)
                }) {
                Ok(canvas) => canvases.push(canvas),
                Err(error) => diagnostics.push(document_diagnostic(
                    format!("document.invalid_pushed:{id}"),
                    "document_invalid_pushed",
                    error.to_string(),
                    &path,
                    Some(id),
                    ProjectDiagnosticSeverity::Error,
                )),
            }
        }
        Ok((canvases, diagnostics))
    }

    fn read_registry(&mut self) -> Result<CanvasRegistryState, ProjectError> {
        let path = debrute_project_paths(&self.root, &self.debrute_home).canvas_index_file;
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.registry_hash = None;
                return Ok(CanvasRegistryState::Invalid {
                    code: "canvas_registry_missing".to_owned(),
                    message: "Canvas registry is missing.".to_owned(),
                });
            }
            Err(error) => return Err(error.into()),
        };
        match serde_json::from_str::<CanvasRegistryDocument>(&content)
            .map_err(ProjectError::from)
            .and_then(|document| validate_registry_document(&document).map(|()| document))
        {
            Ok(document) => {
                self.registry_hash = Some(project_content_hash(content));
                Ok(CanvasRegistryState::Ready {
                    canvas_order: document.canvas_order,
                })
            }
            Err(error) => {
                self.registry_hash = None;
                Ok(CanvasRegistryState::Invalid {
                    code: "canvas_registry_invalid".to_owned(),
                    message: error.to_string(),
                })
            }
        }
    }

    fn synchronize_canvas_maps(
        &mut self,
        canvases: Vec<CanvasDocument>,
        files: &[ProjectFileEntry],
        write_changes: bool,
        diagnostics: &mut Vec<ProjectDiagnostic>,
    ) -> Result<Vec<CanvasDocument>, ProjectError> {
        let mut result = Vec::new();
        let mut next_map_hashes = HashMap::new();
        let mut pending_reads = Vec::new();
        let mut pending_writes = Vec::new();
        let mut pending_canvas_hashes = Vec::new();
        for canvas in canvases {
            let source_relative = canvas_map_path(&canvas.id)?;
            let source_path = self.root.join(&source_relative);
            let Ok(content) = fs::read_to_string(&source_path) else {
                diagnostics.push(document_diagnostic(
                    format!("document.invalid-source:{}", canvas.id),
                    "document_invalid_source",
                    "Canvas Map source could not be read.".to_owned(),
                    &source_path,
                    Some(canvas.id.clone()),
                    ProjectDiagnosticSeverity::Error,
                ));
                result.push(canvas);
                continue;
            };
            match self.prepare_canvas_map(&canvas, &content, files) {
                Ok(next) => {
                    let source_hash = project_content_hash(&content);
                    next_map_hashes.insert(canvas.id.clone(), source_hash.clone());
                    if next.node_elements == canvas.node_elements {
                        result.push(canvas);
                    } else if write_changes {
                        let canvas_path = debrute_project_paths(&self.root, &self.debrute_home)
                            .canvases_dir
                            .join(format!("{}.json", canvas.id));
                        let serialized = json_pretty(&next)?;
                        pending_reads.extend([
                            ProjectDocumentRead {
                                absolute_path: source_path.clone(),
                                expected_hash: Some(source_hash),
                            },
                            ProjectDocumentRead {
                                absolute_path: canvas_path.clone(),
                                expected_hash: Some(self.required_canvas_hash(&canvas.id)?),
                            },
                        ]);
                        pending_writes.push(ProjectDocumentWrite {
                            absolute_path: canvas_path,
                            content: serialized.clone(),
                        });
                        pending_canvas_hashes
                            .push((canvas.id.clone(), project_content_hash(serialized)));
                        result.push(next);
                    } else {
                        diagnostics.push(document_diagnostic(
                            format!("document.drift:{}", canvas.id),
                            "document_drift",
                            format!(
                                "Canvas Map has changes that have not been pushed: {source_relative}"
                            ),
                            &source_path,
                            Some(canvas.id.clone()),
                            ProjectDiagnosticSeverity::Warning,
                        ));
                        result.push(canvas);
                    }
                }
                Err(error) if error.code().starts_with("canvas_map_") => {
                    let mut diagnostic = document_diagnostic(
                        format!("document.invalid-source:{}", canvas.id),
                        "document_invalid_source",
                        error.to_string(),
                        &source_path,
                        Some(canvas.id.clone()),
                        ProjectDiagnosticSeverity::Error,
                    );
                    diagnostic.line = error.field("line").and_then(|line| line.parse().ok());
                    diagnostic.column =
                        error.field("column").and_then(|column| column.parse().ok());
                    diagnostics.push(diagnostic);
                    result.push(canvas);
                }
                Err(error) => return Err(error),
            }
        }
        if !pending_writes.is_empty() {
            commit_project_document_transaction(&ProjectDocumentTransaction {
                project_root: self.root.clone(),
                owner: "canvas-map".to_owned(),
                reads: pending_reads,
                writes: pending_writes,
                deletes: Vec::new(),
            })?;
            for (canvas_id, hash) in pending_canvas_hashes {
                self.canvas_hashes.insert(canvas_id, hash);
            }
        }
        self.canvas_map_hashes = next_map_hashes;
        Ok(result)
    }

    fn prepare_canvas_map(
        &self,
        canvas: &CanvasDocument,
        content: &str,
        files: &[ProjectFileEntry],
    ) -> Result<CanvasDocument, ProjectError> {
        let source_path = canvas_map_path(&canvas.id)?;
        let map = parse_canvas_map(&canvas.id, &source_path, content)?;
        let expanded = expand_canvas_map(&map, files)?;
        let (desired, rows) = desired_canvas_map_projection(&self.root, &expanded)?;
        let node_elements =
            reconcile_canvas_nodes(&canvas.node_elements, &desired, &rows, |node| {
                self.node_adapter
                    .layout_size(&self.root, node)
                    .map_err(|error| {
                        ProjectError::service_with_fields(
                            "canvas_map_invalid_path",
                            format!(
                                "Canvas Map path could not be laid out: {}: {error}",
                                node.project_relative_path
                            ),
                            [(
                                "project_relative_path".to_owned(),
                                node.project_relative_path.clone(),
                            )],
                        )
                    })
            })?;
        let mut result = canvas.clone();
        result.node_elements = node_elements;
        Ok(result)
    }

    fn project_canvas_document(
        &self,
        canvas: &CanvasDocument,
        diagnostics: Vec<ProjectDiagnostic>,
    ) -> CanvasProjection {
        let mut inspections = HashMap::new();
        for node in &canvas.node_elements {
            inspections.insert(
                node.project_relative_path.clone(),
                self.inspect_canvas_node(node),
            );
        }
        let mut projection = project_canvas(canvas, diagnostics, |node| {
            inspections.get(&node.project_relative_path).map_or_else(
                || CanvasNodeAvailability::Unreadable {
                    message: format!(
                        "Canvas node availability is not loaded: {}",
                        node.project_relative_path
                    ),
                },
                |(availability, _)| availability.clone(),
            )
        });
        for node in &mut projection.nodes {
            if node.node.media_kind == Some(CanvasMediaKind::Video)
                && matches!(node.availability, CanvasNodeAvailability::Available { .. })
            {
                let presentation = inspections
                    .get(&node.node.project_relative_path)
                    .and_then(|(_, presentation)| presentation.clone());
                if let Some(presentation) = presentation {
                    node.video_presentation = Some(presentation);
                } else {
                    node.availability = CanvasNodeAvailability::Unreadable {
                        message: format!(
                            "Canvas video presentation is unavailable: {}",
                            node.node.project_relative_path
                        ),
                    };
                }
            }
        }
        projection
    }

    fn inspect_canvas_node(
        &self,
        node: &CanvasNodeElement,
    ) -> (CanvasNodeAvailability, Option<CanvasVideoPresentation>) {
        let (metadata, mtime_ms) = match self.inspect_canvas_metadata(node) {
            Ok(inspected) => inspected,
            Err(availability) => return (availability, None),
        };
        if node.node_kind == CanvasNodeKind::Directory {
            if !metadata.is_dir() {
                return (
                    CanvasNodeAvailability::Unreadable {
                        message: format!(
                            "Project path is not a directory: {}",
                            node.project_relative_path
                        ),
                    },
                    None,
                );
            }
            return (
                CanvasNodeAvailability::Available {
                    size: 0,
                    mime_type: "inode/directory".to_owned(),
                    file_url: String::new(),
                    canvas_image_previewable: None,
                    canvas_image_preview_source_width: None,
                    mtime_ms: Some(mtime_ms),
                    revision: project_file_revision(0, mtime_ms),
                },
                None,
            );
        }
        if !metadata.is_file() {
            return (
                CanvasNodeAvailability::Unreadable {
                    message: format!("Project path is not a file: {}", node.project_relative_path),
                },
                None,
            );
        }
        let (preview, presentation) = match self.inspect_node_adapter_data(node) {
            Ok(data) => data,
            Err(availability) => return (availability, None),
        };
        let mime_type = match project_mime_type(&self.root, node) {
            Ok(mime_type) => mime_type,
            Err(error) => {
                return (
                    CanvasNodeAvailability::Unreadable {
                        message: error.to_string(),
                    },
                    None,
                );
            }
        };
        (
            CanvasNodeAvailability::Available {
                size: metadata.len(),
                mime_type,
                file_url: String::new(),
                canvas_image_previewable: preview.map(|(previewable, _)| previewable),
                canvas_image_preview_source_width: preview.and_then(|(_, width)| width),
                mtime_ms: Some(mtime_ms),
                revision: project_file_revision(metadata.len(), mtime_ms),
            },
            presentation,
        )
    }

    fn inspect_canvas_metadata(
        &self,
        node: &CanvasNodeElement,
    ) -> Result<(fs::Metadata, f64), CanvasNodeAvailability> {
        let absolute = resolve_existing_project_path(&self.root, &node.project_relative_path)
            .map_err(|error| CanvasNodeAvailability::Unreadable {
                message: error.to_string(),
            })?;
        let metadata = fs::metadata(absolute).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CanvasNodeAvailability::Missing {
                    message: format!("Project path is missing: {}", node.project_relative_path),
                }
            } else {
                CanvasNodeAvailability::Unreadable {
                    message: error.to_string(),
                }
            }
        })?;
        let mtime_ms = metadata
            .modified()
            .and_then(|modified| {
                modified
                    .duration_since(UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            })
            .map_err(|error| CanvasNodeAvailability::Unreadable {
                message: error.to_string(),
            })?
            .as_secs_f64()
            * 1000.0;
        Ok((metadata, mtime_ms))
    }

    fn inspect_node_adapter_data(
        &self,
        node: &CanvasNodeElement,
    ) -> Result<CanvasNodeAdapterData, CanvasNodeAvailability> {
        let preview = if node.media_kind == Some(CanvasMediaKind::Image) {
            self.node_adapter
                .image_preview_info(&self.root, &node.project_relative_path)
                .map_err(|error| unreadable_adapter_error(&error))?
        } else {
            None
        };
        let presentation = if node.media_kind == Some(CanvasMediaKind::Video) {
            self.node_adapter
                .video_presentation(&self.root, &node.project_relative_path)
                .map_err(|error| unreadable_adapter_error(&error))?
        } else {
            None
        };
        Ok((preview, presentation))
    }

    fn write_canvas(&mut self, owner: &str, canvas: &CanvasDocument) -> Result<(), ProjectError> {
        let path = debrute_project_paths(&self.root, &self.debrute_home)
            .canvases_dir
            .join(format!("{}.json", canvas.id));
        let content = json_pretty(canvas)?;
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: owner.to_owned(),
            reads: vec![ProjectDocumentRead {
                absolute_path: path.clone(),
                expected_hash: Some(self.required_canvas_hash(&canvas.id)?),
            }],
            writes: vec![ProjectDocumentWrite {
                absolute_path: path,
                content: content.clone(),
            }],
            deletes: Vec::new(),
        })?;
        self.canvas_hashes
            .insert(canvas.id.clone(), project_content_hash(content));
        Ok(())
    }

    fn write_registry(&mut self, order: &[String]) -> Result<(), ProjectError> {
        let path = debrute_project_paths(&self.root, &self.debrute_home).canvas_index_file;
        let content = json_pretty(&CanvasRegistryDocument {
            canvas_order: order.to_vec(),
        })?;
        commit_project_document_transaction(&ProjectDocumentTransaction {
            project_root: self.root.clone(),
            owner: "canvas-registry".to_owned(),
            reads: vec![ProjectDocumentRead {
                absolute_path: path.clone(),
                expected_hash: self.required_registry_hash()?,
            }],
            writes: vec![ProjectDocumentWrite {
                absolute_path: path,
                content: content.clone(),
            }],
            deletes: Vec::new(),
        })?;
        self.registry_hash = Some(project_content_hash(content));
        Ok(())
    }

    fn read_canvas_map(&self, canvas_id: &str) -> Result<(PathBuf, String), ProjectError> {
        let relative = canvas_map_path(canvas_id)?;
        let absolute = resolve_existing_project_path(&self.root, &relative).map_err(|_| {
            ProjectError::service(
                "canvas_map_read_failed",
                "Canvas Map source could not be read.",
            )
        })?;
        let content = fs::read_to_string(&absolute).map_err(|_| {
            ProjectError::service(
                "canvas_map_read_failed",
                "Canvas Map source could not be read.",
            )
        })?;
        Ok((absolute, content))
    }

    fn ready_order(&self) -> Result<Vec<String>, ProjectError> {
        match &self.snapshot.canvas_registry {
            CanvasRegistryState::Ready { canvas_order } => Ok(canvas_order.clone()),
            CanvasRegistryState::Invalid { code, message } => Err(ProjectError::service(
                match code.as_str() {
                    "canvas_registry_missing" => "canvas_registry_missing",
                    _ => "canvas_registry_invalid",
                },
                message,
            )),
        }
    }

    fn required_registry_hash(&self) -> Result<Option<String>, ProjectError> {
        self.registry_hash.clone().map(Some).ok_or_else(|| {
            ProjectError::service(
                "canvas_registry_conflict",
                "Canvas registry changed on disk. Refresh or repair before retrying.",
            )
        })
    }

    fn required_canvas_hash(&self, canvas_id: &str) -> Result<String, ProjectError> {
        self.canvas_hashes.get(canvas_id).cloned().ok_or_else(|| {
            ProjectError::service(
                "canvas_map_canvas_missing",
                format!("Canvas document hash is not loaded: {canvas_id}"),
            )
        })
    }

    fn required_canvas_map_hash(&self, canvas_id: &str) -> Result<String, ProjectError> {
        self.canvas_map_hashes
            .get(canvas_id)
            .cloned()
            .ok_or_else(|| {
                ProjectError::service(
                    "canvas_map_conflict",
                    "Canvas Map changed since the last successful push. Push the map, then retry.",
                )
            })
    }

    fn required_canvas(&self, canvas_id: &str) -> Result<&CanvasDocument, ProjectError> {
        self.snapshot
            .canvases
            .iter()
            .find(|canvas| canvas.id == canvas_id)
            .ok_or_else(|| {
                ProjectError::service(
                    "canvas_map_canvas_missing",
                    format!("Canvas JSON is missing: .debrute/canvases/{canvas_id}.json"),
                )
            })
    }

    fn required_projection(&self, canvas_id: &str) -> Result<&CanvasProjection, ProjectError> {
        self.snapshot
            .projections
            .iter()
            .find(|projection| projection.canvas_id == canvas_id)
            .ok_or_else(|| {
                ProjectError::Validation(format!("Canvas projection is not loaded: {canvas_id}"))
            })
    }
}

fn initialize_project_if_missing(root: &Path, debrute_home: &Path) -> Result<(), ProjectError> {
    let paths = debrute_project_paths(root, debrute_home);
    let cache_dir = resolve_no_symlink_project_path_for_write(root, ".debrute/cache")?;
    fs::create_dir_all(&cache_dir)?;
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(cache_dir.join(".gitignore"))
    {
        Ok(mut file) => {
            std::io::Write::write_all(&mut file, b"*\n!.gitignore\n")?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    match fs::metadata(&paths.project_file) {
        Ok(_) => {
            read_project_metadata(root, debrute_home)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(resolve_no_symlink_project_path_for_write(
                root,
                ".debrute/canvases",
            )?)?;
            let now = crate::now_rfc3339();
            let name = root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Untitled Project")
                .to_owned();
            let metadata = DebruteProjectMetadata {
                project: DebruteProjectIdentity {
                    id: Uuid::new_v4().to_string(),
                    name,
                    created_at: now.clone(),
                    updated_at: now,
                },
            };
            write_json_atomic(&paths.project_file, &metadata)
        }
        Err(error) => Err(error.into()),
    }
}

fn ensure_default_canvas(root: &Path, debrute_home: &Path) -> Result<(), ProjectError> {
    let paths = debrute_project_paths(root, debrute_home);
    resolve_no_symlink_project_path_for_write(root, ".debrute/canvases")?;
    let has_canvas = has_canvas_metadata_file(&paths.canvases_dir, ".json", Some("index.json"))?;
    let has_map = has_canvas_metadata_file(&paths.canvas_maps_dir, ".yaml", None)?;
    let has_registry = match fs::symlink_metadata(&paths.canvas_index_file) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if has_canvas || has_map || has_registry {
        return Ok(());
    }
    let canvas = create_canvas_document("canvas-1")?;
    commit_project_document_transaction(&ProjectDocumentTransaction {
        project_root: root.to_path_buf(),
        owner: "canvas-registry".to_owned(),
        reads: vec![
            ProjectDocumentRead {
                absolute_path: paths.canvas_maps_dir.join("canvas-1.yaml"),
                expected_hash: None,
            },
            ProjectDocumentRead {
                absolute_path: paths.canvases_dir.join("canvas-1.json"),
                expected_hash: None,
            },
            ProjectDocumentRead {
                absolute_path: paths.canvas_index_file.clone(),
                expected_hash: None,
            },
        ],
        writes: vec![
            ProjectDocumentWrite {
                absolute_path: paths.canvas_maps_dir.join("canvas-1.yaml"),
                content: EMPTY_CANVAS_MAP.to_owned(),
            },
            ProjectDocumentWrite {
                absolute_path: paths.canvases_dir.join("canvas-1.json"),
                content: json_pretty(&canvas)?,
            },
            ProjectDocumentWrite {
                absolute_path: paths.canvas_index_file,
                content: json_pretty(&CanvasRegistryDocument {
                    canvas_order: vec!["canvas-1".to_owned()],
                })?,
            },
        ],
        deletes: Vec::new(),
    })
}

fn has_canvas_metadata_file(
    directory: &Path,
    suffix: &str,
    excluded_name: Option<&str>,
) -> Result<bool, ProjectError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.ends_with(suffix) && excluded_name != Some(name) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_canvas_metadata_files(
    directory: &Path,
    suffix: &str,
    excluded_name: Option<&str>,
) -> Result<Vec<CanvasMetadataFile>, ProjectError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if excluded_name == Some(name) {
            continue;
        }
        let Some(id) = name.strip_suffix(suffix) else {
            continue;
        };
        let path = entry.path();
        result.push(CanvasMetadataFile {
            id: id.to_owned(),
            content: fs::read(&path)?,
            path,
        });
    }
    result.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(result)
}

fn commit_canvas_registry_repair(
    project_root: &Path,
    paths: &DebruteProjectPaths,
    inventory: &CanvasRegistryRepairInventory,
    valid_maps: &HashMap<String, String>,
    writes: Vec<ProjectDocumentWrite>,
) -> Result<(), ProjectError> {
    let write_paths = writes
        .iter()
        .map(|write| write.absolute_path.clone())
        .collect::<HashSet<_>>();
    let deletes = inventory
        .map_files
        .iter()
        .filter(|file| !valid_maps.contains_key(&file.id))
        .map(|file| file.path.clone())
        .chain(
            inventory
                .canvas_files
                .iter()
                .filter(|file| !valid_maps.contains_key(&file.id))
                .map(|file| file.path.clone()),
        )
        .filter(|path| !write_paths.contains(path))
        .map(|absolute_path| ProjectDocumentDelete { absolute_path })
        .collect::<Vec<_>>();
    let mut reads = inventory
        .map_files
        .iter()
        .chain(&inventory.canvas_files)
        .map(|file| ProjectDocumentRead {
            absolute_path: file.path.clone(),
            expected_hash: Some(project_content_hash(&file.content)),
        })
        .collect::<Vec<_>>();
    reads.push(ProjectDocumentRead {
        absolute_path: paths.canvas_index_file.clone(),
        expected_hash: project_document_file_hash(&paths.canvas_index_file)?,
    });
    reads.extend([
        ProjectDocumentRead {
            absolute_path: paths.canvas_maps_dir.clone(),
            expected_hash: inventory.map_directory_hash.clone(),
        },
        ProjectDocumentRead {
            absolute_path: paths.canvases_dir.clone(),
            expected_hash: inventory.canvas_directory_hash.clone(),
        },
    ]);
    let existing_reads = reads
        .iter()
        .map(|read| read.absolute_path.clone())
        .collect::<HashSet<_>>();
    reads.extend(
        write_paths
            .iter()
            .filter(|path| !existing_reads.contains(*path))
            .map(|absolute_path| ProjectDocumentRead {
                absolute_path: absolute_path.clone(),
                expected_hash: None,
            }),
    );
    commit_project_document_transaction(&ProjectDocumentTransaction {
        project_root: project_root.to_owned(),
        owner: "canvas-registry".to_owned(),
        reads,
        writes,
        deletes,
    })
}

fn read_project_metadata(
    root: &Path,
    debrute_home: &Path,
) -> Result<DebruteProjectMetadata, ProjectError> {
    let metadata: DebruteProjectMetadata = serde_json::from_str(&fs::read_to_string(
        debrute_project_paths(root, debrute_home).project_file,
    )?)?;
    if !is_valid_stable_project_id(&metadata.project.id)
        || metadata.project.name.is_empty()
        || metadata.project.created_at.is_empty()
        || metadata.project.updated_at.is_empty()
    {
        return Err(ProjectError::Validation(
            "Invalid Debrute project metadata.".to_owned(),
        ));
    }
    Ok(metadata)
}

fn validate_registry_document(document: &CanvasRegistryDocument) -> Result<(), ProjectError> {
    let mut seen = HashSet::new();
    for id in &document.canvas_order {
        validate_canvas_id(id)?;
        if !seen.insert(id) {
            return Err(ProjectError::Validation(
                "Canvas registry contains duplicate canvas ids.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_registry_pairs(
    state: CanvasRegistryState,
    canvases: &[CanvasDocument],
    maps: &HashSet<String>,
) -> CanvasRegistryState {
    let CanvasRegistryState::Ready { canvas_order } = state else {
        return state;
    };
    let canvas_ids: HashSet<_> = canvases.iter().map(|canvas| canvas.id.as_str()).collect();
    let ordered: HashSet<_> = canvas_order.iter().map(String::as_str).collect();
    for id in &canvas_order {
        if !canvas_ids.contains(id.as_str()) || !maps.contains(id) {
            return CanvasRegistryState::Invalid {
                code: "canvas_registry_invalid".to_owned(),
                message: format!("Canvas registry references missing canvas: {id}"),
            };
        }
    }
    for id in canvas_ids {
        if !ordered.contains(id) {
            return CanvasRegistryState::Invalid {
                code: "canvas_registry_invalid".to_owned(),
                message: format!("Canvas registry is missing canvas: {id}"),
            };
        }
    }
    for id in maps {
        if !ordered.contains(id.as_str()) {
            return CanvasRegistryState::Invalid {
                code: "canvas_registry_invalid".to_owned(),
                message: format!("Canvas registry is missing Canvas Map: {id}"),
            };
        }
    }
    CanvasRegistryState::Ready { canvas_order }
}

fn current_canvas_map_ids(
    root: &Path,
    debrute_home: &Path,
) -> Result<HashSet<String>, ProjectError> {
    let directory = debrute_project_paths(root, debrute_home).canvas_maps_dir;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = HashSet::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(id) = name.strip_suffix(".yaml") {
            result.insert(id.to_owned());
        }
    }
    Ok(result)
}

fn desired_canvas_map_projection(
    project_root: &Path,
    expanded: &ExpandedCanvasMap,
) -> Result<(Vec<CanvasDesiredNode>, Vec<CanvasDesiredLayoutRow>), ProjectError> {
    Ok((
        expanded
            .nodes
            .iter()
            .map(|node| {
                Ok(CanvasDesiredNode {
                    project_relative_path: node.project_relative_path.clone(),
                    node_kind: node.node_kind,
                    media_kind: if node.node_kind == CanvasNodeKind::File {
                        Some(canvas_media_kind_for_project_file(
                            project_root,
                            &node.project_relative_path,
                        )?)
                    } else {
                        None
                    },
                })
            })
            .collect::<Result<Vec<_>, ProjectError>>()?,
        expanded
            .layout_rows
            .iter()
            .map(|row| CanvasDesiredLayoutRow {
                parent_project_relative_path: row.parent_project_relative_path.clone(),
                member_project_relative_paths: row.member_project_relative_paths.clone(),
            })
            .collect(),
    ))
}

fn canvas_media_kind_for_project_file(
    project_root: &Path,
    project_relative_path: &str,
) -> Result<CanvasMediaKind, ProjectError> {
    let kind = canvas_media_kind_from_path(project_relative_path);
    if kind != CanvasMediaKind::Unknown {
        return Ok(kind);
    }
    let absolute = resolve_existing_project_path(project_root, project_relative_path)?;
    let first_line = read_text_classification_line(&absolute)?;
    Ok(
        if first_line.as_deref().is_some_and(|line| {
            project_text_file_type_for_path(project_relative_path, Some(line)).is_some()
        }) {
            CanvasMediaKind::Text
        } else {
            CanvasMediaKind::Unknown
        },
    )
}

fn assert_complete_permutation(input: &[String], existing: &[String]) -> Result<(), ProjectError> {
    if input.len() != existing.len() {
        return Err(ProjectError::service(
            "canvas_registry_invalid",
            "Canvas order must include every canvas exactly once.",
        ));
    }
    let expected: HashSet<_> = existing.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    for id in input {
        validate_canvas_id(id)?;
        if !expected.contains(id.as_str()) || !seen.insert(id) {
            return Err(ProjectError::service(
                "canvas_registry_invalid",
                "Canvas order must be a complete canvas id permutation.",
            ));
        }
    }
    Ok(())
}

fn next_canvas_id(ids: &[String]) -> String {
    let maximum = ids
        .iter()
        .filter_map(|id| id.strip_prefix("canvas-")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("canvas-{}", maximum + 1)
}

fn project_health(
    metadata: &DebruteProjectMetadata,
    canvas_count: usize,
    diagnostics: &[ProjectDiagnostic],
    debrute_home: &Path,
) -> ProjectHealthSummary {
    ProjectHealthSummary {
        project_name: metadata.project.name.clone(),
        canvas_count,
        diagnostic_counts: ProjectDiagnosticCounts {
            errors: diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == ProjectDiagnosticSeverity::Error)
                .count(),
            warnings: diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == ProjectDiagnosticSeverity::Warning)
                .count(),
        },
        runtime_data_location: debrute_home.join("runtime").to_string_lossy().into_owned(),
        checked_at: crate::now_rfc3339(),
    }
}

fn document_diagnostic(
    id: String,
    code: &str,
    message: String,
    file_path: &Path,
    entity_id: Option<String>,
    severity: ProjectDiagnosticSeverity,
) -> ProjectDiagnostic {
    ProjectDiagnostic {
        id,
        severity,
        code: code.to_owned(),
        message,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        line: None,
        column: None,
        entity_id,
    }
}

fn unreadable_adapter_error(error: &ProjectError) -> CanvasNodeAvailability {
    CanvasNodeAvailability::Unreadable {
        message: error.to_string(),
    }
}

fn json_pretty(value: &impl serde::Serialize) -> Result<String, ProjectError> {
    Ok(format!("{}\n", serde_json::to_string_pretty(value)?))
}

fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, json_pretty(value)?)?;
        replace_file(&temporary, path)?;
        Ok::<(), ProjectError>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn generic_layout_size(path: &str) -> CanvasLayoutSize {
    let name = if path.is_empty() {
        "Project Root"
    } else {
        path.rsplit('/').next().unwrap_or(path)
    };
    let label_width: u32 = name
        .chars()
        .map(|character| {
            if is_full_width(character as u32) {
                16
            } else {
                8
            }
        })
        .sum();
    let width = (24 + 8 + 24 + label_width).clamp(180, 720);
    CanvasLayoutSize {
        width: f64::from(width * 10),
        height: 640.0,
    }
}

fn is_full_width(code: u32) -> bool {
    matches!(code,
        0x1100..=0x115f
        | 0x2e80..=0xa4cf
        | 0xac00..=0xd7a3
        | 0xf900..=0xfaff
        | 0xfe10..=0xfe19
        | 0xfe30..=0xfe6f
        | 0xff00..=0xff60
        | 0xffe0..=0xffe6
        | 0x1f300..=0x1faff
    )
}

fn project_mime_type(root: &Path, node: &CanvasNodeElement) -> Result<String, ProjectError> {
    let path = &node.project_relative_path;
    let lower = path.to_ascii_lowercase();
    for (extensions, mime) in [
        (&[".png"][..], "image/png"),
        (&[".jpg", ".jpeg", ".jpe", ".jfif"], "image/jpeg"),
        (&[".webp"], "image/webp"),
        (&[".avif"], "image/avif"),
        (&[".tif", ".tiff"], "image/tiff"),
        (&[".svg", ".svgz"], "image/svg+xml"),
        (&[".mp4"], "video/mp4"),
        (&[".webm"], "video/webm"),
        (&[".mov"], "video/quicktime"),
        (&[".m4v"], "video/x-m4v"),
        (&[".mp3"], "audio/mpeg"),
        (&[".wav", ".wave"], "audio/wav"),
        (&[".ogg", ".oga", ".opus"], "audio/ogg"),
        (&[".m4a", ".aac"], "audio/mp4"),
        (&[".flac"], "audio/flac"),
        (&[".weba"], "audio/webm"),
    ] {
        if extensions
            .iter()
            .any(|extension| lower.ends_with(extension))
        {
            return Ok(mime.to_owned());
        }
    }
    if node.media_kind == Some(CanvasMediaKind::Text) {
        let absolute = resolve_existing_project_path(root, path)?;
        let first_line = read_text_classification_line(&absolute)?;
        return Ok(project_text_file_type_for_path(path, first_line.as_deref())
            .map_or("text/plain", |(_, mime_type)| mime_type)
            .to_owned());
    }
    Ok("text/plain".to_owned())
}

fn read_text_classification_line(path: &Path) -> Result<Option<String>, ProjectError> {
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(4096);
    file.by_ref().take(4096).read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Ok(None);
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    Ok(Some(
        content
            .split(['\r', '\n'])
            .next()
            .unwrap_or_default()
            .to_owned(),
    ))
}
