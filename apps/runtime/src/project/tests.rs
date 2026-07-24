use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Barrier, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use fs2::FileExt;
use serde_json::json;
use uuid::Uuid;

use super::*;

#[test]
fn stable_project_ids_are_safe_opaque_route_segments() {
    assert!(is_valid_stable_project_id("project-01.alpha_beta~gamma"));
    assert!(!is_valid_stable_project_id(""));
    assert!(!is_valid_stable_project_id("."));
    assert!(!is_valid_stable_project_id(".."));
    assert!(!is_valid_stable_project_id("../project"));
    assert!(!is_valid_stable_project_id("project/id"));
    assert!(!is_valid_stable_project_id(&"a".repeat(257)));
}

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("debrute-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temporary directory should be created");
        Self(path)
    }
}

impl AsRef<Path> for TemporaryDirectory {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn feedback_artifacts() -> Arc<CanvasFeedbackArtifacts> {
    let workers = crate::workers::RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new(
        &workers,
        MediaToolPaths::unavailable(),
    ));
    Arc::new(CanvasFeedbackArtifacts::new(previews).expect("feedback scheduler should start"))
}

fn project_registry(
    home: impl Into<PathBuf>,
    node_adapter: Arc<dyn ProjectNodeAdapter>,
) -> ProjectSessionRegistry {
    ProjectSessionRegistry::new(home, node_adapter, feedback_artifacts())
}

fn next_project_event(subscription: &mut ProjectSubscription, context: &str) -> ProjectEvent {
    let ProjectStreamItem::Event(event) = subscription.recv().expect(context) else {
        panic!("{context}");
    };
    event
}

fn apply_feedback_diagnostics(
    session: &ProjectSession,
    subscription: &mut ProjectSubscription,
    update: &CanvasFeedbackDiagnosticUpdate,
    expected_revision: u64,
    context: &str,
) -> ProjectEvent {
    session
        .apply_canvas_feedback_diagnostics(update)
        .expect(context);
    let event = next_project_event(subscription, context);
    assert_eq!(event.project_revision, expected_revision);
    event
}

struct FixedNodeAdapter;

impl ProjectNodeAdapter for FixedNodeAdapter {
    fn layout_size(
        &self,
        _project_root: &Path,
        _node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        Ok(CanvasLayoutSize {
            width: 1000.0,
            height: 500.0,
        })
    }

    fn video_presentation(
        &self,
        _project_root: &Path,
        _project_relative_path: &str,
    ) -> Result<Option<CanvasVideoPresentation>, ProjectError> {
        Ok(Some(CanvasVideoPresentation {
            kind: CanvasVideoPresentationKind::Video,
            width: 100,
            height: 50,
            duration_seconds: None,
            text_tracks: Vec::new(),
        }))
    }
}

struct FailingLayoutAdapter;

impl ProjectNodeAdapter for FailingLayoutAdapter {
    fn layout_size(
        &self,
        _project_root: &Path,
        node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        if node.project_relative_path != "image.png" {
            return Ok(CanvasLayoutSize {
                width: 1000.0,
                height: 500.0,
            });
        }
        Err(ProjectError::Validation(format!(
            "fixture cannot inspect {}",
            node.project_relative_path
        )))
    }
}

struct AddingCanvasMapLayoutAdapter {
    map_path: PathBuf,
}

impl ProjectNodeAdapter for AddingCanvasMapLayoutAdapter {
    fn layout_size(
        &self,
        _project_root: &Path,
        _node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        fs::write(&self.map_path, "paths: []\n")
            .expect("concurrent Canvas Map fixture should be written");
        Ok(CanvasLayoutSize {
            width: 1000.0,
            height: 500.0,
        })
    }
}

#[derive(Default)]
struct BlockingAdapterGate {
    entered: Mutex<bool>,
    entered_ready: Condvar,
    released: Mutex<bool>,
    release_ready: Condvar,
}

struct BlockingSecondLayoutAdapter {
    calls: AtomicUsize,
    gate: Arc<BlockingAdapterGate>,
}

impl ProjectNodeAdapter for BlockingSecondLayoutAdapter {
    fn layout_size(
        &self,
        _project_root: &Path,
        _node: &CanvasDesiredNode,
    ) -> Result<CanvasLayoutSize, ProjectError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
            *self.gate.entered.lock().expect("gate should lock") = true;
            self.gate.entered_ready.notify_all();
            let mut released = self.gate.released.lock().expect("gate should lock");
            while !*released {
                released = self
                    .gate
                    .release_ready
                    .wait(released)
                    .expect("gate wait should succeed");
            }
        }
        Ok(CanvasLayoutSize {
            width: 1000.0,
            height: 500.0,
        })
    }
}

#[test]
fn visible_project_walk_excludes_internal_and_temporary_files() {
    let project = TemporaryDirectory::new("visible-walk");
    fs::create_dir_all(project.as_ref().join(".git")).expect("git directory should be created");
    fs::create_dir_all(project.as_ref().join(".debrute/cache"))
        .expect("cache directory should be created");
    fs::create_dir_all(project.as_ref().join("assets")).expect("assets should be created");
    fs::write(project.as_ref().join("assets/visible.txt"), "visible")
        .expect("visible file should be written");
    fs::write(
        project
            .as_ref()
            .join("assets/file.00000000-0000-4000-8000-000000000000.tmp"),
        "temporary",
    )
    .expect("temporary file should be written");

    let entries = list_project_files(project.as_ref()).expect("project walk should succeed");
    let paths = entries
        .into_iter()
        .map(|entry| entry.project_relative_path)
        .collect::<Vec<_>>();
    assert!(paths.contains(&"assets".to_owned()));
    assert!(paths.contains(&"assets/visible.txt".to_owned()));
    assert!(!paths.iter().any(|path| path.starts_with(".git")));
    assert!(!paths.iter().any(|path| path.starts_with(".debrute/cache")));
    assert!(
        !paths
            .iter()
            .any(|path| Path::new(path).extension().is_some_and(|ext| ext == "tmp"))
    );
}

#[test]
fn document_transactions_enforce_owner_and_compare_and_swap() {
    let project = TemporaryDirectory::new("documents");
    let home = TemporaryDirectory::new("documents-home");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("project should open");
    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    let original = fs::read_to_string(&paths.canvas_index_file).expect("registry should exist");

    let owner_error = commit_project_document_transaction(&ProjectDocumentTransaction {
        project_root: project.as_ref().to_path_buf(),
        owner: "canvas-map".to_owned(),
        reads: Vec::new(),
        writes: vec![ProjectDocumentWrite {
            absolute_path: paths.canvas_index_file.clone(),
            content: original.clone(),
        }],
        deletes: Vec::new(),
    })
    .expect_err("wrong owner must be rejected");
    assert_eq!(owner_error.code(), "document_descriptor_violation");

    fs::write(&paths.canvas_index_file, "{\"canvasOrder\":[]}")
        .expect("external edit should succeed");
    let conflict = commit_project_document_transaction(&ProjectDocumentTransaction {
        project_root: project.as_ref().to_path_buf(),
        owner: "canvas-registry".to_owned(),
        reads: vec![ProjectDocumentRead {
            absolute_path: paths.canvas_index_file.clone(),
            expected_hash: Some(project_content_hash(original)),
        }],
        writes: vec![ProjectDocumentWrite {
            absolute_path: paths.canvas_index_file.clone(),
            content: "{\"canvasOrder\":[\"canvas-1\"]}\n".to_owned(),
        }],
        deletes: Vec::new(),
    })
    .expect_err("stale hash must be rejected");
    assert_eq!(conflict.code(), "document_push_conflict");
    let lock_path =
        documents::project_document_lock_path(project.as_ref(), &paths.canvas_index_file);
    assert!(
        lock_path.exists(),
        "document lock rendezvous must be persistent"
    );
    assert!(lock_path.starts_with(project.as_ref().join(".debrute/cache/document-locks")));
    assert!(!PathBuf::from(format!("{}.lock", paths.canvas_index_file.display())).exists());
    service
        .refresh()
        .expect("service should remain refreshable");
}

#[cfg(unix)]
#[test]
fn project_open_rejects_internal_namespace_symlinks_before_external_writes() {
    use std::os::unix::fs::symlink;

    let home = TemporaryDirectory::new("internal-symlink-home");
    for protected_path in [".debrute", ".debrute/cache", ".debrute/canvases"] {
        let project = TemporaryDirectory::new("internal-symlink-project");
        let external = TemporaryDirectory::new("internal-symlink-external");
        let link = project.as_ref().join(protected_path);
        if let Some(parent) = link.parent() {
            fs::create_dir_all(parent).expect("link parent should exist");
        }
        symlink(external.as_ref(), &link).expect("protected symlink should be created");
        let Err(_) =
            ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
        else {
            panic!("Project internal writes must reject every symlink component");
        };
        assert_eq!(
            fs::read_dir(external.as_ref())
                .expect("external directory should remain readable")
                .count(),
            0,
            "Project open wrote through {protected_path}"
        );
    }
}

