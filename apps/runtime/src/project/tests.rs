use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use uuid::Uuid;

use super::*;
use crate::workers::RuntimeWorkerServices;

fn relative(path: &str) -> ProjectRelativePath {
    ProjectRelativePath::parse(path).expect("test Project path must be valid")
}

fn fixture() -> (
    std::path::PathBuf,
    std::path::PathBuf,
    ProjectSessionRegistry,
) {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("visible.txt"), "hello").unwrap();
    fs::create_dir_all(root.join(".debrute/feedback/artifacts")).unwrap();
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let registry = ProjectSessionRegistry::new(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback,
    );
    (base, root, registry)
}

fn available_canvas_workspace(snapshot: &ProjectSnapshot) -> &CanvasWorkspaceDocument {
    match &snapshot.canvas_workspace {
        CanvasWorkspaceSnapshot::Available { workspace, .. } => workspace,
        CanvasWorkspaceSnapshot::Unavailable { code, message } => {
            panic!("Canvas Workspace unavailable ({code:?}): {message}")
        }
    }
}

#[derive(Default)]
struct VideoTextTrackNodeAdapter {
    video_presentation_calls: AtomicUsize,
}

impl ProjectNodeAdapter for VideoTextTrackNodeAdapter {
    fn video_presentation(
        &self,
        _project_root: &std::path::Path,
        project_relative_path: &str,
    ) -> Result<Option<CanvasVideoPresentation>, ProjectError> {
        self.video_presentation_calls.fetch_add(1, Ordering::SeqCst);
        Ok(
            (project_relative_path == "clip.mp4").then_some(CanvasVideoPresentation {
                kind: CanvasVideoPresentationKind::Video,
                width: 1280,
                height: 720,
                duration_seconds: Some(1.0),
                text_tracks: Vec::new(),
            }),
        )
    }

    fn video_text_tracks(
        &self,
        _project_root: &std::path::Path,
        project_relative_path: &ProjectRelativePath,
    ) -> Result<Vec<CanvasVideoTextTrack>, ProjectError> {
        Ok(if project_relative_path == "clip.mp4" {
            vec![CanvasVideoTextTrack {
                project_relative_path: "clip.en.vtt".to_owned(),
                file_url: None,
                revision: String::new(),
                kind: CanvasVideoTextTrackKind::Subtitles,
                label: "English".to_owned(),
                srclang: Some("en".to_owned()),
                default: true,
            }]
        } else {
            Vec::new()
        })
    }
}

fn resolving_source_target(snapshot: &ProjectSnapshot, path: &str) -> CanvasSourceTarget {
    let CanvasWorkspaceSnapshot::Available {
        canvas_resources, ..
    } = &snapshot.canvas_workspace
    else {
        panic!("expected an available Canvas workspace");
    };
    let resource = canvas_resources
        .resources
        .iter()
        .find(|resource| resource.project_relative_path() == path)
        .unwrap();
    let CanvasResource::File { availability, .. } = resource else {
        panic!("expected a Canvas file resource");
    };
    let CanvasNodeAvailability::Resolving { source_token, .. } = availability.as_ref() else {
        panic!("expected a resolving Canvas file resource");
    };
    CanvasSourceTarget {
        project_relative_path: relative(path),
        source_token: source_token.clone(),
    }
}

#[test]
fn canvas_resource_media_facts_use_exact_shared_classification() {
    let base = std::env::temp_dir().join(format!("debrute-project-media-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    let expected = [
        ("image.png", CanvasMediaKind::Image, "image/png"),
        ("image.jpg", CanvasMediaKind::Image, "image/jpeg"),
        ("image.jpeg", CanvasMediaKind::Image, "image/jpeg"),
        ("image.jpe", CanvasMediaKind::Image, "image/jpeg"),
        ("frame.jfif", CanvasMediaKind::Image, "image/jpeg"),
        ("animation.gif", CanvasMediaKind::Image, "image/gif"),
        ("image.webp", CanvasMediaKind::Image, "image/webp"),
        ("image.avif", CanvasMediaKind::Image, "image/avif"),
        ("image.tif", CanvasMediaKind::Image, "image/tiff"),
        ("image.tiff", CanvasMediaKind::Image, "image/tiff"),
        ("image.svg", CanvasMediaKind::Image, "image/svg+xml"),
        ("image.svgz", CanvasMediaKind::Image, "image/svg+xml"),
        ("video.mp4", CanvasMediaKind::Video, "video/mp4"),
        ("video.webm", CanvasMediaKind::Video, "video/webm"),
        ("video.mov", CanvasMediaKind::Video, "video/quicktime"),
        ("clip.m4v", CanvasMediaKind::Video, "video/x-m4v"),
        ("audio.mp3", CanvasMediaKind::Audio, "audio/mpeg"),
        ("audio.wav", CanvasMediaKind::Audio, "audio/wav"),
        ("audio.wave", CanvasMediaKind::Audio, "audio/wav"),
        ("audio.ogg", CanvasMediaKind::Audio, "audio/ogg"),
        ("audio.oga", CanvasMediaKind::Audio, "audio/ogg"),
        ("sound.opus", CanvasMediaKind::Audio, "audio/ogg"),
        ("audio.m4a", CanvasMediaKind::Audio, "audio/mp4"),
        ("audio.aac", CanvasMediaKind::Audio, "audio/mp4"),
        ("audio.flac", CanvasMediaKind::Audio, "audio/flac"),
        ("audio.weba", CanvasMediaKind::Audio, "audio/webm"),
        ("launch", CanvasMediaKind::Text, "text/x-shellscript"),
    ];
    for (path, _, _) in expected {
        fs::write(root.join(path), []).unwrap();
    }
    fs::write(root.join("launch"), "#!/bin/sh\necho ready\n").unwrap();

    let service = ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let snapshot = service.snapshot();
    let resources = match &snapshot.canvas_workspace {
        CanvasWorkspaceSnapshot::Available {
            canvas_resources, ..
        } => &canvas_resources.resources,
        CanvasWorkspaceSnapshot::Unavailable { code, message } => {
            panic!("Canvas Workspace unavailable ({code:?}): {message}")
        }
    };
    for (path, expected_kind, expected_mime_type) in expected {
        let resource = resources
            .iter()
            .find(|resource| resource.project_relative_path() == path)
            .unwrap();
        let CanvasResource::File {
            media_kind,
            availability,
            ..
        } = resource
        else {
            panic!("expected Canvas file resource for {path}")
        };
        assert_eq!(
            *media_kind, expected_kind,
            "unexpected media kind for {path}"
        );
        let CanvasNodeAvailability::Resolving { mime_type, .. } = availability.as_ref() else {
            panic!("expected unresolved Canvas resource descriptor for {path}")
        };
        assert_eq!(
            mime_type, expected_mime_type,
            "unexpected MIME type for {path}"
        );
    }

    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn resolving_a_video_resolves_its_text_track_through_the_shared_source_cache() {
    let base = std::env::temp_dir().join(format!("debrute-project-tracks-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("clip.mp4"), b"video bytes").unwrap();
    fs::write(root.join("clip.en.vtt"), b"WEBVTT\n").unwrap();

    let adapter = Arc::new(VideoTextTrackNodeAdapter::default());
    let mut service = ProjectService::open(&root, &home, adapter.clone()).unwrap();
    assert_eq!(adapter.video_presentation_calls.load(Ordering::SeqCst), 1);
    let snapshot = service.snapshot();
    let video_target = resolving_source_target(snapshot, "clip.mp4");
    let track_target = resolving_source_target(snapshot, "clip.en.vtt");

    let source_digests = ProjectSourceDigestResolver::default();
    let resolved = service
        .resolve_canvas_sources(&[video_target], &source_digests)
        .unwrap();
    assert_eq!(adapter.video_presentation_calls.load(Ordering::SeqCst), 1);
    assert_eq!(resolved.sources.len(), 1);
    let video = &resolved.sources[0];
    assert_eq!(video.project_relative_path, "clip.mp4");
    let video_text_tracks = video.video_text_tracks.as_ref().unwrap();
    assert!(!video_text_tracks[0].revision.is_empty());

    let resolved_again = service
        .resolve_canvas_sources(&[track_target], &source_digests)
        .unwrap();
    assert_eq!(resolved_again.sources.len(), 1);
    assert_eq!(
        resolved_again.sources[0].project_relative_path,
        "clip.en.vtt"
    );
    assert!(matches!(
        &resolved_again.sources[0].availability,
        CanvasNodeAvailability::Available { .. }
    ));

    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn plain_directory_is_a_project_and_identity_is_its_canonical_root() {
    let (base, root, registry) = fixture();
    let first = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let second = registry
        .open_project(&root, ProjectUseKind::Request)
        .unwrap();
    assert!(Arc::ptr_eq(&first.session, &second.session));
    assert_eq!(
        first.session.canonical_root(),
        root.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(
        first
            .session
            .sync_snapshot()
            .unwrap()
            .snapshot
            .project_tree
            .iter()
            .any(|entry| {
                entry.project_relative_path == ".debrute"
                    && entry.kind == ProjectPathKind::Directory
            })
    );
    drop(first);
    drop(second);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn canvas_workspace_is_persisted_outside_the_project() {
    let (base, root, registry) = fixture();
    let home = base.join("home");
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let snapshot = opened.session.sync_snapshot().unwrap().snapshot;
    let document = available_canvas_workspace(&snapshot);
    assert!(document.state.expanded_directories.is_empty());
    assert!(
        crate::global::root_state_directory(&home, root.canonicalize().unwrap().to_str().unwrap())
            .join("canvas.json")
            .is_file()
    );
    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn invalid_canvas_workspace_does_not_block_project_and_reset_replaces_it() {
    let (base, root, registry) = fixture();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let canvas_path = crate::global::root_state_directory(&base.join("home"), &canonical_root)
        .join("canvas.json");
    fs::create_dir_all(canvas_path.parent().unwrap()).unwrap();
    fs::write(&canvas_path, "{not json").unwrap();

    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let before = opened.session.sync_snapshot().unwrap().snapshot;
    assert!(!before.project_tree.is_empty());
    assert!(matches!(
        before.canvas_workspace,
        CanvasWorkspaceSnapshot::Unavailable {
            code: CanvasWorkspaceUnavailableCode::CanvasWorkspaceInvalid,
            ..
        }
    ));

    opened.session.execute(ProjectCommand::ResetCanvas).unwrap();
    let after = opened.session.sync_snapshot().unwrap().snapshot;
    let workspace = available_canvas_workspace(&after);
    assert!(workspace.state.expanded_directories.is_empty());
    assert_eq!(
        serde_json::from_slice::<CanvasWorkspaceDocument>(&fs::read(canvas_path).unwrap()).unwrap(),
        *workspace
    );

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn reset_canvas_returns_the_exact_persistence_failure() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let canvas_path =
        crate::global::root_state_directory(&home, &canonical_root).join("canvas.json");
    fs::create_dir_all(&canvas_path).unwrap();

    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let registry = ProjectSessionRegistry::new(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback,
    );
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    assert!(matches!(
        &opened
            .session
            .sync_snapshot()
            .unwrap()
            .snapshot
            .canvas_workspace,
        CanvasWorkspaceSnapshot::Unavailable {
            code: CanvasWorkspaceUnavailableCode::CanvasWorkspaceUnreadable,
            ..
        }
    ));

    let before = opened.session.sync_snapshot().unwrap();
    let mut subscription = opened.session.subscribe().unwrap();
    assert!(matches!(
        subscription.recv().unwrap(),
        ProjectStreamItem::Snapshot(_)
    ));
    let error = opened
        .session
        .execute(ProjectCommand::ResetCanvas)
        .unwrap_err();
    assert_eq!(error.code(), "canvas_workspace_persistence_failed");
    assert_eq!(opened.session.sync_snapshot().unwrap(), before);
    assert_eq!(
        subscription
            .recv_timeout(Duration::from_millis(20))
            .unwrap(),
        None
    );

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn reset_canvas_persistence_failure_preserves_available_state() {
    let (base, root, _) = fixture();
    let home = base.join("available-reset-home");
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let patch = serde_json::from_value(serde_json::json!({
        "nodeStateUpdates": [{
            "projectRelativePath": "visible.txt",
            "manualLayout": {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}
        }]
    }))
    .unwrap();
    service.patch_canvas_state(&patch).unwrap();
    let before = service.snapshot().clone();
    let canvas_path =
        crate::global::root_state_directory(&home, &canonical_root).join("canvas.json");
    fs::remove_file(&canvas_path).unwrap();
    fs::create_dir(&canvas_path).unwrap();

    let error = service.reset_canvas().unwrap_err();

    assert_eq!(error.code(), "canvas_workspace_persistence_failed");
    assert_eq!(service.snapshot(), &before);
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn canvas_patch_persistence_failure_discards_the_staged_project_tree() {
    let (base, root, _) = fixture();
    let home = base.join("patch-failure-home");
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("assets/child.txt"), "child").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let before = service.snapshot().clone();
    assert!(!service.is_loaded_watch_path("assets/child.txt"));
    let canvas_path =
        crate::global::root_state_directory(&home, &canonical_root).join("canvas.json");
    fs::remove_file(&canvas_path).unwrap();
    fs::create_dir(&canvas_path).unwrap();
    let patch = serde_json::from_value(serde_json::json!({
        "expandedDirectories": ["assets"]
    }))
    .unwrap();

    let error = service.patch_canvas_state(&patch).unwrap_err();

    assert_eq!(error.code(), "canvas_workspace_persistence_failed");
    assert_eq!(service.snapshot(), &before);
    assert!(!service.is_loaded_watch_path("assets/child.txt"));
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn canvas_patch_commits_when_confirmed_path_feedback_cannot_be_pruned() {
    let (base, root, _) = fixture();
    let home = base.join("patch-feedback-failure-home");
    let removed_directory = root.join("assets/removed");
    fs::create_dir_all(&removed_directory).unwrap();
    fs::write(removed_directory.join("child.txt"), "child").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let feedback = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["assets/removed/child.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    service.update_canvas_feedback(&feedback).unwrap();
    let feedback_before = service.canvas_feedback().clone();
    fs::remove_dir_all(&removed_directory).unwrap();
    let feedback_path = root.join(CANVAS_FEEDBACK_PROJECT_PATH);
    fs::remove_file(&feedback_path).unwrap();
    fs::create_dir(&feedback_path).unwrap();
    let patch = serde_json::from_value(serde_json::json!({
        "expandedDirectories": ["assets", "assets/removed"]
    }))
    .unwrap();

    let CanvasStatePatchOutcome::ProjectChanged(snapshot) =
        service.patch_canvas_state(&patch).unwrap()
    else {
        panic!("Folder Disclosure must publish a complete Project snapshot");
    };
    let workspace = available_canvas_workspace(&snapshot);
    assert_eq!(workspace.state.expanded_directories, vec!["assets"]);
    assert_eq!(service.canvas_feedback(), &feedback_before);
    assert!(
        snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == "project_path_state_persistence_failed" })
    );
    assert_eq!(
        CanvasWorkspaceStore::new(&home, &canonical_root)
            .load_or_create()
            .unwrap(),
        *workspace
    );
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn invalid_canvas_patch_leaves_all_project_state_unchanged() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("visible.txt"), "hello").unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let feedback = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["visible.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    service.update_canvas_feedback(&feedback).unwrap();
    let before_snapshot = service.snapshot().clone();
    let before_feedback = service.canvas_feedback().clone();

    let patch = serde_json::from_value(serde_json::json!({
        "expandedDirectories": ["assets"],
        "nodeStateUpdates": [{
            "projectRelativePath": "missing.txt",
            "manualLayout": {"x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0}
        }]
    }))
    .unwrap();
    assert_eq!(
        service.patch_canvas_state(&patch).unwrap_err().to_string(),
        "Project path not found: missing.txt"
    );

    assert_eq!(service.snapshot(), &before_snapshot);
    assert_eq!(service.canvas_feedback(), &before_feedback);
    assert!(!service.is_loaded_watch_path("assets/new.txt"));
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn idempotent_canvas_patch_does_not_report_a_change() {
    let (base, root, registry) = fixture();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let patch = serde_json::from_value(serde_json::json!({"expandedDirectories": []})).unwrap();
    let before = opened.session.sync_snapshot().unwrap();

    opened
        .session
        .execute(ProjectCommand::PatchCanvasState { patch })
        .unwrap();

    assert_eq!(opened.session.sync_snapshot().unwrap(), before);
    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn state_only_canvas_patch_publishes_an_authoritative_delta_without_a_project_snapshot() {
    let (base, root, registry) = fixture();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let before = opened.session.sync_snapshot().unwrap();
    let mut subscription = opened.session.subscribe().unwrap();
    assert!(matches!(
        subscription.recv().unwrap(),
        ProjectStreamItem::Snapshot(_)
    ));
    let patch = serde_json::from_value(serde_json::json!({
        "nodeStateUpdates": [{
            "projectRelativePath": "visible.txt",
            "manualLayout": {"x": 10.0, "y": 20.0, "width": 300.0, "height": 200.0}
        }]
    }))
    .unwrap();

    let result = opened
        .session
        .execute(ProjectCommand::PatchCanvasState { patch })
        .unwrap();

    assert!(matches!(
        result.value,
        ProjectCommandResult::CanvasStateUpdated
    ));
    let ProjectStreamItem::Event(event) = subscription.recv().unwrap() else {
        panic!("expected a Canvas State event");
    };
    let ProjectChange::CanvasStateChanged { change } = event.change else {
        panic!("expected a path-local Canvas State delta");
    };
    assert_eq!(change.node_states.len(), 1);
    assert_eq!(change.node_states[0].project_relative_path, "visible.txt");
    assert!(change.node_states[0].state.is_some());
    assert_eq!(change.occlusion_order, None);
    let after = opened.session.sync_snapshot().unwrap();
    assert_eq!(after.project_revision, before.project_revision + 1);
    assert_eq!(after.snapshot.project_tree, before.snapshot.project_tree);
    assert_eq!(
        match &after.snapshot.canvas_workspace {
            CanvasWorkspaceSnapshot::Available {
                canvas_resources, ..
            } => canvas_resources,
            CanvasWorkspaceSnapshot::Unavailable { .. } => panic!("Canvas became unavailable"),
        },
        match &before.snapshot.canvas_workspace {
            CanvasWorkspaceSnapshot::Available {
                canvas_resources, ..
            } => canvas_resources,
            CanvasWorkspaceSnapshot::Unavailable { .. } => panic!("Canvas was unavailable"),
        }
    );

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn folder_disclosure_canvas_patch_still_publishes_a_complete_project_snapshot() {
    let (base, root, registry) = fixture();
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("assets/child.txt"), "child").unwrap();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let mut subscription = opened.session.subscribe().unwrap();
    assert!(matches!(
        subscription.recv().unwrap(),
        ProjectStreamItem::Snapshot(_)
    ));
    let patch = serde_json::from_value(serde_json::json!({
        "expandedDirectories": ["assets"]
    }))
    .unwrap();

    opened
        .session
        .execute(ProjectCommand::PatchCanvasState { patch })
        .unwrap();

    let ProjectStreamItem::Event(event) = subscription.recv().unwrap() else {
        panic!("expected a Project event");
    };
    assert!(matches!(event.change, ProjectChange::ProjectChanged(_)));

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn confirmed_external_replacement_prunes_sparse_canvas_state() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("assets/a.txt"), "first").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let store = CanvasWorkspaceStore::new(&home, &canonical_root);
    let mut document = default_canvas_workspace(&canonical_root);
    document.state = CanvasState {
        expanded_directories: vec!["assets".to_owned()],
        node_states: BTreeMap::from([(
            "assets/a.txt".to_owned(),
            CanvasNodeState {
                manual_layout: Some(CanvasManualLayout {
                    x: 100.0,
                    y: 200.0,
                    width: 300.0,
                    height: 400.0,
                }),
                ..CanvasNodeState::default()
            },
        )]),
        occlusion_order: vec!["assets/a.txt".to_owned()],
    };
    store.save(&document).unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let input = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["assets/a.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    service.update_canvas_feedback(&input).unwrap();

    fs::remove_file(root.join("assets/a.txt")).unwrap();
    service
        .refresh_watched_paths(&[watcher::ProjectWatchPath {
            project_relative_path: "assets/a.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap();
    fs::write(root.join("assets/a.txt"), "second").unwrap();
    let snapshot = service
        .refresh_watched_paths(&[watcher::ProjectWatchPath {
            project_relative_path: "assets/a.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap()
        .snapshot;

    let document = available_canvas_workspace(&snapshot);
    let state = &document.state;
    assert!(!state.node_states.contains_key("assets/a.txt"));
    assert!(!state.occlusion_order.contains(&"assets/a.txt".to_owned()));
    assert!(
        !service
            .canvas_feedback()
            .entries
            .contains_key("assets/a.txt")
    );
    let persisted = store.load_or_create().unwrap();
    assert_eq!(&persisted, document);
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn watcher_echo_does_not_erase_state_carried_by_a_runtime_rename() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("before.txt"), "content").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let store = CanvasWorkspaceStore::new(&home, &canonical_root);
    let mut document = default_canvas_workspace(&canonical_root);
    document.state.node_states.insert(
        "before.txt".to_owned(),
        CanvasNodeState {
            manual_layout: Some(CanvasManualLayout {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 400.0,
            }),
            ..CanvasNodeState::default()
        },
    );
    store.save(&document).unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();

    fs::rename(root.join("before.txt"), root.join("after.txt")).unwrap();
    service.reconcile_committed_path_mutation(
        &["after.txt".to_owned()],
        &[("before.txt".to_owned(), "after.txt".to_owned())],
    );
    let snapshot = service
        .refresh_watched_paths(&[watcher::ProjectWatchPath {
            project_relative_path: "after.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap()
        .snapshot;

    let document = available_canvas_workspace(&snapshot);
    assert!(document.state.node_states.contains_key("after.txt"));
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn runtime_text_save_preserves_state_only_for_its_committed_identity() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("note.txt"), "before").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let store = CanvasWorkspaceStore::new(&home, &canonical_root);
    let mut document = default_canvas_workspace(&canonical_root);
    document.state.node_states.insert(
        "note.txt".to_owned(),
        CanvasNodeState {
            manual_layout: Some(CanvasManualLayout {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 400.0,
            }),
            text_viewport: Some(CanvasTextViewportState {
                scroll_top: 12.0,
                scroll_left: 4.0,
            }),
            ..CanvasNodeState::default()
        },
    );
    store.save(&document).unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let current = read_project_text_file(&root, "note.txt").unwrap();

    let committed =
        write_project_text_file(&root, &relative("note.txt"), "after", &current.revision).unwrap();
    let snapshot = service.reconcile_committed_content_change("note.txt", committed.identity);

    let document = available_canvas_workspace(&snapshot);
    let state = &document.state.node_states["note.txt"];
    assert!(state.manual_layout.is_some());
    assert_eq!(
        state.text_viewport,
        Some(CanvasTextViewportState {
            scroll_top: 12.0,
            scroll_left: 4.0,
        })
    );

    let current = read_project_text_file(&root, "note.txt").unwrap();
    let committed =
        write_project_text_file(&root, &relative("note.txt"), "runtime", &current.revision)
            .unwrap();
    fs::remove_file(root.join("note.txt")).unwrap();
    fs::write(root.join("note.txt"), "external").unwrap();
    let snapshot = service.reconcile_committed_content_change("note.txt", committed.identity);
    assert!(
        !available_canvas_workspace(&snapshot)
            .state
            .node_states
            .contains_key("note.txt")
    );
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn committed_text_save_reports_following_project_refresh_failure() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(root.join(".debrute/feedback")).unwrap();
    fs::write(root.join("note.txt"), "before").unwrap();
    fs::write(root.join("second.txt"), "before").unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let current = read_project_text_file(&root, "note.txt").unwrap();

    let committed =
        write_project_text_file(&root, &relative("note.txt"), "after", &current.revision).unwrap();
    fs::write(root.join(CANVAS_FEEDBACK_PROJECT_PATH), "{not json").unwrap();
    let snapshot = service.reconcile_committed_content_change("note.txt", committed.identity);

    assert_eq!(fs::read_to_string(root.join("note.txt")).unwrap(), "after");
    assert!(snapshot.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "project_refresh_failed"
            && diagnostic.message.contains("Project file changed")
    }));
    let current = read_project_text_file(&root, "second.txt").unwrap();
    let committed =
        write_project_text_file(&root, &relative("second.txt"), "after", &current.revision)
            .unwrap();
    let snapshot = service.reconcile_committed_content_change("second.txt", committed.identity);
    assert_eq!(
        snapshot
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "project_refresh_failed")
            .count(),
        1
    );
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn text_files_larger_than_two_mib_are_read_and_written_in_full() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    let before = "a".repeat(2 * 1024 * 1024 + 1);
    let after = "b".repeat(2 * 1024 * 1024 + 1);
    fs::write(root.join("large.txt"), &before).unwrap();

    let current = read_project_text_file(&root, "large.txt").unwrap();
    assert_eq!(current.content, before);
    let saved =
        write_project_text_file(&root, &relative("large.txt"), &after, &current.revision).unwrap();

    assert_eq!(saved.file.content, after);
    assert_eq!(fs::read_to_string(root.join("large.txt")).unwrap(), after);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn rename_rewrites_accepted_feedback_and_both_working_copy_kinds() {
    let (base, root, _) = fixture();
    let home = base.join("home-path-identity");
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback_artifacts = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let working_copies = Arc::new(crate::workbench::WorkingCopyStore::new(&home));
    let registry = ProjectSessionRegistry::with_change_callback_and_path_state(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback_artifacts,
        Arc::new(|| {}),
        working_copies.clone(),
    );
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    working_copies
        .put_text(
            &canonical_root,
            crate::workbench::TextWorkingCopy {
                project_relative_path: "visible.txt".to_owned(),
                content: "draft".to_owned(),
                language: "plaintext".to_owned(),
                base_revision: "revision-1".to_owned(),
            },
        )
        .unwrap();
    working_copies
        .put_feedback(
            &canonical_root,
            crate::workbench::FeedbackWorkingCopy {
                item_id: "feedback-a".to_owned(),
                created_at: "2026-08-05T00:00:00Z".to_owned(),
                project_relative_path: "visible.txt".to_owned(),
                kind: CanvasFeedbackItemKind::Comment,
                scope: CanvasFeedbackScope::Node,
                moment_time_seconds: None,
                geometry: None,
                comment: "draft feedback".to_owned(),
            },
        )
        .unwrap();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let input = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["visible.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    opened
        .session
        .execute(ProjectCommand::UpdateCanvasFeedback { input })
        .unwrap();
    opened
        .session
        .execute(ProjectCommand::RenamePath {
            project_relative_path: relative("visible.txt"),
            name: "renamed.txt".to_owned(),
        })
        .unwrap();

    let feedback = opened.session.canvas_feedback().unwrap().value;
    assert!(!feedback.entries.contains_key("visible.txt"));
    assert!(feedback.entries.contains_key("renamed.txt"));
    let copies = working_copies.load(&canonical_root).unwrap();
    assert!(copies.text.contains_key("renamed.txt"));
    assert_eq!(
        copies.feedback["feedback-a"].project_relative_path,
        "renamed.txt"
    );
    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn runtime_path_reconciliation_prunes_a_concurrently_missing_sibling() {
    let base = std::env::temp_dir().join(format!("debrute-project-{}", Uuid::new_v4()));
    let home = base.join("home");
    let root = base.join("project");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("source.txt"), "source").unwrap();
    fs::write(root.join("sibling.txt"), "sibling").unwrap();
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let store = CanvasWorkspaceStore::new(&home, &canonical_root);
    let mut document = default_canvas_workspace(&canonical_root);
    document.state.node_states.insert(
        "sibling.txt".to_owned(),
        CanvasNodeState {
            manual_layout: Some(CanvasManualLayout {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 400.0,
            }),
            ..CanvasNodeState::default()
        },
    );
    store.save(&document).unwrap();
    let mut service =
        ProjectService::open(&root, &home, Arc::new(DefaultProjectNodeAdapter)).unwrap();
    let feedback = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["sibling.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    service.update_canvas_feedback(&feedback).unwrap();

    fs::remove_file(root.join("sibling.txt")).unwrap();
    fs::rename(root.join("source.txt"), root.join("target.txt")).unwrap();
    let snapshot = service.reconcile_committed_path_mutation(
        &["target.txt".to_owned()],
        &[("source.txt".to_owned(), "target.txt".to_owned())],
    );

    assert!(
        !available_canvas_workspace(&snapshot)
            .state
            .node_states
            .contains_key("sibling.txt")
    );
    assert!(
        !service
            .canvas_feedback()
            .entries
            .contains_key("sibling.txt")
    );
    drop(service);
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn watcher_confirmed_deletion_prunes_both_working_copy_kinds() {
    let (base, root, _) = fixture();
    let home = base.join("home-watcher-path-identity");
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback_artifacts = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let working_copies = Arc::new(crate::workbench::WorkingCopyStore::new(&home));
    let registry = ProjectSessionRegistry::with_change_callback_and_path_state(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback_artifacts,
        Arc::new(|| {}),
        working_copies.clone(),
    );
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    working_copies
        .put_text(
            &canonical_root,
            crate::workbench::TextWorkingCopy {
                project_relative_path: "visible.txt".to_owned(),
                content: "draft".to_owned(),
                language: "plaintext".to_owned(),
                base_revision: "revision-1".to_owned(),
            },
        )
        .unwrap();
    working_copies
        .put_feedback(
            &canonical_root,
            crate::workbench::FeedbackWorkingCopy {
                item_id: "feedback-a".to_owned(),
                created_at: "2026-08-05T00:00:00Z".to_owned(),
                project_relative_path: "visible.txt".to_owned(),
                kind: CanvasFeedbackItemKind::Comment,
                scope: CanvasFeedbackScope::Node,
                moment_time_seconds: None,
                geometry: None,
                comment: "draft feedback".to_owned(),
            },
        )
        .unwrap();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();

    fs::remove_file(root.join("visible.txt")).unwrap();
    opened
        .session
        .apply_watched_file_changes(vec![watcher::ProjectWatchPath {
            project_relative_path: "visible.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap();

    let copies = working_copies.load(&canonical_root).unwrap();
    assert!(copies.text.is_empty());
    assert!(copies.feedback.is_empty());
    assert_eq!(opened.session.sync_snapshot().unwrap().project_revision, 2);

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn watcher_deletion_prunes_working_copies_when_secondary_persistence_fails() {
    let (base, root, _) = fixture();
    let home = base.join("home-watcher-canvas-persistence-failure");
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback_artifacts = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let working_copies = Arc::new(crate::workbench::WorkingCopyStore::new(&home));
    let registry = ProjectSessionRegistry::with_change_callback_and_path_state(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback_artifacts,
        Arc::new(|| {}),
        working_copies.clone(),
    );
    let canonical_root = root.canonicalize().unwrap().to_str().unwrap().to_owned();
    let store = CanvasWorkspaceStore::new(&home, &canonical_root);
    let mut document = default_canvas_workspace(&canonical_root);
    document.state.node_states.insert(
        "visible.txt".to_owned(),
        CanvasNodeState {
            manual_layout: Some(CanvasManualLayout {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 200.0,
            }),
            ..CanvasNodeState::default()
        },
    );
    store.save(&document).unwrap();
    working_copies
        .put_text(
            &canonical_root,
            crate::workbench::TextWorkingCopy {
                project_relative_path: "visible.txt".to_owned(),
                content: "draft".to_owned(),
                language: "plaintext".to_owned(),
                base_revision: "revision-1".to_owned(),
            },
        )
        .unwrap();
    working_copies
        .put_feedback(
            &canonical_root,
            crate::workbench::FeedbackWorkingCopy {
                item_id: "feedback-a".to_owned(),
                created_at: "2026-08-05T00:00:00Z".to_owned(),
                project_relative_path: "visible.txt".to_owned(),
                kind: CanvasFeedbackItemKind::Comment,
                scope: CanvasFeedbackScope::Node,
                moment_time_seconds: None,
                geometry: None,
                comment: "draft feedback".to_owned(),
            },
        )
        .unwrap();
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();
    let input = serde_json::from_value(serde_json::json!({
        "operation": "set-mark",
        "projectRelativePaths": ["visible.txt"],
        "mark": "like",
        "selected": true
    }))
    .unwrap();
    opened
        .session
        .execute(ProjectCommand::UpdateCanvasFeedback { input })
        .unwrap();
    let canvas_path =
        crate::global::root_state_directory(&home, &canonical_root).join("canvas.json");
    fs::remove_file(&canvas_path).unwrap();
    fs::create_dir(&canvas_path).unwrap();
    let feedback_path = root.join(super::CANVAS_FEEDBACK_PROJECT_PATH);
    fs::remove_file(&feedback_path).unwrap();
    fs::create_dir(&feedback_path).unwrap();
    fs::remove_file(root.join("visible.txt")).unwrap();

    opened
        .session
        .apply_watched_file_changes(vec![watcher::ProjectWatchPath {
            project_relative_path: "visible.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap();

    let copies = working_copies.load(&canonical_root).unwrap();
    assert!(copies.text.is_empty());
    assert!(copies.feedback.is_empty());
    let snapshot = opened.session.sync_snapshot().unwrap();
    assert_eq!(snapshot.project_revision, 3);
    assert!(
        snapshot
            .snapshot
            .project_tree
            .iter()
            .all(|entry| entry.project_relative_path != "visible.txt")
    );
    assert!(matches!(
        snapshot.snapshot.canvas_workspace,
        CanvasWorkspaceSnapshot::Unavailable {
            code: CanvasWorkspaceUnavailableCode::CanvasWorkspacePersistenceFailed,
            ..
        }
    ));
    assert_eq!(
        snapshot
            .snapshot
            .diagnostics
            .iter()
            .filter(|diagnostic| {
                diagnostic.code == "project_path_state_persistence_failed"
                    && diagnostic.severity == ProjectDiagnosticSeverity::Error
            })
            .count(),
        1
    );

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

struct FailingPathStateReconciler;

impl ProjectPathStateReconciler for FailingPathStateReconciler {
    fn reconcile(
        &self,
        _canonical_root: &str,
        command: &ProjectCommand,
        _result: &ProjectCommandResult,
    ) -> Result<(), ProjectError> {
        if matches!(command, ProjectCommand::RenamePath { .. }) {
            Err(ProjectError::service(
                "working_copy_persistence_failed",
                "simulated failure",
            ))
        } else {
            Ok(())
        }
    }

    fn prune(&self, _canonical_root: &str, _removed: &[String]) -> Result<(), ProjectError> {
        Err(ProjectError::service(
            "working_copy_persistence_failed",
            "simulated failure",
        ))
    }
}

#[test]
fn watcher_path_state_failure_is_reported_on_the_watcher_revision() {
    let (base, root, _) = fixture();
    let home = base.join("home-watcher-reconcile-failure");
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let registry = ProjectSessionRegistry::with_change_callback_and_path_state(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback,
        Arc::new(|| {}),
        Arc::new(FailingPathStateReconciler),
    );
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();

    fs::remove_file(root.join("visible.txt")).unwrap();
    opened
        .session
        .apply_watched_file_changes(vec![watcher::ProjectWatchPath {
            project_relative_path: "visible.txt".to_owned(),
            resets_identity: true,
        }])
        .unwrap();

    let snapshot = opened.session.sync_snapshot().unwrap();
    assert_eq!(snapshot.project_revision, 2);
    assert!(snapshot.snapshot.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "project_path_state_persistence_failed"
            && diagnostic.severity == ProjectDiagnosticSeverity::Error
    }));

    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn committed_path_operation_survives_working_copy_reconcile_failure() {
    let (base, root, _) = fixture();
    let home = base.join("home-reconcile-failure");
    let workers = RuntimeWorkerServices::new();
    let previews = Arc::new(ProjectPreviewService::new_with_home(
        &workers,
        CanvasVideoToolPaths::for_tests(),
        &home,
    ));
    let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews.clone()).unwrap());
    let registry = ProjectSessionRegistry::with_change_callback_and_path_state(
        &home,
        Arc::new(NativeProjectNodeAdapter::new(previews)),
        feedback,
        Arc::new(|| {}),
        Arc::new(FailingPathStateReconciler),
    );
    let opened = registry
        .open_project(&root, ProjectUseKind::Workbench)
        .unwrap();

    let result = opened.session.execute(ProjectCommand::RenamePath {
        project_relative_path: relative("visible.txt"),
        name: "renamed.txt".to_owned(),
    });

    assert!(result.is_ok());
    assert!(root.join("renamed.txt").is_file());
    let snapshot = opened.session.sync_snapshot().unwrap();
    assert_eq!(snapshot.project_revision, 2);
    assert!(snapshot.snapshot.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "project_path_state_persistence_failed"
            && diagnostic.severity == ProjectDiagnosticSeverity::Error
    }));
    opened.session.execute(ProjectCommand::Refresh).unwrap();
    assert!(
        opened
            .session
            .sync_snapshot()
            .unwrap()
            .snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "project_path_state_persistence_failed")
    );
    opened
        .session
        .execute(ProjectCommand::CreatePath {
            parent_project_relative_path: ProjectDirectoryPath::root(),
            name: "next.txt".to_owned(),
            kind: ProjectPathKind::File,
        })
        .unwrap();
    assert!(
        opened
            .session
            .sync_snapshot()
            .unwrap()
            .snapshot
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code != "project_path_state_persistence_failed")
    );
    drop(opened);
    registry.close().unwrap();
    fs::remove_dir_all(base).unwrap();
}