#[test]
fn uncertain_document_rollback_does_not_install_a_session_rejection_state() {
    let project = TemporaryDirectory::new("document-rollback");
    let home = TemporaryDirectory::new("document-rollback-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    documents::inject_document_rollback_failure_for_test();
    let error = opened
        .session
        .execute(ProjectCommand::CreateCanvas)
        .expect_err("uncertain document commit must fail");
    assert_eq!(error.code(), "document_push_rollback_failed");
    opened
        .session
        .execute(ProjectCommand::Refresh)
        .expect("a later explicit refresh should use the current filesystem state");
    assert!(opened.session.sync_snapshot().is_ok());
    let additional_use = registry
        .acquire_use(opened.session.project_id(), ProjectUseKind::Request)
        .expect("the live Project should continue admitting real uses");
    drop(additional_use);
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn canvas_feedback_mutation_is_revisioned_and_publishes_the_closed_change() {
    let project = TemporaryDirectory::new("feedback-command");
    let home = TemporaryDirectory::new("feedback-command-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let mut subscription = opened.session.subscribe().expect("stream should open");
    assert!(matches!(
        subscription.recv().expect("snapshot should arrive"),
        ProjectStreamItem::Snapshot(_)
    ));

    let result = opened
        .session
        .execute(ProjectCommand::UpdateCanvasFeedback {
            input: UpdateCanvasFeedbackEntryInput::SetMarks {
                project_relative_path: "images/cover.png".to_owned(),
                marks: vec![CanvasFeedbackMark::Important, CanvasFeedbackMark::Like],
            },
        })
        .expect("feedback should update");
    assert_eq!(result.project_revision, 2);
    let ProjectCommandResult::CanvasFeedbackUpdated { feedback } = result.value else {
        panic!("feedback command should return feedback");
    };
    assert_eq!(
        feedback.entries["images/cover.png"].marks,
        vec![CanvasFeedbackMark::Like, CanvasFeedbackMark::Important]
    );
    let ProjectStreamItem::Event(event) = subscription.recv().expect("event should arrive") else {
        panic!("feedback event should follow the snapshot");
    };
    assert!(matches!(
        event.change,
        ProjectChange::CanvasFeedbackChanged {
            affects_rendered_artifact: false,
            ..
        }
    ));
    let read = opened
        .session
        .canvas_feedback()
        .expect("feedback should be readable");
    assert_eq!(read.project_revision, 2);
    assert_eq!(read.value, feedback);
    assert!(
        project
            .as_ref()
            .join(CANVAS_FEEDBACK_PROJECT_PATH)
            .is_file()
    );

    subscription.release();
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn canvas_feedback_mutation_drives_real_artifact_generation_and_cleanup() {
    let project = TemporaryDirectory::new("feedback-artifact-integration");
    let home = TemporaryDirectory::new("feedback-artifact-integration-home");
    fs::create_dir_all(project.as_ref().join("images")).expect("image directory should exist");
    image::DynamicImage::new_rgba8(64, 48)
        .save(project.as_ref().join("images/cover.png"))
        .expect("fixture image should save");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let result = opened
        .session
        .execute(ProjectCommand::UpdateCanvasFeedback {
            input: UpdateCanvasFeedbackEntryInput::AddItem {
                project_relative_path: "images/cover.png".to_owned(),
                item: NewCanvasFeedbackItem {
                    id: "feedback-cover-pin".to_owned(),
                    created_at: "2026-07-15T01:02:03.004Z".to_owned(),
                    kind: CanvasFeedbackItemKind::Pin,
                    scope: CanvasFeedbackScope::File,
                    moment_time_seconds: None,
                    geometry: Some(CanvasFeedbackGeometry::Point { x: 0.5, y: 0.5 }),
                    comment: "Review".to_owned(),
                },
            },
        })
        .expect("feedback should update");
    let ProjectCommandResult::CanvasFeedbackUpdated { feedback } = result.value else {
        panic!("feedback result should be returned");
    };
    let item_id = feedback.entries["images/cover.png"].items[0].id.clone();
    let artifact = project
        .as_ref()
        .join(canvas_feedback_rendered_project_path("images/cover.png"));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !artifact.is_file() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        artifact.is_file(),
        "accepted feedback should render an artifact"
    );

    opened
        .session
        .execute(ProjectCommand::UpdateCanvasFeedback {
            input: UpdateCanvasFeedbackEntryInput::DeleteItem {
                project_relative_path: "images/cover.png".to_owned(),
                item_id,
            },
        })
        .expect("feedback item should delete");
    let deadline = Instant::now() + Duration::from_secs(3);
    while artifact.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !artifact.exists(),
        "obsolete feedback artifact should be removed"
    );

    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn canvas_feedback_render_diagnostics_are_deduplicated_revisioned_and_clearable() {
    let project = TemporaryDirectory::new("feedback-diagnostics");
    let home = TemporaryDirectory::new("feedback-diagnostics-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let mut subscription = opened.session.subscribe().expect("stream should open");
    let _ = subscription.recv().expect("snapshot should arrive");
    // Let the open-time empty-document reconciliation cross its diagnostic
    // barrier before testing direct diagnostic deduplication.
    let _ = subscription
        .recv_timeout(Duration::from_millis(100))
        .expect("stream should remain open");
    let diagnostic = ProjectDiagnostic {
        id: "canvas-feedback.render_failed:images/cover.png#M1".to_owned(),
        severity: ProjectDiagnosticSeverity::Error,
        code: "canvas-feedback.render_failed".to_owned(),
        message: "render failed".to_owned(),
        file_path: Some(
            project
                .as_ref()
                .join("images/cover.png")
                .to_string_lossy()
                .into_owned(),
        ),
        line: None,
        column: None,
        entity_id: Some("images/cover.png#M1".to_owned()),
    };
    let failed = CanvasFeedbackDiagnosticUpdate {
        diagnostics: vec![diagnostic],
        checked_project_relative_paths: vec!["images/cover.png#M1".to_owned()],
        checked_all_entries: false,
        retained_project_relative_paths: Vec::new(),
        resolved_diagnostic_ids: Vec::new(),
    };
    apply_feedback_diagnostics(
        &opened.session,
        &mut subscription,
        &failed,
        2,
        "diagnostic should apply and publish",
    );

    opened
        .session
        .apply_canvas_feedback_diagnostics(&failed)
        .expect("same diagnostic should be accepted as unchanged");
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .expect("stream should remain open")
            .is_none()
    );

    apply_feedback_diagnostics(
        &opened.session,
        &mut subscription,
        &CanvasFeedbackDiagnosticUpdate {
            diagnostics: Vec::new(),
            checked_project_relative_paths: vec!["images/cover.png".to_owned()],
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: Vec::new(),
        },
        3,
        "source-wide success should clear moment diagnostics",
    );

    subscription.release();
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn canvas_feedback_runtime_diagnostic_is_clearable_after_recovery() {
    let project = TemporaryDirectory::new("feedback-runtime-diagnostic");
    let home = TemporaryDirectory::new("feedback-runtime-diagnostic-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let mut subscription = opened.session.subscribe().expect("stream should open");
    let _ = subscription.recv().expect("snapshot should arrive");
    let _ = subscription
        .recv_timeout(Duration::from_millis(100))
        .expect("stream should remain open");

    apply_feedback_diagnostics(
        &opened.session,
        &mut subscription,
        &CanvasFeedbackDiagnosticUpdate {
            diagnostics: vec![ProjectDiagnostic {
                id: "canvas-feedback.runtime_failed".to_owned(),
                severity: ProjectDiagnosticSeverity::Error,
                code: "canvas-feedback.runtime_failed".to_owned(),
                message: "runtime failed".to_owned(),
                file_path: None,
                line: None,
                column: None,
                entity_id: None,
            }],
            checked_project_relative_paths: Vec::new(),
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: Vec::new(),
        },
        2,
        "runtime diagnostic should apply and publish",
    );

    let event = apply_feedback_diagnostics(
        &opened.session,
        &mut subscription,
        &CanvasFeedbackDiagnosticUpdate {
            diagnostics: Vec::new(),
            checked_project_relative_paths: Vec::new(),
            checked_all_entries: false,
            retained_project_relative_paths: Vec::new(),
            resolved_diagnostic_ids: vec!["canvas-feedback.runtime_failed".to_owned()],
        },
        3,
        "runtime recovery should apply and publish",
    );
    let ProjectChange::ProjectChanged(snapshot) = event.change else {
        panic!("runtime recovery should publish a complete Project snapshot");
    };
    assert!(
        !snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == "canvas-feedback.runtime_failed")
    );

    subscription.release();
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn post_commit_refresh_rollback_failure_does_not_install_a_rejection_layer() {
    let project = TemporaryDirectory::new("post-commit-refresh");
    let home = TemporaryDirectory::new("post-commit-refresh-home");
    fs::write(project.as_ref().join("scene.txt"), "scene").expect("fixture should be written");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "paths:\n  - scene.txt\n",
    )
    .expect("Canvas Map drift should be written");
    documents::inject_document_rollback_failure_for_test();
    let error = opened
        .session
        .execute(ProjectCommand::CreatePath {
            parent_project_relative_path: String::new(),
            name: "committed.txt".to_owned(),
            kind: ProjectPathKind::File,
        })
        .expect_err("uncertain post-commit refresh must fail");
    assert_eq!(error.code(), "document_push_rollback_failed");
    assert!(project.as_ref().join("committed.txt").is_file());
    opened
        .session
        .execute(ProjectCommand::Refresh)
        .expect("a later explicit refresh should reconcile the committed path");
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn watcher_refresh_rollback_failure_does_not_poison_later_refreshes() {
    let project = TemporaryDirectory::new("watch-refresh");
    let home = TemporaryDirectory::new("watch-refresh-home");
    fs::write(project.as_ref().join("scene.txt"), "scene").expect("fixture should be written");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "paths:\n  - scene.txt\n",
    )
    .expect("Canvas Map drift should be written");
    documents::inject_document_rollback_failure_for_test();
    let error = opened
        .session
        .apply_watched_change_for_test("scene.txt")
        .expect_err("uncertain watcher refresh must fail");
    assert_eq!(error.code(), "document_push_rollback_failed");
    let failed_revision = opened
        .session
        .sync_snapshot()
        .expect("failed refresh snapshot should remain readable")
        .project_revision;
    opened
        .session
        .apply_watched_change_for_test("scene.txt")
        .expect("the next watcher refresh should use the current filesystem state");
    assert!(
        opened
            .session
            .sync_snapshot()
            .expect("refreshed snapshot should remain readable")
            .project_revision
            >= failed_revision
    );
    opened
        .session
        .execute(ProjectCommand::Refresh)
        .expect("explicit refresh should remain available");
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn rollback_claim_preserves_a_concurrent_visible_replacement() {
    let project = TemporaryDirectory::new("rollback-claim-replacement");
    let target = project.as_ref().join("target.txt");
    fs::write(&target, "committed").expect("committed fixture should be written");
    let identity = debrute_native_fs::path_identity(&target)
        .expect("committed fixture identity should be readable");
    files::inject_visible_replacement_after_claim_for_test(&target, b"external replacement");
    let errors = files::remove_committed_paths_for_rollback_for_test(&[(target.clone(), identity)]);
    assert!(errors.is_empty(), "unexpected rollback errors: {errors:?}");
    assert_eq!(
        fs::read_to_string(target).expect("replacement should remain"),
        "external replacement"
    );
}

#[cfg(unix)]
#[test]
fn staged_identity_failure_cleans_every_managed_temporary_path() {
    use std::os::unix::fs::symlink;

    let project = TemporaryDirectory::new("stage-identity-cleanup");
    let first_stage = project.as_ref().join("first.stage.tmp");
    let invalid_stage = project.as_ref().join("invalid.stage.tmp");
    let external = project.as_ref().join("external.txt");
    fs::write(&first_stage, "first").expect("first stage should be written");
    fs::write(&external, "external").expect("symlink target should be written");
    symlink(&external, &invalid_stage).expect("invalid stage symlink should be created");
    let error = files::commit_staged_paths_for_test(&[
        (first_stage.clone(), project.as_ref().join("first.txt")),
        (invalid_stage.clone(), project.as_ref().join("invalid.txt")),
    ])
    .expect_err("stage identity validation must fail");
    assert!(matches!(
        error,
        ProjectError::Validation(_) | ProjectError::Io(_)
    ));
    assert!(!first_stage.exists(), "validated stage must be cleaned");
    assert!(
        fs::symlink_metadata(&invalid_stage).is_err(),
        "failing stage must also be cleaned"
    );
}

#[test]
fn watcher_backend_error_forces_a_full_project_refresh() {
    let project = TemporaryDirectory::new("watcher-backend-rescan");
    let home = TemporaryDirectory::new("watcher-backend-rescan-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let mut subscription = opened
        .session
        .subscribe()
        .expect("subscription should open");
    assert!(matches!(
        subscription.recv().expect("snapshot should arrive"),
        ProjectStreamItem::Snapshot(_)
    ));
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "unknown: true\n",
    )
    .expect("malformed hidden document should be written");
    opened
        .session
        .report_watcher_backend_error_for_test("injected dropped event")
        .expect("backend error should be queued");
    let ProjectStreamItem::Event(event) = subscription
        .recv_timeout(Duration::from_secs(5))
        .expect("stream should remain open")
        .expect("forced refresh should publish a delta")
    else {
        panic!("forced refresh must publish a delta");
    };
    let ProjectChange::ProjectChanged(snapshot) = event.change else {
        panic!("backend rescan must publish a complete Project change");
    };
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "document_invalid_source")
    );
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn canvas_map_parser_is_closed_and_expansion_uses_natural_order() {
    let invalid = parse_canvas_map(
        "canvas-1",
        ".debrute/canvas-maps/canvas-1.yaml",
        "paths:\n  - glob: '*.png'\n    future: true\n",
    )
    .expect_err("unknown glob object keys must be rejected");
    assert_eq!(invalid.code(), "canvas_map_invalid_yaml");

    let map = parse_canvas_map(
        "canvas-1",
        ".debrute/canvas-maps/canvas-1.yaml",
        "paths:\n  - glob: 'shot*.png'\n",
    )
    .expect("valid map should parse");
    let entries = ["shot10.png", "shot2.png", "shot1.png"]
        .into_iter()
        .map(|path| ProjectFileEntry {
            project_relative_path: path.to_owned(),
            kind: ProjectPathKind::File,
        })
        .collect::<Vec<_>>();
    let expanded = expand_canvas_map(&map, &entries).expect("map should expand");
    let paths = expanded
        .nodes
        .into_iter()
        .filter(|node| node.node_kind == CanvasNodeKind::File)
        .map(|node| node.project_relative_path)
        .collect::<Vec<_>>();
    assert_eq!(paths, ["shot1.png", "shot2.png", "shot10.png"]);
}

#[test]
fn canvas_document_json_matches_the_typescript_camel_case_format() {
    let fixture = r#"{
      "id": "canvas-1",
      "name": "Canvas 1",
      "nodeElements": [],
      "annotations": [],
      "preferences": { "showDiagnostics": true }
    }"#;
    let canvas: CanvasDocument =
        serde_json::from_str(fixture).expect("TypeScript Canvas JSON should deserialize");
    assert!(canvas.node_elements.is_empty());
    let serialized = serde_json::to_value(&canvas).expect("Canvas should serialize");
    assert!(serialized.get("nodeElements").is_some());
    assert!(serialized.get("node_elements").is_none());
}

#[test]
fn persisted_project_documents_reject_unexpected_fields_at_every_owned_boundary() {
    let canvas = json!({
        "id": "canvas-1",
        "name": "Canvas 1",
        "nodeElements": [{
            "projectRelativePath": "notes/scene.txt",
            "nodeKind": "file",
            "mediaKind": "text",
            "x": 0.0,
            "y": 0.0,
            "width": 320.0,
            "height": 180.0,
            "z": 0,
            "videoPlayback": { "currentTimeSeconds": 0.0 },
            "textViewport": { "scrollTop": 0.0, "scrollLeft": 0.0 }
        }],
        "annotations": [{ "id": "note-1", "text": "Note", "x": 0.0, "y": 0.0 }],
        "preferences": { "showDiagnostics": true }
    });
    for pointer in [
        "",
        "/nodeElements/0",
        "/nodeElements/0/videoPlayback",
        "/nodeElements/0/textViewport",
        "/annotations/0",
        "/preferences",
    ] {
        let mut invalid = canvas.clone();
        invalid
            .pointer_mut(pointer)
            .and_then(serde_json::Value::as_object_mut)
            .expect("fixture boundary should be an object")
            .insert("unexpectedField".to_owned(), json!(true));
        assert!(serde_json::from_value::<CanvasDocument>(invalid).is_err());
    }

    assert!(
        serde_json::from_value::<DebruteProjectMetadata>(json!({
            "project": {
                "id": "project-1",
                "name": "Project",
                "createdAt": "2026-07-21T00:00:00.000Z",
                "updatedAt": "2026-07-21T00:00:00.000Z",
                "unexpectedField": true
            }
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<CanvasRegistryDocument>(json!({
            "canvasOrder": ["canvas-1"],
            "unexpectedField": true
        }))
        .is_err()
    );
}

#[test]
fn invalid_owned_project_documents_follow_their_final_failure_paths() {
    let project = TemporaryDirectory::new("strict-project-documents");
    let home = TemporaryDirectory::new("strict-project-documents-home");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");

    let canvas_path = project.as_ref().join(".debrute/canvases/canvas-1.json");
    let mut canvas: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&canvas_path).expect("Canvas should exist"))
            .expect("Canvas should parse as JSON");
    canvas["unexpectedField"] = json!(true);
    fs::write(
        &canvas_path,
        serde_json::to_string_pretty(&canvas).expect("Canvas should serialize"),
    )
    .expect("invalid Canvas should write");
    let snapshot = service
        .refresh()
        .expect("invalid Canvas should be isolated");
    assert!(snapshot.canvases.is_empty());
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "document_invalid_pushed")
    );

    let registry_path = project.as_ref().join(".debrute/canvases/index.json");
    let mut registry: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&registry_path).expect("Canvas registry should exist"),
    )
    .expect("Canvas registry should parse as JSON");
    registry["unexpectedField"] = json!(true);
    fs::write(
        &registry_path,
        serde_json::to_string_pretty(&registry).expect("Canvas registry should serialize"),
    )
    .expect("invalid Canvas registry should write");
    let snapshot = service
        .refresh()
        .expect("invalid registry should be projected");
    assert!(matches!(
        snapshot.canvas_registry,
        CanvasRegistryState::Invalid { ref code, .. } if code == "canvas_registry_invalid"
    ));

    let metadata_path = project.as_ref().join(".debrute/project.json");
    let mut metadata: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&metadata_path).expect("Project metadata should exist"),
    )
    .expect("Project metadata should parse as JSON");
    metadata["unexpectedField"] = json!(true);
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata).expect("Project metadata should serialize"),
    )
    .expect("invalid Project metadata should write");
    drop(service);
    assert!(
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter),).is_err()
    );
}

#[test]
fn canvas_repair_rebuilds_from_valid_maps_and_removes_unrecoverable_metadata() {
    let project = TemporaryDirectory::new("canvas-repair");
    let home = TemporaryDirectory::new("canvas-repair-home");
    fs::write(project.as_ref().join("note.txt"), "note").expect("note should be written");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    service
        .add_project_path_to_canvas_map("canvas-1", "note.txt")
        .expect("Canvas Map should include the note");
    drop(service);

    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    fs::remove_file(paths.canvases_dir.join("canvas-1.json"))
        .expect("Canvas JSON should be removed");
    fs::write(
        paths.canvases_dir.join("orphan.json"),
        serde_json::to_string_pretty(
            &create_canvas_document("orphan").expect("orphan Canvas should be valid"),
        )
        .expect("orphan Canvas should serialize"),
    )
    .expect("orphan Canvas should be written");
    fs::write(paths.canvas_maps_dir.join("broken.yaml"), "unknown: true\n")
        .expect("invalid Map should be written");
    fs::write(paths.canvases_dir.join("broken.json"), "{")
        .expect("invalid Canvas should be written");

    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("partial Canvas state must not block the Project");
    assert!(
        service
            .snapshot()
            .files
            .iter()
            .any(|file| file.project_relative_path == "note.txt")
    );
    assert!(matches!(
        service.snapshot().canvas_registry,
        CanvasRegistryState::Invalid { .. }
    ));

    let (active, snapshot) = service
        .repair_canvas_registry()
        .expect("Repair should rebuild from the valid Canvas Map");
    assert_eq!(active, "canvas-1");
    assert!(matches!(
        snapshot.canvas_registry,
        CanvasRegistryState::Ready { ref canvas_order } if canvas_order == &["canvas-1"]
    ));
    assert!(
        snapshot.canvases[0]
            .node_elements
            .iter()
            .any(|node| node.project_relative_path == "note.txt")
    );
    assert!(!paths.canvases_dir.join("orphan.json").exists());
    assert!(!paths.canvas_maps_dir.join("broken.yaml").exists());
    assert!(!paths.canvases_dir.join("broken.json").exists());
}

#[test]
fn canvas_repair_creates_one_default_when_no_valid_map_remains() {
    let project = TemporaryDirectory::new("canvas-repair-default");
    let home = TemporaryDirectory::new("canvas-repair-default-home");
    let service = ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
        .expect("Project should initialize");
    drop(service);
    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    fs::write(
        paths.canvas_maps_dir.join("canvas-1.yaml"),
        "unknown: true\n",
    )
    .expect("invalid Map should be written");
    fs::write(paths.canvases_dir.join("canvas-1.json"), "{")
        .expect("invalid Canvas should be written");

    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("invalid Canvas metadata must not block the Project");
    let (active, snapshot) = service
        .repair_canvas_registry()
        .expect("Repair should create a default Canvas");
    assert_eq!(active, "canvas-1");
    assert_eq!(snapshot.canvases.len(), 1);
    assert!(snapshot.canvases[0].node_elements.is_empty());
    assert_eq!(
        fs::read_to_string(paths.canvas_maps_dir.join("canvas-1.yaml"))
            .expect("default Map should be readable"),
        "paths: []\n"
    );
}

#[test]
fn canvas_repair_prepares_every_valid_map_before_committing() {
    let project = TemporaryDirectory::new("canvas-repair-preflight");
    let home = TemporaryDirectory::new("canvas-repair-preflight-home");
    fs::write(project.as_ref().join("image.png"), "fixture").expect("fixture should be written");
    let mut setup =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    setup
        .add_project_path_to_canvas_map("canvas-1", "image.png")
        .expect("Canvas Map should include the image");
    drop(setup);

    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    fs::write(
        paths.canvases_dir.join("canvas-1.json"),
        serde_json::to_string_pretty(
            &create_canvas_document("canvas-1").expect("Canvas should be valid"),
        )
        .expect("Canvas should serialize"),
    )
    .expect("empty Canvas should be written");
    fs::write(&paths.canvas_index_file, "{").expect("invalid registry should be written");
    let registry_before = fs::read(&paths.canvas_index_file).expect("registry should be readable");

    let mut service = ProjectService::open(
        project.as_ref(),
        home.as_ref(),
        Arc::new(FailingLayoutAdapter),
    )
    .expect("invalid registry should remain repairable");
    let error = service
        .repair_canvas_registry()
        .expect_err("failed Map preparation must reject the repair");
    assert_eq!(error.code(), "canvas_map_invalid_path");
    assert_eq!(
        fs::read(&paths.canvas_index_file).expect("registry should remain readable"),
        registry_before,
        "repair must not commit the registry before every Map is prepared"
    );
}

#[test]
fn canvas_repair_rejects_canvas_directory_inventory_changes() {
    let project = TemporaryDirectory::new("canvas-repair-inventory");
    let home = TemporaryDirectory::new("canvas-repair-inventory-home");
    fs::write(project.as_ref().join("image.png"), "fixture").expect("fixture should be written");
    let mut setup =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    setup
        .add_project_path_to_canvas_map("canvas-1", "image.png")
        .expect("Canvas Map should include the image");
    drop(setup);

    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    fs::write(
        paths.canvases_dir.join("canvas-1.json"),
        serde_json::to_string_pretty(
            &create_canvas_document("canvas-1").expect("Canvas should be valid"),
        )
        .expect("Canvas should serialize"),
    )
    .expect("empty Canvas should be written");
    fs::write(&paths.canvas_index_file, "{").expect("invalid registry should be written");
    let registry_before = fs::read(&paths.canvas_index_file).expect("registry should be readable");
    let added_map = paths.canvas_maps_dir.join("canvas-2.yaml");

    let mut service = ProjectService::open(
        project.as_ref(),
        home.as_ref(),
        Arc::new(AddingCanvasMapLayoutAdapter {
            map_path: added_map.clone(),
        }),
    )
    .expect("invalid registry should remain repairable");
    let error = service
        .repair_canvas_registry()
        .expect_err("a Canvas Map added during repair must conflict");
    assert_eq!(error.code(), "document_push_conflict");
    assert!(added_map.exists());
    assert_eq!(
        fs::read(&paths.canvas_index_file).expect("registry should remain readable"),
        registry_before,
        "inventory conflict must not commit the registry"
    );
}

#[test]
fn canvas_map_yaml_errors_preserve_parser_location() {
    let error = parse_canvas_map(
        "canvas-1",
        ".debrute/canvas-maps/canvas-1.yaml",
        "paths:\n  - glob: [\n",
    )
    .expect_err("malformed YAML must fail");
    assert_eq!(error.code(), "canvas_map_invalid_yaml");
    assert!(error.field("line").is_some());
    assert!(error.field("column").is_some());

    let project = TemporaryDirectory::new("yaml-location");
    let home = TemporaryDirectory::new("yaml-location-home");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "paths:\n  - glob: [\n",
    )
    .expect("malformed Canvas Map should be written");
    let snapshot = service.refresh().expect("malformed map should be isolated");
    let diagnostic = snapshot
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "document_invalid_source")
        .expect("Canvas Map diagnostic should be projected");
    assert!(diagnostic.line.is_some());
    assert!(diagnostic.column.is_some());
}

#[test]
fn project_service_owns_canvas_registry_map_and_projection() {
    let project = TemporaryDirectory::new("service");
    let home = TemporaryDirectory::new("service-home");
    fs::create_dir_all(project.as_ref().join("notes")).expect("notes should be created");
    fs::write(project.as_ref().join("notes/scene.txt"), "scene").expect("note should be written");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("project should open");
    assert_eq!(service.snapshot().canvases.len(), 1);
    assert_eq!(service.snapshot().projections.len(), 1);

    let (_, projection, added) = service
        .add_project_path_to_canvas_map("canvas-1", "notes/scene.txt")
        .expect("file should be added to Canvas Map");
    assert_eq!(added, "notes/scene.txt");
    assert!(projection.nodes.iter().any(|node| {
        node.node.project_relative_path == "notes/scene.txt"
            && matches!(node.availability, CanvasNodeAvailability::Available { .. })
    }));

    let (second, _) = service
        .create_canvas()
        .expect("second Canvas should be created");
    service
        .rename_canvas(&second, "Storyboard")
        .expect("Canvas should be renamed");
    service
        .reorder_canvases(&[second.clone(), "canvas-1".to_owned()])
        .expect("Canvases should be reordered");
    let (active, snapshot) = service
        .delete_canvas(&second)
        .expect("non-final Canvas should be deleted");
    assert_eq!(active, "canvas-1");
    assert_eq!(snapshot.canvases.len(), 1);
    assert_eq!(
        service
            .delete_canvas("canvas-1")
            .expect_err("final Canvas must remain")
            .code(),
        "canvas_registry_invalid"
    );
}

#[test]
fn canvas_document_validation_rejects_duplicate_and_hidden_node_paths() {
    let project = TemporaryDirectory::new("canvas-node-identity");
    let home = TemporaryDirectory::new("canvas-node-identity-home");
    fs::write(project.as_ref().join("note.txt"), "note").expect("note should be written");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    let (mut canvas, _, _) = service
        .add_project_path_to_canvas_map("canvas-1", "note.txt")
        .expect("Canvas node should be created");
    canvas.node_elements.push(canvas.node_elements[0].clone());
    assert!(
        validate_canvas_document(&canvas)
            .expect_err("duplicate node identity must fail")
            .to_string()
            .contains("duplicate")
    );
    canvas.node_elements.pop();
    canvas.node_elements[0].project_relative_path = ".debrute/cache/hidden.txt".to_owned();
    validate_canvas_document(&canvas).expect_err("hidden Project path must fail");
}

#[test]
fn interactive_canvas_updates_reject_inexact_batches_without_partial_changes() {
    let mut canvas = create_canvas_document("canvas-1").expect("Canvas should be valid");
    canvas.node_elements = vec![
        CanvasNodeElement {
            project_relative_path: "note.txt".to_owned(),
            node_kind: CanvasNodeKind::File,
            media_kind: Some(CanvasMediaKind::Text),
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
            z: 0,
            layout_mode: None,
            video_playback: None,
            text_viewport: None,
        },
        CanvasNodeElement {
            project_relative_path: "clip.mp4".to_owned(),
            node_kind: CanvasNodeKind::File,
            media_kind: Some(CanvasMediaKind::Video),
            x: 400.0,
            y: 0.0,
            width: 320.0,
            height: 180.0,
            z: 1,
            layout_mode: None,
            video_playback: None,
            text_viewport: None,
        },
    ];

    let duplicate_layout = update_canvas_node_layouts(
        &canvas,
        &[
            CanvasNodeLayoutUpdate {
                project_relative_path: "note.txt".to_owned(),
                x: 10.0,
                y: 20.0,
                width: None,
                height: None,
            },
            CanvasNodeLayoutUpdate {
                project_relative_path: "note.txt".to_owned(),
                x: 30.0,
                y: 40.0,
                width: None,
                height: None,
            },
        ],
    )
    .expect_err("duplicate layout targets must fail");
    assert!(duplicate_layout.to_string().contains("duplicate target"));
    assert!(canvas.node_elements[0].x.abs() < f64::EPSILON);

    let missing_video = update_canvas_video_playback(
        &canvas,
        &[
            CanvasVideoPlaybackUpdate {
                project_relative_path: "clip.mp4".to_owned(),
                current_time_seconds: 1.5,
            },
            CanvasVideoPlaybackUpdate {
                project_relative_path: "missing.mp4".to_owned(),
                current_time_seconds: 2.0,
            },
        ],
    )
    .expect_err("one missing video target must reject the batch");
    assert!(missing_video.to_string().contains("missing.mp4"));
    assert!(canvas.node_elements[1].video_playback.is_none());

    let wrong_text_kind = update_canvas_text_viewports(
        &canvas,
        &[CanvasTextViewportUpdate {
            project_relative_path: "clip.mp4".to_owned(),
            scroll_top: 10.0,
            scroll_left: 0.0,
        }],
    )
    .expect_err("a non-text target must fail");
    assert!(wrong_text_kind.to_string().contains("not a text node"));
}

#[test]
fn canvas_loader_ignores_nested_json_and_keeps_document_errors_project_local() {
    let project = TemporaryDirectory::new("canvas-loader-domain");
    let home = TemporaryDirectory::new("canvas-loader-domain-home");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    let canvases = project.as_ref().join(".debrute/canvases");
    fs::create_dir_all(canvases.join("nested")).expect("nested directory should be created");
    fs::write(
        canvases.join("nested/shadow.json"),
        serde_json::to_string(&create_canvas_document("shadow").expect("Canvas should be valid"))
            .expect("Canvas should serialize"),
    )
    .expect("nested Canvas-shaped JSON should be written");
    fs::write(canvases.join("broken.json"), "{").expect("invalid Canvas should be written");

    let snapshot = service
        .refresh()
        .expect("invalid documents should be isolated");
    assert!(snapshot.canvases.iter().all(|canvas| canvas.id != "shadow"));
    let invalid_id = "document.invalid_pushed:broken";
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.id == invalid_id)
    );
    assert!(snapshot.projections.iter().all(|projection| {
        projection
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.id != invalid_id)
    }));
}

#[test]
fn canvas_map_layout_failures_remain_canvas_local_diagnostics() {
    let project = TemporaryDirectory::new("layout-diagnostic");
    let home = TemporaryDirectory::new("layout-diagnostic-home");
    fs::write(project.as_ref().join("image.png"), "fixture").expect("fixture should be written");
    let mut setup =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    setup
        .add_project_path_to_canvas_map("canvas-1", "image.png")
        .expect("Canvas Map should be seeded");
    drop(setup);

    let mut service = ProjectService::open(
        project.as_ref(),
        home.as_ref(),
        Arc::new(FailingLayoutAdapter),
    )
    .expect("adapter failure must not reject the Project");
    let diagnostic = service
        .snapshot()
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == "document_invalid_source")
        .expect("Canvas-local diagnostic should be present");
    assert!(
        diagnostic.message.contains("image.png"),
        "unexpected diagnostic: {diagnostic:?}"
    );
    let canvas_path = project.as_ref().join(".debrute/canvases/canvas-1.json");
    let before = fs::read(&canvas_path).expect("Canvas should be readable");
    let error = service
        .push_canvas_map("canvas-1")
        .expect_err("explicit push should report the typed Canvas Map error");
    assert_eq!(error.code(), "canvas_map_invalid_path");
    assert_eq!(
        fs::read(canvas_path).expect("Canvas should remain readable"),
        before,
        "failed push must not write the Canvas document"
    );
}

#[test]
fn multi_canvas_refresh_commits_projection_drift_as_one_transaction() {
    let project = TemporaryDirectory::new("multi-canvas-atomic");
    let home = TemporaryDirectory::new("multi-canvas-atomic-home");
    fs::write(project.as_ref().join("one.txt"), "one").expect("fixture should be written");
    fs::write(project.as_ref().join("two.txt"), "two").expect("fixture should be written");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    service
        .create_canvas()
        .expect("second Canvas should be created");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "paths:\n  - one.txt\n",
    )
    .expect("first map should drift");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-2.yaml"),
        "paths:\n  - two.txt\n",
    )
    .expect("second map should drift");
    let first_canvas = project.as_ref().join(".debrute/canvases/canvas-1.json");
    let second_canvas = project.as_ref().join(".debrute/canvases/canvas-2.json");
    let first_before = fs::read(&first_canvas).expect("first Canvas should be readable");
    let second_before = fs::read(&second_canvas).expect("second Canvas should be readable");
    let blocking_lock = documents::project_document_lock_path(project.as_ref(), &second_canvas);
    fs::create_dir_all(blocking_lock.parent().expect("lock should have a parent"))
        .expect("lock directory should exist");
    let blocking_handle = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&blocking_lock)
        .expect("conflicting lock should open");
    blocking_handle
        .lock_exclusive()
        .expect("conflicting lock should be held");

    let error = service
        .refresh()
        .expect_err("one lock conflict must reject the full projection transaction");
    assert_eq!(error.code(), "document_push_conflict");
    assert_eq!(
        fs::read(first_canvas).expect("first Canvas should remain"),
        first_before
    );
    assert_eq!(
        fs::read(second_canvas).expect("second Canvas should remain"),
        second_before
    );
    blocking_handle
        .unlock()
        .expect("fixture lock should release");
    drop(blocking_handle);
    fs::remove_file(blocking_lock).expect("fixture lock should be removed");
}

#[test]
fn failed_refresh_restores_snapshot_and_all_compare_and_swap_hashes() {
    let project = TemporaryDirectory::new("refresh-hash-rollback");
    let home = TemporaryDirectory::new("refresh-hash-rollback-home");
    fs::write(project.as_ref().join("one.txt"), "one").expect("fixture should be written");
    let mut service =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    service
        .create_canvas()
        .expect("second Canvas should be created");
    let paths = debrute_project_paths(project.as_ref(), home.as_ref());
    fs::write(
        &paths.canvas_index_file,
        "{\"canvasOrder\":[\"canvas-2\",\"canvas-1\"]}\n",
    )
    .expect("external registry order should be written");
    fs::write(
        project.as_ref().join(".debrute/canvas-maps/canvas-1.yaml"),
        "paths:\n  - one.txt\n",
    )
    .expect("Canvas Map should drift");
    let canvas_path = project.as_ref().join(".debrute/canvases/canvas-1.json");
    let lock_path = documents::project_document_lock_path(project.as_ref(), &canvas_path);
    fs::create_dir_all(lock_path.parent().expect("lock should have a parent"))
        .expect("lock directory should exist");
    let lock_handle = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .expect("conflicting lock should open");
    lock_handle
        .lock_exclusive()
        .expect("conflicting lock should be held");
    let refresh_error = service
        .refresh()
        .expect_err("projection conflict should fail refresh");
    assert_eq!(refresh_error.code(), "document_push_conflict");
    lock_handle.unlock().expect("fixture lock should release");
    drop(lock_handle);
    fs::remove_file(lock_path).expect("fixture lock should be removed");

    let reorder_error = service
        .reorder_canvases(&["canvas-1".to_owned(), "canvas-2".to_owned()])
        .expect_err("restored old registry hash must detect the external edit");
    assert_eq!(reorder_error.code(), "document_push_conflict");
}

#[test]
fn project_file_mutations_validate_then_apply_closed_batches() {
    let project = TemporaryDirectory::new("file-mutations");
    fs::create_dir_all(project.as_ref().join("source")).expect("source should be created");
    fs::create_dir_all(project.as_ref().join("target")).expect("target should be created");
    fs::write(project.as_ref().join("source/one.txt"), "one")
        .expect("source file should be written");

    let created = create_project_path(
        project.as_ref(),
        "target",
        "draft.txt",
        ProjectPathKind::File,
    )
    .expect("file should be created");
    let opened = read_project_text_file(project.as_ref(), &created.project_relative_path, None)
        .expect("text file should open");
    let saved = write_project_text_file(
        project.as_ref(),
        &created.project_relative_path,
        "draft",
        &opened.revision,
    )
    .expect("text file should save");
    assert_eq!(saved.content, "draft");
    assert_eq!(
        write_project_text_file(
            project.as_ref(),
            &created.project_relative_path,
            "stale",
            &opened.revision,
        )
        .expect_err("stale text revision must fail")
        .code(),
        "project_file_revision_conflict"
    );

    let renamed = rename_project_path(project.as_ref(), "target/draft.txt", "note.txt")
        .expect("file should rename");
    assert_eq!(renamed.project_relative_path, "target/note.txt");
    let copied = copy_project_paths(
        project.as_ref(),
        &[ProjectPathBatchEntry {
            project_relative_path: "source/one.txt".to_owned(),
            kind: ProjectPathKind::File,
        }],
        "target",
    )
    .expect("file should copy");
    assert_eq!(copied[0].project_relative_path, "target/one.txt");
    let moved = move_project_paths(
        project.as_ref(),
        &[ProjectPathBatchEntry {
            project_relative_path: "target/one.txt".to_owned(),
            kind: ProjectPathKind::File,
        }],
        "source",
        true,
    )
    .expect("file should move with overwrite");
    assert_eq!(moved[0].project_relative_path, "source/one.txt");
    delete_project_paths(
        project.as_ref(),
        &[ProjectPathBatchEntry {
            project_relative_path: "target/note.txt".to_owned(),
            kind: ProjectPathKind::File,
        }],
    )
    .expect("file should delete");
    assert!(!project.as_ref().join("target/note.txt").exists());

    import_upload_project_entries(
        project.as_ref(),
        &[
            ProjectUploadEntry::Directory {
                project_relative_path: "target/upload".to_owned(),
            },
            ProjectUploadEntry::File {
                project_relative_path: "target/upload/file.txt".to_owned(),
                content: b"uploaded".to_vec(),
            },
        ],
        "target",
        false,
    )
    .expect("closed upload manifest should apply");
    assert_eq!(
        fs::read_to_string(project.as_ref().join("target/upload/file.txt"))
            .expect("uploaded file should be readable"),
        "uploaded"
    );
}

#[test]
fn project_text_classification_matches_registered_filename_extension_and_shebang_rules() {
    let project = TemporaryDirectory::new("text-types");
    for (path, content, language, mime_type) in [
        ("tsconfig.dev.json", "{}", "jsonc", "application/jsonc"),
        (
            "script",
            "#!/usr/bin/env node\n",
            "javascript",
            "text/javascript",
        ),
        (
            "schema.proto",
            "syntax = 'proto3';",
            "protobuf",
            "text/x-protobuf",
        ),
        (".env.local", "KEY=value", "dotenv", "text/plain"),
        ("LICENSE", "Apache-2.0", "plaintext", "text/plain"),
        ("cloud", "#cloud-config\n", "yaml", "application/yaml"),
        ("make", "#! /usr/bin/make\n", "makefile", "text/plain"),
    ] {
        fs::write(project.as_ref().join(path), content).expect("fixture should be written");
        let text = read_project_text_file(project.as_ref(), path, None)
            .expect("registered text fixture should be read");
        assert_eq!(text.language, language, "language mismatch for {path}");
        assert_eq!(text.mime_type, mime_type, "MIME mismatch for {path}");
    }
    for (first_line, description) in [
        ("#cloud-configure", "cloud-config word boundary"),
        ("#!/usr/bin/mypython", "python word boundary"),
        ("#!/usr/bin/nodejs", "node word boundary"),
        ("#!/usr/bin/makemake", "make word boundary"),
    ] {
        assert_eq!(
            project_text_file_type_for_path("untyped", Some(first_line)),
            None,
            "false-positive first-line match: {description}"
        );
    }
}

#[cfg(unix)]
#[test]
fn local_import_rejects_nested_symlinks_before_any_copy() {
    use std::os::unix::fs::symlink;

    let project = TemporaryDirectory::new("import-project");
    let external = TemporaryDirectory::new("import-source");
    fs::create_dir_all(project.as_ref().join("target")).expect("target should be created");
    fs::create_dir_all(external.as_ref().join("folder")).expect("folder should be created");
    fs::write(external.as_ref().join("outside.txt"), "outside")
        .expect("outside file should be written");
    symlink(
        external.as_ref().join("outside.txt"),
        external.as_ref().join("folder/link.txt"),
    )
    .expect("test symlink should be created");
    let error = import_local_project_paths(
        project.as_ref(),
        &[external.as_ref().join("folder")],
        "target",
        false,
    )
    .expect_err("nested symbolic link must reject the full batch");
    assert!(error.to_string().contains("symbolic link"));
    assert!(!project.as_ref().join("target/folder").exists());
}

#[cfg(unix)]
#[test]
fn project_copy_rejects_nested_symlinks_before_copying_any_entry() {
    use std::os::unix::fs::symlink;

    let project = TemporaryDirectory::new("copy-symlink");
    fs::create_dir_all(project.as_ref().join("source/folder"))
        .expect("source tree should be created");
    fs::create_dir_all(project.as_ref().join("target")).expect("target should be created");
    fs::write(project.as_ref().join("source/first.txt"), "first")
        .expect("first fixture should be written");
    fs::write(project.as_ref().join("source/outside.txt"), "outside")
        .expect("outside fixture should be written");
    symlink(
        project.as_ref().join("source/outside.txt"),
        project.as_ref().join("source/folder/link.txt"),
    )
    .expect("nested symlink should be created");
    let error = copy_project_paths(
        project.as_ref(),
        &[
            ProjectPathBatchEntry {
                project_relative_path: "source/first.txt".to_owned(),
                kind: ProjectPathKind::File,
            },
            ProjectPathBatchEntry {
                project_relative_path: "source/folder".to_owned(),
                kind: ProjectPathKind::Directory,
            },
        ],
        "target",
    )
    .expect_err("nested symlink must reject the whole copy batch");
    assert!(error.to_string().contains("symbolic link"));
    assert!(
        fs::read_dir(project.as_ref().join("target"))
            .expect("target should be readable")
            .next()
            .is_none(),
        "copy validation failure must leave the target untouched"
    );
}

#[cfg(unix)]
#[test]
fn registered_document_writes_reject_intermediate_symlinks() {
    use std::os::unix::fs::symlink;

    let project = TemporaryDirectory::new("document-parent-symlink");
    let home = TemporaryDirectory::new("document-parent-symlink-home");
    let service = ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
        .expect("Project should initialize");
    drop(service);
    let debrute = project.as_ref().join(".debrute");
    fs::rename(debrute.join("canvases"), debrute.join("canvases-real"))
        .expect("Canvas directory should move");
    symlink(debrute.join("canvases-real"), debrute.join("canvases"))
        .expect("Canvas alias should be created");
    let target = debrute.join("canvases/canvas-1.json");
    let before = fs::read(&target).expect("Canvas should be readable through alias");
    let error = commit_project_document_transaction(&ProjectDocumentTransaction {
        project_root: project.as_ref().to_path_buf(),
        owner: "canvas-registry".to_owned(),
        reads: Vec::new(),
        writes: vec![ProjectDocumentWrite {
            absolute_path: target.clone(),
            content: "{}\n".to_owned(),
        }],
        deletes: Vec::new(),
    })
    .expect_err("intermediate symbolic link must be rejected");
    assert_eq!(error.code(), "document_push_failed");
    assert_eq!(
        fs::read(target).expect("Canvas should remain readable"),
        before
    );
}

#[test]
fn upload_manifest_rejects_file_ancestor_before_overwrite_effects() {
    let project = TemporaryDirectory::new("upload-prefix");
    fs::create_dir_all(project.as_ref().join("target/a"))
        .expect("existing top-level directory should be created");
    fs::write(project.as_ref().join("target/a/keep.txt"), "keep")
        .expect("existing file should be written");
    let error = import_upload_project_entries(
        project.as_ref(),
        &[
            ProjectUploadEntry::File {
                project_relative_path: "target/a".to_owned(),
                content: b"file".to_vec(),
            },
            ProjectUploadEntry::File {
                project_relative_path: "target/a/b.txt".to_owned(),
                content: b"child".to_vec(),
            },
        ],
        "target",
        true,
    )
    .expect_err("file ancestor conflict must reject the upload manifest");
    assert!(error.to_string().contains("cannot contain"));
    assert_eq!(
        fs::read_to_string(project.as_ref().join("target/a/keep.txt"))
            .expect("existing file should remain"),
        "keep"
    );
}

#[test]
fn project_watcher_publishes_external_file_changes_once() {
    let project = TemporaryDirectory::new("watcher");
    let home = TemporaryDirectory::new("watcher-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Workbench)
        .expect("Project should open");
    let mut subscription = opened
        .session
        .subscribe()
        .expect("subscription should open");
    let ProjectStreamItem::Snapshot(sync) = subscription.recv().expect("snapshot should arrive")
    else {
        panic!("Project stream must begin with a snapshot");
    };
    assert_eq!(sync.project_revision, 1);

    fs::write(project.as_ref().join("external.txt"), "external")
        .expect("external write should succeed");
    let Some(ProjectStreamItem::Event(event)) = subscription
        .recv_timeout(Duration::from_secs(10))
        .expect("Project stream should remain open")
    else {
        panic!("watcher should publish an external change");
    };
    assert_eq!(event.project_revision, 2);
    let ProjectChange::ProjectFileChanged {
        project_relative_path,
        snapshot,
    } = event.change
    else {
        panic!("watcher should publish a Project file change");
    };
    assert_eq!(project_relative_path, "external.txt");
    assert!(snapshot.files.iter().any(|entry| {
        entry.project_relative_path == "external.txt" && entry.kind == ProjectPathKind::File
    }));

    drop(subscription);
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn watcher_coalescing_is_path_local_under_unrelated_event_pressure() {
    let project = TemporaryDirectory::new("watcher-pressure");
    let home = TemporaryDirectory::new("watcher-pressure-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Workbench)
        .expect("Project should open");
    let mut subscription = opened
        .session
        .subscribe()
        .expect("subscription should open");
    assert!(matches!(
        subscription.recv().expect("snapshot should arrive"),
        ProjectStreamItem::Snapshot(_)
    ));
    let noise_root = project.as_ref().to_path_buf();
    let noise = thread::spawn(move || {
        let started = Instant::now();
        let mut index = 0_u64;
        while started.elapsed() < Duration::from_millis(600) {
            fs::write(noise_root.join("noise.txt"), index.to_string())
                .expect("noise write should succeed");
            index += 1;
            thread::sleep(Duration::from_millis(5));
        }
    });
    thread::sleep(Duration::from_millis(20));
    let started = Instant::now();
    fs::write(project.as_ref().join("target.txt"), "target").expect("target write should succeed");
    loop {
        let remaining = Duration::from_millis(400).saturating_sub(started.elapsed());
        let Some(ProjectStreamItem::Event(event)) = subscription
            .recv_timeout(remaining)
            .expect("Project stream should remain open")
        else {
            panic!("target path should flush while noise continues");
        };
        if matches!(
            event.change,
            ProjectChange::ProjectFileChanged {
                ref project_relative_path,
                ..
            } if project_relative_path == "target.txt"
        ) {
            break;
        }
    }
    assert!(started.elapsed() < Duration::from_millis(400));
    noise.join().expect("noise writer should finish");
    drop(subscription);
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn watcher_establishment_precedes_final_publication_refresh() {
    let project = TemporaryDirectory::new("publication-barrier");
    let home = TemporaryDirectory::new("publication-barrier-home");
    fs::write(project.as_ref().join("seed.txt"), "seed").expect("seed should be written");
    let mut setup =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    setup
        .add_project_path_to_canvas_map("canvas-1", "seed.txt")
        .expect("Canvas Map should be seeded");
    drop(setup);

    let gate = Arc::new(BlockingAdapterGate::default());
    let registry = project_registry(
        home.as_ref(),
        Arc::new(BlockingSecondLayoutAdapter {
            calls: AtomicUsize::new(0),
            gate: Arc::clone(&gate),
        }),
    );
    let opening_registry = registry.clone();
    let project_root = project.as_ref().to_path_buf();
    let open_worker = thread::spawn(move || {
        opening_registry
            .open_project(project_root, ProjectUseKind::Workbench)
            .expect("Project should open")
    });
    let mut entered = gate.entered.lock().expect("gate should lock");
    while !*entered {
        entered = gate
            .entered_ready
            .wait(entered)
            .expect("gate wait should succeed");
    }
    drop(entered);
    fs::write(project.as_ref().join("during-open.txt"), "visible")
        .expect("external write during open should succeed");
    *gate.released.lock().expect("gate should lock") = true;
    gate.release_ready.notify_all();

    let opened = open_worker.join().expect("opener should finish");
    let mut subscription = opened
        .session
        .subscribe()
        .expect("subscription should open");
    let ProjectStreamItem::Snapshot(sync) = subscription.recv().expect("snapshot should arrive")
    else {
        panic!("Project stream must begin with a snapshot");
    };
    if !sync
        .snapshot
        .files
        .iter()
        .any(|entry| entry.project_relative_path == "during-open.txt")
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            let Some(ProjectStreamItem::Event(event)) = subscription
                .recv_timeout(timeout)
                .expect("Project stream should remain open")
            else {
                panic!("write captured before publication must not be lost");
            };
            let ProjectChange::ProjectFileChanged { snapshot, .. } = event.change else {
                continue;
            };
            if snapshot
                .files
                .iter()
                .any(|entry| entry.project_relative_path == "during-open.txt")
            {
                break;
            }
        }
    }
    drop(subscription);
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn registry_close_treats_an_inflight_open_cancellation_as_successful_cleanup() {
    let project = TemporaryDirectory::new("close-open-race");
    let home = TemporaryDirectory::new("close-open-race-home");
    fs::write(project.as_ref().join("seed.txt"), "seed").expect("seed should be written");
    let mut setup =
        ProjectService::open(project.as_ref(), home.as_ref(), Arc::new(FixedNodeAdapter))
            .expect("Project should initialize");
    setup
        .add_project_path_to_canvas_map("canvas-1", "seed.txt")
        .expect("Canvas Map should be seeded");
    drop(setup);
    let gate = Arc::new(BlockingAdapterGate::default());
    let registry = project_registry(
        home.as_ref(),
        Arc::new(BlockingSecondLayoutAdapter {
            calls: AtomicUsize::new(0),
            gate: Arc::clone(&gate),
        }),
    );
    let opening_registry = registry.clone();
    let project_root = project.as_ref().to_path_buf();
    let open_worker =
        thread::spawn(move || opening_registry.open_project(project_root, ProjectUseKind::Request));
    let mut entered = gate.entered.lock().expect("gate should lock");
    while !*entered {
        entered = gate
            .entered_ready
            .wait(entered)
            .expect("gate wait should succeed");
    }
    drop(entered);
    let closing_registry = registry.clone();
    let close_worker = thread::spawn(move || closing_registry.close());
    *gate.released.lock().expect("gate should lock") = true;
    gate.release_ready.notify_all();

    let Err(open_error) = open_worker.join().expect("open worker should finish") else {
        panic!("inflight open should be cancelled by registry close");
    };
    assert_eq!(open_error.code(), "project_registry_closed");
    close_worker
        .join()
        .expect("close worker should finish")
        .expect("successful inflight cleanup must not fail registry close");
}

#[test]
fn exhausted_revision_rejects_commands_before_filesystem_effects() {
    let project = TemporaryDirectory::new("revision-capacity");
    let home = TemporaryDirectory::new("revision-capacity-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    opened.session.set_revision_for_test(u64::MAX);
    let error = opened
        .session
        .execute(ProjectCommand::CreateCanvas)
        .expect_err("exhausted revision must reject before mutation");
    assert_eq!(error.code(), "project_revision_exhausted");
    assert!(
        !project
            .as_ref()
            .join(".debrute/canvases/canvas-2.json")
            .exists()
    );
    fs::write(project.as_ref().join("external.txt"), "external")
        .expect("external fixture should be written");
    let watcher_error = opened
        .session
        .apply_watched_change_for_test("external.txt")
        .expect_err("watcher refresh must reserve revision before changing state");
    assert_eq!(watcher_error.code(), "project_revision_exhausted");
    assert!(
        !opened
            .session
            .sync_snapshot()
            .expect("snapshot should remain readable")
            .snapshot
            .files
            .iter()
            .any(|entry| entry.project_relative_path == "external.txt")
    );
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn directory_commands_do_not_suppress_later_parent_directory_events() {
    let project = TemporaryDirectory::new("directory-receipt");
    let home = TemporaryDirectory::new("directory-receipt-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let created = opened
        .session
        .execute(ProjectCommand::CreatePath {
            parent_project_relative_path: String::new(),
            name: "folder".to_owned(),
            kind: ProjectPathKind::Directory,
        })
        .expect("directory should be created");
    fs::write(project.as_ref().join("folder/external.txt"), "external")
        .expect("external child should be written");
    opened
        .session
        .apply_watched_change_for_test("folder")
        .expect("parent directory event should refresh");
    let snapshot = opened
        .session
        .sync_snapshot()
        .expect("snapshot should remain readable");
    assert_eq!(snapshot.project_revision, created.project_revision + 1);
    assert!(
        snapshot
            .snapshot
            .files
            .iter()
            .any(|entry| entry.project_relative_path == "folder/external.txt")
    );
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn equivalent_watcher_refresh_preserves_the_revision_snapshot_exactly() {
    let project = TemporaryDirectory::new("equivalent-watch-refresh");
    let home = TemporaryDirectory::new("equivalent-watch-refresh-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let opened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("Project should open");
    let before = opened
        .session
        .sync_snapshot()
        .expect("snapshot should be readable");
    thread::sleep(Duration::from_millis(2));
    opened
        .session
        .apply_watched_change_for_test("unchanged.txt")
        .expect("equivalent refresh should succeed");
    let after = opened
        .session
        .sync_snapshot()
        .expect("snapshot should remain readable");
    assert_eq!(
        after, before,
        "one revision must identify one exact snapshot"
    );
    drop(opened.project_use);
    registry.close().expect("registry should close");
}

#[test]
fn missing_project_root_has_a_closed_not_found_error_code() {
    let project = TemporaryDirectory::new("missing-root");
    let home = TemporaryDirectory::new("missing-root-home");
    let missing = project.as_ref().join("absent");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let Err(error) = registry.open_project(&missing, ProjectUseKind::Request) else {
        panic!("missing root must fail");
    };
    assert_eq!(error.code(), "project_not_found");
    registry.close().expect("registry should close");
}

#[test]
fn registry_uses_typed_uses_serialized_mutations_and_snapshot_first_streams() {
    let project = TemporaryDirectory::new("registry");
    let home = TemporaryDirectory::new("registry-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let first = registry
        .open_project(project.as_ref(), ProjectUseKind::Workbench)
        .expect("first open should succeed");
    let second = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("same root should share the live session");
    assert_eq!(first.session.project_id(), second.session.project_id());

    let mut subscription = first
        .session
        .subscribe()
        .expect("subscription should start with a snapshot");
    let ProjectStreamItem::Snapshot(sync) = subscription.recv().expect("snapshot should arrive")
    else {
        panic!("Project stream must begin with a snapshot");
    };
    assert_eq!(sync.project_revision, 1);
    let result = first
        .session
        .execute(ProjectCommand::CreateCanvas)
        .expect("mutation should commit");
    assert_eq!(result.project_revision, 2);
    let Some(ProjectStreamItem::Event(event)) = subscription
        .recv_timeout(Duration::from_secs(1))
        .expect("Project stream should remain open")
    else {
        panic!("subscriber should receive the committed delta");
    };
    assert_eq!(event.project_revision, 2);
    let refreshed = first
        .session
        .execute(ProjectCommand::Refresh)
        .expect("the next serialized mutation should not require a caller revision");
    assert_eq!(refreshed.project_revision, 3);

    drop(subscription);
    let project_id = first.session.project_id().to_owned();
    drop(first.project_use);
    assert!(registry.get(&project_id).is_ok());
    drop(second.project_use);
    let Err(closed) = registry.get(&project_id) else {
        panic!("final project_use should close immediately");
    };
    assert_eq!(closed.code(), "project_not_open");
    let reopened = registry
        .open_project(project.as_ref(), ProjectUseKind::Request)
        .expect("closed root should create a fresh session");
    assert_eq!(project_id, reopened.session.project_id());
    drop(reopened.project_use);
    registry.close().expect("registry should close cleanly");
}

#[test]
fn concurrent_project_opens_share_one_session_and_issue_one_project_use_each() {
    const CLIENTS: usize = 4;

    let project = TemporaryDirectory::new("concurrent-registry");
    let home = TemporaryDirectory::new("concurrent-registry-home");
    let registry = project_registry(home.as_ref(), Arc::new(FixedNodeAdapter));
    let start = Arc::new(Barrier::new(CLIENTS));
    let release = Arc::new(Barrier::new(CLIENTS + 1));
    let (sender, receiver) = mpsc::channel();
    let handles = (0..CLIENTS)
        .map(|_| {
            let registry = registry.clone();
            let project_root = project.as_ref().to_path_buf();
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let sender = sender.clone();
            thread::spawn(move || {
                start.wait();
                let opened = registry
                    .open_project(project_root, ProjectUseKind::Request)
                    .expect("concurrent Project open should succeed");
                sender
                    .send(opened.session.project_id().to_owned())
                    .expect("session id should be reported");
                release.wait();
                drop(opened.project_use);
            })
        })
        .collect::<Vec<_>>();
    drop(sender);

    let project_ids = (0..CLIENTS)
        .map(|_| {
            receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("each open should report its session id")
        })
        .collect::<Vec<_>>();
    assert!(
        project_ids.windows(2).all(|pair| pair[0] == pair[1]),
        "all concurrent opens must share one live Project session"
    );
    assert_eq!(registry.list().expect("registry should list").len(), 1);

    release.wait();
    for handle in handles {
        handle.join().expect("open worker should finish");
    }
    assert!(registry.list().expect("registry should list").is_empty());
    registry.close().expect("registry should close cleanly");
}
