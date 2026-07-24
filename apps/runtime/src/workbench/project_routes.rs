#![allow(
    clippy::items_after_statements,
    clippy::manual_let_else,
    clippy::needless_pass_by_value,
    clippy::result_large_err,
    clippy::single_match_else,
    clippy::too_many_lines
)]

use std::{
    collections::HashMap,
    fs::File,
    io::{Read as _, Seek as _, SeekFrom},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    thread,
    time::Duration,
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Extension, Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_core::Stream;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{
    project::{
        CanvasMapPathRuleSet, CanvasNodeLayoutUpdate, CanvasTextPreviewSourceStatus,
        CanvasTextPreviewSourceTarget, CanvasTextViewportUpdate, CanvasVideoPlaybackUpdate,
        CanvasVideoPreviewSourceKind, CanvasVideoPreviewSourceStatus, CanvasVideoPreviewTarget,
        PreviewCancellation, ProjectCommand, ProjectCommandResult, ProjectError, ProjectPathEntry,
        ProjectPathKind, ProjectRevisionResult, ProjectSession, ProjectUploadEntry,
        RevisionedFilePlan, RevisionedFileResponse, UpdateCanvasFeedbackEntryInput,
        open_revisioned_project_file, read_project_text_file,
    },
    terminal::{
        TERMINAL_PROTOCOL_VERSION, TerminalClientFrame, TerminalEvent, TerminalObservation,
        TerminalServerFrame,
    },
};

use super::{
    RuntimeHttpServiceError, WorkbenchConnectionContext, WorkbenchRuntimeServices,
    multipart::read_multipart,
    routes::{json_body, service_error_response},
    routing::{ProjectAuthorization, WorkbenchRouterState},
    services::project_response,
    websocket::{
        MAX_WEBSOCKET_FRAME_BYTES, WebSocketConnection, WebSocketMessage, WebSocketUpgrade,
        read_message, read_text, write_close, write_pong, write_text,
    },
};

const FILE_STREAM_CHUNK: usize = 64 * 1024;

pub(super) async fn text_file(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    if request.method() == Method::GET {
        return match read_project_text_file(session.root(), &path, None) {
            Ok(file) => Json(public_text_file(file)).into_response(),
            Err(error) => project_error(error),
        };
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        content: String,
        expected_revision: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    execute_command(
        &session,
        ProjectCommand::WriteTextFile {
            project_relative_path: path,
            content: input.content,
            expected_revision: input.expected_revision,
        },
    )
}

pub(super) async fn raw_file(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, path)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    let revision = match required_query_value(&query, "v") {
        Ok(revision) => revision,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let range = single_header(&headers, header::RANGE);
    let range = match range {
        Ok(value) => value,
        Err(()) => return invalid_input("Range header is ambiguous."),
    };
    match open_revisioned_project_file(session.root(), &path, revision, range) {
        Ok(RevisionedFileResponse::File(plan)) => {
            revisioned_file_response(plan, method == Method::HEAD)
        }
        Ok(RevisionedFileResponse::RangeNotSatisfiable { file_size }) => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{file_size}"))
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(error) => project_error(error),
    }
}

pub(super) async fn create_path(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        parent_project_relative_path: String,
        name: String,
        kind: ProjectPathKind,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::CreatePath {
            parent_project_relative_path: input.parent_project_relative_path,
            name: input.name,
            kind: input.kind,
        },
    )
}

pub(super) async fn import_local(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        sources: Vec<String>,
        target_directory_project_relative_path: String,
        #[serde(default)]
        overwrite: bool,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::ImportLocalPaths {
            source_paths: input.sources.into_iter().map(Into::into).collect(),
            target_directory: input.target_directory_project_relative_path,
            overwrite: input.overwrite,
        },
    )
}

pub(super) async fn import_uploads(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Plan {
        entries: Vec<PlanEntry>,
        target_directory_project_relative_path: String,
        #[serde(default)]
        overwrite: bool,
    }
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
    enum PlanEntry {
        Directory {
            project_relative_path: String,
        },
        File {
            project_relative_path: String,
            file_field: String,
        },
    }
    let parts = match read_multipart(request).await {
        Ok(parts) => parts,
        Err(error) => return service_error_response(error),
    };
    let Some(plan) = parts.fields.get("plan") else {
        return invalid_input("Upload import plan is required.");
    };
    if parts.fields.len() != 1 {
        return invalid_input("Upload import accepts only the plan field.");
    }
    let plan: Plan = match serde_json::from_str(plan) {
        Ok(plan) => plan,
        Err(error) => return invalid_input(error.to_string()),
    };
    let mut referenced_files = std::collections::HashSet::new();
    let mut entries = Vec::with_capacity(plan.entries.len());
    for entry in plan.entries {
        match entry {
            PlanEntry::Directory {
                project_relative_path,
            } => entries.push(ProjectUploadEntry::Directory {
                project_relative_path,
            }),
            PlanEntry::File {
                project_relative_path,
                file_field,
            } => {
                let Some(file) = parts.files.get(&file_field) else {
                    return invalid_input(format!("Upload file field is missing: {file_field}"));
                };
                if !referenced_files.insert(file_field.clone()) {
                    return invalid_input(format!("Upload file field is reused: {file_field}"));
                }
                entries.push(ProjectUploadEntry::TemporaryFile {
                    project_relative_path,
                    temporary_path: file.temporary_path.clone(),
                });
            }
        }
    }
    if referenced_files.len() != parts.files.len() {
        return invalid_input("Upload request contains an undeclared file field.");
    }
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::ImportUploadEntries {
            entries,
            target_directory: plan.target_directory_project_relative_path,
            overwrite: plan.overwrite,
        },
    )
}

pub(super) async fn batch_copy(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let input: PathBatchTargetInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::CopyPaths {
            entries: input.entries,
            target_directory: input.target_directory_project_relative_path,
        },
    )
}

pub(super) async fn batch_move(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let input: PathBatchTargetInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::MovePaths {
            entries: input.entries,
            target_directory: input.target_directory_project_relative_path,
            overwrite: input.overwrite,
        },
    )
}

pub(super) async fn batch_delete(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let input: PathBatchInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::DeletePaths {
            entries: input.entries,
        },
    )
}

pub(super) async fn copy_absolute_paths(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        entries: Vec<ProjectPathEntry>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    match runtime
        .native_shell()
        .copy_absolute_paths(session.root(), &input.entries)
    {
        Ok(paths) => Json(json!({
            "paths": paths.into_iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn trash_paths(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let input: PathBatchInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    match session.trash_paths(runtime.native_shell(), &input.entries) {
        Ok(result) => command_response(&session, result),
        Err(error) => project_error(error),
    }
}

pub(super) async fn project_path(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    if request.method() == Method::POST
        && let Some(project_path) = path.strip_suffix("/reveal")
    {
        return reveal_path(state, scope, project_path.to_owned(), request).await;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        operation: String,
        name: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.operation != "rename" {
        return invalid_input("Project path operation must be rename.");
    }
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::RenamePath {
            project_relative_path: path,
            name: input.name,
        },
    )
}

async fn reveal_path(
    state: WorkbenchRouterState,
    scope: ProjectAuthorization,
    path: String,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        kind: ProjectPathKind,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let path = path.strip_suffix("/reveal").unwrap_or(&path);
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    match runtime.native_shell().reveal(
        session.root(),
        &ProjectPathEntry {
            project_relative_path: path.to_owned(),
            kind: input.kind,
        },
    ) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn generated_asset_lookup(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_path: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    with_project_root(&state, &scope, |runtime, root| {
        runtime
            .generated_assets()
            .lookup(root, &input.project_relative_path)
            .map(|lookup| json!(lookup))
    })
}

pub(super) async fn feedback_get(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    let runtime = Arc::clone(&state.services);
    match runtime
        .projects()
        .get(&scope.project_id)
        .and_then(|session| session.canvas_feedback())
    {
        Ok(result) => Json(result.value).into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn feedback_patch(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let feedback: UpdateCanvasFeedbackEntryInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::UpdateCanvasFeedback { input: feedback },
    )
}

pub(super) async fn canvas_create(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    command_for_scope(&state, &scope, ProjectCommand::CreateCanvas)
}

pub(super) async fn canvas_reorder(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        canvas_order: Vec<String>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::ReorderCanvases {
            order: input.canvas_order,
        },
    )
}

pub(super) async fn canvas_repair(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    command_for_scope(&state, &scope, ProjectCommand::RepairCanvasRegistry)
}

pub(super) async fn canvas_item(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    if method == Method::GET {
        let runtime = Arc::clone(&state.services);
        return match runtime
            .projects()
            .get(&scope.project_id)
            .and_then(|session| session.sync_snapshot())
        {
            Ok(sync) => sync
                .snapshot
                .canvases
                .into_iter()
                .find(|canvas| canvas.id == canvas_id)
                .map_or_else(
                    || StatusCode::NOT_FOUND.into_response(),
                    |canvas| Json(canvas).into_response(),
                ),
            Err(error) => project_error(error),
        };
    }
    let command = if method == Method::DELETE {
        ProjectCommand::DeleteCanvas { canvas_id }
    } else {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            operation: String,
            name: String,
        }
        let input: Input = match json_body(request).await {
            Ok(input) => input,
            Err(response) => return response,
        };
        if input.operation != "rename" {
            return invalid_input("Canvas operation must be rename.");
        }
        ProjectCommand::RenameCanvas {
            canvas_id,
            name: input.name,
        }
    };
    command_for_scope(&state, &scope, command)
}

pub(super) async fn canvas_map_add(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_path: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::AddProjectPathToCanvasMap {
            canvas_id,
            project_relative_path: input.project_relative_path,
        },
    )
}

pub(super) async fn canvas_reset(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RuleSet {
        paths: Vec<String>,
        globs: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        #[serde(default)]
        all: bool,
        path_rules: Option<RuleSet>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.all == input.path_rules.is_some() {
        return invalid_input("reset layout requires exactly one of all or pathRules.");
    }
    let rules = match input.path_rules {
        Some(rules) => {
            if rules.paths.is_empty() && rules.globs.is_empty() {
                return invalid_input("selective reset layout requires at least one path or glob.");
            }
            Some(CanvasMapPathRuleSet {
                paths: rules.paths,
                globs: rules.globs,
            })
        }
        None => None,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::ResetCanvasLayout { canvas_id, rules },
    )
}

pub(super) async fn canvas_layouts(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Update {
        project_relative_path: String,
        x: f64,
        y: f64,
        width: Option<f64>,
        height: Option<f64>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        node_layouts: Vec<Update>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.node_layouts.is_empty() {
        return invalid_input("Canvas layout update requires at least one node layout.");
    }
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::UpdateCanvasLayouts {
            canvas_id,
            updates: input
                .node_layouts
                .into_iter()
                .map(|update| CanvasNodeLayoutUpdate {
                    project_relative_path: update.project_relative_path,
                    x: update.x,
                    y: update.y,
                    width: update.width,
                    height: update.height,
                })
                .collect(),
        },
    )
}

pub(super) async fn canvas_bring_front(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_path: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::BringCanvasNodeToFront {
            canvas_id,
            project_relative_path: input.project_relative_path,
        },
    )
}

pub(super) async fn canvas_video_playback(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Update {
        project_relative_path: String,
        current_time_seconds: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        updates: Vec<Update>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.updates.is_empty() {
        return invalid_input("Canvas video playback update requires at least one target.");
    }
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::UpdateCanvasVideoPlayback {
            canvas_id,
            updates: input
                .updates
                .into_iter()
                .map(|update| CanvasVideoPlaybackUpdate {
                    project_relative_path: update.project_relative_path,
                    current_time_seconds: update.current_time_seconds,
                })
                .collect(),
        },
    )
}

pub(super) async fn canvas_text_viewport(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, canvas_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Update {
        project_relative_path: String,
        scroll_top: f64,
        scroll_left: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        updates: Vec<Update>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.updates.is_empty() {
        return invalid_input("Canvas text viewport update requires at least one target.");
    }
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::UpdateCanvasTextViewports {
            canvas_id,
            updates: input
                .updates
                .into_iter()
                .map(|update| CanvasTextViewportUpdate {
                    project_relative_path: update.project_relative_path,
                    scroll_top: update.scroll_top,
                    scroll_left: update.scroll_left,
                })
                .collect(),
        },
    )
}

pub(super) async fn image_preview(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
) -> Response {
    let width = match positive_u32(&query, "w") {
        Ok(width) => width,
        Err(response) => return response,
    };
    let path = match required_query_value(&query, "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let revision = match required_query_value(&query, "v") {
        Ok(revision) => revision,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let project_root = session.root().to_path_buf();
    let path = path.to_owned();
    let revision = revision.to_owned();
    blocking_preview_response(method == Method::HEAD, move || {
        previews.resolve_image_preview(
            &project_root,
            &path,
            &revision,
            width,
            &PreviewCancellation::default(),
        )
    })
    .await
}

pub(super) async fn text_preview_source_save(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Metadata {
        canvas_id: String,
        project_relative_path: String,
        fingerprint: String,
    }
    let parts = match read_multipart(request).await {
        Ok(parts) => parts,
        Err(error) => return service_error_response(error),
    };
    if parts.fields.len() != 1 || parts.files.len() != 1 {
        return invalid_input("Text preview upload requires exactly metadata and source parts.");
    }
    let Some(metadata) = parts.fields.get("metadata") else {
        return invalid_input("Canvas text preview metadata is required.");
    };
    let metadata: Metadata = match serde_json::from_str(metadata) {
        Ok(metadata) => metadata,
        Err(error) => return invalid_input(error.to_string()),
    };
    let Some(source) = parts.files.get("source") else {
        return invalid_input("Canvas text preview source file is required.");
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let target = CanvasTextPreviewSourceTarget {
        project_relative_path: metadata.project_relative_path,
        fingerprint: metadata.fingerprint,
    };
    match runtime.previews().save_text_preview_source(
        session.root(),
        &metadata.canvas_id,
        &target,
        &source.temporary_path,
    ) {
        Ok(()) => Json(json!({
            "ok": true,
            "source": {
                "projectRelativePath": target.project_relative_path,
                "fingerprint": target.fingerprint,
                "status": "available"
            }
        }))
        .into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn text_preview_sources(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Target {
        project_relative_path: String,
        fingerprint: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        canvas_id: String,
        sources: Vec<Target>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let targets = input
        .sources
        .into_iter()
        .map(|target| CanvasTextPreviewSourceTarget {
            project_relative_path: target.project_relative_path,
            fingerprint: target.fingerprint,
        })
        .collect::<Vec<_>>();
    let sources = runtime
        .previews()
        .read_text_preview_sources(session.root(), &input.canvas_id, &targets)
        .into_iter()
        .map(|source| (source.target.project_relative_path.clone(), source))
        .map(|(path, source)| {
            let mut value = json!({
                "projectRelativePath": source.target.project_relative_path,
                "fingerprint": source.target.fingerprint,
            });
            match source.status {
                CanvasTextPreviewSourceStatus::Available => value["status"] = json!("available"),
                CanvasTextPreviewSourceStatus::Missing => value["status"] = json!("missing"),
                CanvasTextPreviewSourceStatus::Error(message) => {
                    value["status"] = json!("error");
                    value["message"] = json!(message);
                }
            }
            (path, value)
        })
        .collect::<serde_json::Map<String, Value>>();
    Json(json!({"sources": sources})).into_response()
}

pub(super) async fn text_preview(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
) -> Response {
    let width = match positive_u32(&query, "w") {
        Ok(width) => width,
        Err(response) => return response,
    };
    let project_relative_path = match required_query_value(&query, "path") {
        Ok(path) => path.to_owned(),
        Err(response) => return response,
    };
    let fingerprint = match required_query_value(&query, "fingerprint") {
        Ok(fingerprint) => fingerprint.to_owned(),
        Err(response) => return response,
    };
    let canvas_id = match required_query_value(&query, "canvasId") {
        Ok(canvas_id) => canvas_id.to_owned(),
        Err(response) => return response,
    };
    let target = CanvasTextPreviewSourceTarget {
        project_relative_path,
        fingerprint,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let project_root = session.root().to_path_buf();
    blocking_preview_response(method == Method::HEAD, move || {
        previews.resolve_text_preview_variant(
            &project_root,
            &canvas_id,
            &target,
            width,
            &PreviewCancellation::default(),
        )
    })
    .await
}

pub(super) async fn video_preview_sources(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Target {
        project_relative_path: String,
        video_revision: String,
        current_time_seconds: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        canvas_id: String,
        targets: Vec<Target>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input
        .targets
        .iter()
        .any(|target| !target.current_time_seconds.is_finite() || target.current_time_seconds < 0.0)
    {
        return invalid_input("currentTimeSeconds must be a non-negative finite number.");
    }
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let targets = input
        .targets
        .into_iter()
        .map(|target| CanvasVideoPreviewTarget {
            project_relative_path: target.project_relative_path,
            video_revision: target.video_revision,
            current_time_seconds: target.current_time_seconds,
        })
        .collect::<Vec<_>>();
    let previews = Arc::clone(runtime.previews());
    let project_root = session.root().to_path_buf();
    let canvas_id = input.canvas_id;
    let sources = match tokio::task::spawn_blocking(move || {
        previews.video().read_sources(
            &project_root,
            &canvas_id,
            &targets,
            &PreviewCancellation::default(),
        )
    })
    .await
    .expect("Canvas video preview worker must complete")
    {
        Ok(sources) => sources,
        Err(error) => return project_error(error),
    };
    let sources = sources
        .into_iter()
        .map(|source| (source.target.project_relative_path.clone(), source))
        .map(|(path, source)| {
            let mut value = json!({
                "projectRelativePath": source.target.project_relative_path,
                "videoRevision": source.target.video_revision,
                "currentTimeSeconds": source.target.current_time_seconds,
            });
            match source.status {
                CanvasVideoPreviewSourceStatus::Available {
                    source_kind,
                    source_key,
                    source_width,
                } => {
                    value["status"] = json!("available");
                    value["sourceKind"] = json!(preview_source_kind(source_kind));
                    value["sourceKey"] = json!(source_key);
                    value["sourceWidth"] = json!(source_width);
                }
                CanvasVideoPreviewSourceStatus::Error {
                    source_kind,
                    message,
                } => {
                    value["status"] = json!("error");
                    value["sourceKind"] = json!(preview_source_kind(source_kind));
                    value["message"] = json!(message);
                }
            }
            (path, value)
        })
        .collect::<serde_json::Map<String, Value>>();
    Json(json!({"sources": sources})).into_response()
}

pub(super) async fn video_preview(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Query(query): Query<HashMap<String, String>>,
    method: Method,
) -> Response {
    let width = match positive_u32(&query, "w") {
        Ok(width) => width,
        Err(response) => return response,
    };
    let current_time_seconds = match query
        .get("t")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        Some(value) => value,
        None => return invalid_input("t must be a non-negative finite number."),
    };
    let project_relative_path = match required_query_value(&query, "path") {
        Ok(path) => path.to_owned(),
        Err(response) => return response,
    };
    let video_revision = match required_query_value(&query, "videoRevision") {
        Ok(revision) => revision.to_owned(),
        Err(response) => return response,
    };
    let canvas_id = match required_query_value(&query, "canvasId") {
        Ok(canvas_id) => canvas_id.to_owned(),
        Err(response) => return response,
    };
    let source_key = match required_query_value(&query, "sourceKey") {
        Ok(source_key) => source_key.to_owned(),
        Err(response) => return response,
    };
    let target = CanvasVideoPreviewTarget {
        project_relative_path,
        video_revision,
        current_time_seconds,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let project_root = session.root().to_path_buf();
    blocking_preview_response(method == Method::HEAD, move || {
        previews.video().resolve_variant(
            &project_root,
            &canvas_id,
            &target,
            &source_key,
            width,
            &PreviewCancellation::default(),
        )
    })
    .await
}

pub(super) async fn terminals(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
    if request.method() == Method::GET {
        return match runtime.terminals().list(&scope.project_id) {
            Ok(snapshot) => Json(json!({
                "revision": snapshot.revision,
                "sessions": snapshot.sessions
            }))
            .into_response(),
            Err(error) => terminal_error(error),
        };
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        cwd_project_relative_path: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    match runtime
        .terminals()
        .create(&scope.project_id, &input.cwd_project_relative_path)
    {
        Ok(session) => (StatusCode::CREATED, Json(json!({"session": session}))).into_response(),
        Err(error) => terminal_error(error),
    }
}

pub(super) async fn terminal_close(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, terminal_id)): Path<(String, String)>,
) -> Response {
    let runtime = Arc::clone(&state.services);
    match runtime.terminals().close(&scope.project_id, &terminal_id) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(error) => terminal_error(error),
    }
}

pub(super) async fn terminal_websocket(
    State(state): State<WorkbenchRouterState>,
    Extension(workbench_connection): Extension<WorkbenchConnectionContext>,
    Path(project_id): Path<String>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let upgrade = match WebSocketUpgrade::from_request(request) {
        Ok(upgrade) => upgrade,
        Err(response) => return response,
    };
    upgrade.on_upgrade(move |connection| {
        tokio::spawn(run_terminal_websocket(
            connection,
            runtime,
            workbench_connection.browser_session,
            project_id,
        ));
    })
}

async fn run_terminal_websocket(
    connection: WebSocketConnection,
    runtime: Arc<WorkbenchRuntimeServices>,
    browser_session: String,
    project_id: String,
) {
    let (mut reader, mut writer) = tokio::io::split(connection.into_io());
    let first = tokio::time::timeout(
        Duration::from_secs(5),
        read_text(&mut reader, MAX_WEBSOCKET_FRAME_BYTES),
    )
    .await;
    let Ok(Ok(Some(first))) = first else {
        let _ = write_close(&mut writer).await;
        return;
    };
    let Ok(TerminalClientFrame::Bind {
        protocol_version,
        connection_credential,
    }) = serde_json::from_str::<TerminalClientFrame>(&first)
    else {
        let _ = write_close(&mut writer).await;
        return;
    };
    if protocol_version != TERMINAL_PROTOCOL_VERSION {
        let _ = write_close(&mut writer).await;
        return;
    }
    let Some(mut project_lifetime) = runtime.connections().subscribe_project_lifetime(
        &browser_session,
        &connection_credential,
        &project_id,
    ) else {
        let _ = write_close(&mut writer).await;
        return;
    };
    let observer_id = uuid::Uuid::new_v4().to_string();
    let topology = match runtime.terminals().subscribe_topology(&project_id) {
        Ok(topology) => topology,
        Err(_) => {
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let observations = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
    let (sender, mut receiver) = mpsc::channel::<TerminalServerFrame>(64);
    let outbound_loss = Arc::new(tokio::sync::Notify::new());
    let mut checkpoints = Vec::new();
    for session in &topology.snapshot.sessions {
        let Ok(observation) = runtime
            .terminals()
            .observe(&project_id, &session.id, &observer_id)
        else {
            continue;
        };
        checkpoints.push(observation.checkpoint.clone());
        spawn_terminal_observation(
            session.id.clone(),
            observation,
            sender.clone(),
            Arc::clone(&observations),
            Arc::clone(&outbound_loss),
        );
    }
    let sync = TerminalServerFrame::Sync {
        protocol_version: TERMINAL_PROTOCOL_VERSION,
        topology_revision: topology.snapshot.revision,
        sessions: topology.snapshot.sessions.clone(),
        checkpoints,
    };
    if write_terminal_frame(&mut writer, &sync).await.is_err() {
        return;
    }
    let topology_sender = sender.clone();
    let topology_outbound_loss = Arc::clone(&outbound_loss);
    let topology_stop = Arc::new(AtomicBool::new(false));
    let topology_thread_stop = Arc::clone(&topology_stop);
    thread::spawn(move || {
        while !topology_thread_stop.load(Ordering::Acquire) {
            match topology.recv_timeout(Duration::from_millis(100)) {
                Ok(snapshot) => {
                    if topology_sender
                        .try_send(TerminalServerFrame::Topology {
                            topology_revision: snapshot.revision,
                            sessions: snapshot.sessions,
                        })
                        .is_err()
                    {
                        topology_outbound_loss.notify_one();
                        return;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    loop {
        tokio::select! {
            frame = receiver.recv() => {
                let Some(frame) = frame else { break; };
                if write_terminal_frame(&mut writer, &frame).await.is_err() {
                    break;
                }
            }
            incoming = read_message(&mut reader, MAX_WEBSOCKET_FRAME_BYTES) => {
                let incoming = match incoming {
                    Ok(Some(WebSocketMessage::Text(incoming))) => incoming,
                    Ok(Some(WebSocketMessage::Ping(payload))) => {
                        if write_pong(&mut writer, &payload).await.is_err() { break; }
                        continue;
                    }
                    Ok(Some(WebSocketMessage::Pong)) => continue,
                    Ok(Some(WebSocketMessage::Close) | None) | Err(_) => break,
                };
                let frame = match serde_json::from_str::<TerminalClientFrame>(&incoming) {
                    Ok(frame) => frame,
                    Err(error) => {
                        let _ = sender.try_send(terminal_protocol_error(None, "terminal_frame_invalid", error.to_string()));
                        continue;
                    }
                };
                let result = handle_terminal_client_frame(
                    &runtime,
                    &project_id,
                    &observer_id,
                    frame,
                    &sender,
                    &observations,
                    &outbound_loss,
                );
                if let Err(frame) = result
                    && sender.try_send(frame).is_err()
                {
                    break;
                }
            }
            () = outbound_loss.notified() => break,
            _ = project_lifetime.recv() => break,
        }
    }
    topology_stop.store(true, Ordering::Release);
    for stop in observations
        .lock()
        .expect("Terminal observation registry lock poisoned")
        .values()
    {
        stop.store(true, Ordering::Release);
    }
    let _ = runtime
        .terminals()
        .detach_attachment(&project_id, &observer_id);
    let _ = write_close(&mut writer).await;
}

fn handle_terminal_client_frame(
    runtime: &WorkbenchRuntimeServices,
    project_id: &str,
    observer_id: &str,
    frame: TerminalClientFrame,
    sender: &mpsc::Sender<TerminalServerFrame>,
    observations: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    outbound_loss: &Arc<tokio::sync::Notify>,
) -> Result<(), TerminalServerFrame> {
    match frame {
        TerminalClientFrame::Bind { .. } => Err(terminal_protocol_error(
            None,
            "terminal_already_bound",
            "Terminal hub is already bound.",
        )),
        TerminalClientFrame::Observe { terminal_id } => {
            if observations
                .lock()
                .expect("Terminal observation registry lock poisoned")
                .contains_key(&terminal_id)
            {
                return Ok(());
            }
            let observation = runtime
                .terminals()
                .observe(project_id, &terminal_id, observer_id)
                .map_err(|error| {
                    terminal_protocol_error(
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    )
                })?;
            sender
                .try_send(TerminalServerFrame::Observed {
                    checkpoint: observation.checkpoint.clone(),
                })
                .map_err(|_| {
                    terminal_protocol_error(
                        Some(terminal_id.clone()),
                        "terminal_backpressure",
                        "Terminal outbound queue is full.",
                    )
                })?;
            spawn_terminal_observation(
                terminal_id,
                observation,
                sender.clone(),
                Arc::clone(observations),
                Arc::clone(outbound_loss),
            );
            Ok(())
        }
        TerminalClientFrame::Unobserve { terminal_id } => {
            if let Some(stop) = observations
                .lock()
                .expect("Terminal observation registry lock poisoned")
                .remove(&terminal_id)
            {
                stop.store(true, Ordering::Release);
            }
            Ok(())
        }
        TerminalClientFrame::Input {
            terminal_id,
            sequence,
            data,
        } => {
            let acknowledged = runtime
                .terminals()
                .write_input(project_id, &terminal_id, observer_id, sequence, data)
                .map_err(|error| {
                    terminal_protocol_error(
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    )
                })?;
            sender
                .try_send(TerminalServerFrame::InputAck {
                    terminal_id: terminal_id.clone(),
                    sequence: acknowledged,
                })
                .map_err(|_| {
                    terminal_protocol_error(
                        Some(terminal_id),
                        "terminal_backpressure",
                        "Terminal outbound queue is full.",
                    )
                })
        }
        TerminalClientFrame::Resize {
            terminal_id,
            cols,
            rows,
        } => {
            let session = runtime
                .terminals()
                .resize(project_id, &terminal_id, observer_id, cols, rows)
                .map_err(|error| {
                    terminal_protocol_error(
                        Some(terminal_id.clone()),
                        error.code(),
                        error.to_string(),
                    )
                })?;
            sender
                .try_send(TerminalServerFrame::Resized {
                    terminal_id: terminal_id.clone(),
                    cols: session.cols,
                    rows: session.rows,
                })
                .map_err(|_| {
                    terminal_protocol_error(
                        Some(terminal_id),
                        "terminal_backpressure",
                        "Terminal outbound queue is full.",
                    )
                })
        }
    }
}

fn spawn_terminal_observation(
    terminal_id: String,
    observation: TerminalObservation,
    sender: mpsc::Sender<TerminalServerFrame>,
    observations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    outbound_loss: Arc<tokio::sync::Notify>,
) {
    let stop = Arc::new(AtomicBool::new(false));
    observations
        .lock()
        .expect("Terminal observation registry lock poisoned")
        .insert(terminal_id.clone(), Arc::clone(&stop));
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            match observation.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => {
                    if sender.try_send(terminal_event_frame(event)).is_err() {
                        outbound_loss.notify_one();
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        observations
            .lock()
            .expect("Terminal observation registry lock poisoned")
            .remove(&terminal_id);
    });
}

fn terminal_event_frame(event: TerminalEvent) -> TerminalServerFrame {
    match event {
        TerminalEvent::Output {
            terminal_id,
            sequence,
            data_base64,
        } => TerminalServerFrame::Output {
            terminal_id,
            sequence,
            data_base64,
        },
        TerminalEvent::Status(session) => TerminalServerFrame::Status { session },
        TerminalEvent::Exit {
            terminal_id,
            exit_code,
            signal,
        } => TerminalServerFrame::Exit {
            terminal_id,
            exit_code,
            signal,
        },
        TerminalEvent::Error {
            terminal_id,
            code,
            message,
        } => TerminalServerFrame::Error {
            terminal_id: Some(terminal_id),
            code,
            message,
        },
    }
}

fn terminal_protocol_error(
    terminal_id: Option<String>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> TerminalServerFrame {
    TerminalServerFrame::Error {
        terminal_id,
        code: code.into(),
        message: message.into(),
    }
}

async fn write_terminal_frame<Writer>(
    writer: &mut Writer,
    frame: &TerminalServerFrame,
) -> std::io::Result<()>
where
    Writer: tokio::io::AsyncWrite + Unpin,
{
    let text = serde_json::to_string(frame)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_text(writer, &text).await
}

fn command_for_scope(
    state: &WorkbenchRouterState,
    scope: &ProjectAuthorization,
    command: ProjectCommand,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    execute_command(&session, command)
}

fn execute_command(session: &ProjectSession, command: ProjectCommand) -> Response {
    match session.execute(command) {
        Ok(result) => command_response(session, result),
        Err(error) => project_error(error),
    }
}

fn command_response(
    session: &ProjectSession,
    result: ProjectRevisionResult<ProjectCommandResult>,
) -> Response {
    let body = match command_response_body(result.value) {
        Ok(body) => body,
        Err(error) => return service_error_response(error),
    };
    match project_response(session, result.project_revision, body) {
        Ok(body) => Json(body).into_response(),
        Err(error) => service_error_response(error),
    }
}

fn command_response_body(result: ProjectCommandResult) -> Result<Value, RuntimeHttpServiceError> {
    Ok(match result {
        ProjectCommandResult::Snapshot(_)
        | ProjectCommandResult::CanvasChanged { .. }
        | ProjectCommandResult::CanvasMapPathAdded { .. }
        | ProjectCommandResult::CanvasFeedbackUpdated { .. } => json!({}),
        ProjectCommandResult::CanvasCreated { canvas_id, .. } => json!({
            "activeCanvasId": canvas_id
        }),
        ProjectCommandResult::CanvasDeleted {
            active_canvas_id, ..
        }
        | ProjectCommandResult::CanvasRegistryRepaired {
            active_canvas_id, ..
        } => json!({
            "activeCanvasId": active_canvas_id
        }),
        ProjectCommandResult::CanvasLayoutReset { reset_count, .. } => json!({
            "resetCount": reset_count
        }),
        ProjectCommandResult::TextFileSaved { file, .. } => {
            json!({"file": public_text_file(file)})
        }
        ProjectCommandResult::PathChanged { result, .. } => serde_json::to_value(result)
            .map_err(|error| RuntimeHttpServiceError::serialization(&error))?,
        ProjectCommandResult::PathsChanged { results, .. } => json!({"results": results}),
    })
}

fn project_session(
    runtime: &WorkbenchRuntimeServices,
    scope: &ProjectAuthorization,
) -> Result<std::sync::Arc<ProjectSession>, Response> {
    runtime
        .projects()
        .get(&scope.project_id)
        .map_err(project_error)
}

fn with_project_root(
    state: &WorkbenchRouterState,
    scope: &ProjectAuthorization,
    operation: impl FnOnce(&WorkbenchRuntimeServices, &std::path::Path) -> Result<Value, ProjectError>,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    match operation(&runtime, session.root()) {
        Ok(value) => Json(value).into_response(),
        Err(error) => project_error(error),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathBatchInput {
    entries: Vec<ProjectPathEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathBatchTargetInput {
    entries: Vec<ProjectPathEntry>,
    target_directory_project_relative_path: String,
    #[serde(default)]
    overwrite: bool,
}

fn public_text_file(file: crate::project::ProjectTextFile) -> Value {
    json!({
        "projectRelativePath": file.project_relative_path,
        "content": file.content,
        "size": file.size,
        "mtimeMs": file.mtime_ms,
        "revision": file.revision,
        "language": file.language,
        "mimeType": file.mime_type
    })
}

fn revisioned_file_response(mut plan: RevisionedFilePlan, head: bool) -> Response {
    let status = if plan.range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let length = plan.content_length();
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, &plan.content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    if let Some(content_range) = plan.content_range() {
        response = response.header(header::CONTENT_RANGE, content_range);
    }
    if head {
        return response.body(Body::empty()).unwrap();
    }
    let start = plan.range.map_or(0, |range| range.start);
    if plan.file.seek(SeekFrom::Start(start)).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    response
        .body(Body::from_stream(FileByteStream::new(plan.file, length)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn preview_file_response(mut preview: crate::project::CanvasPreviewFile, head: bool) -> Response {
    let length = match preview.file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => return project_error(ProjectError::from(error)),
    };
    if let Err(error) = preview.file.rewind() {
        return project_error(ProjectError::from(error));
    }
    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, preview.content_type)
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, "no-cache");
    if head {
        return builder.body(Body::empty()).unwrap();
    }
    builder
        .body(Body::from_stream(FileByteStream::new(preview.file, length)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn blocking_preview_response(
    head: bool,
    task: impl FnOnce() -> Result<crate::project::CanvasPreviewFile, ProjectError> + Send + 'static,
) -> Response {
    match tokio::task::spawn_blocking(task)
        .await
        .expect("Canvas preview worker must complete")
    {
        Ok(preview) => preview_file_response(preview, head),
        Err(error) => project_error(error),
    }
}

struct FileByteStream {
    receiver: mpsc::Receiver<Result<Bytes, std::io::Error>>,
}

impl FileByteStream {
    fn new(mut file: File, mut remaining: u64) -> Self {
        let (sender, receiver) = mpsc::channel(4);
        thread::spawn(move || {
            while remaining > 0 {
                let size = usize::try_from(remaining.min(FILE_STREAM_CHUNK as u64))
                    .unwrap_or(FILE_STREAM_CHUNK);
                let mut bytes = vec![0; size];
                if let Err(error) = file.read_exact(&mut bytes) {
                    let _ = sender.blocking_send(Err(error));
                    return;
                }
                remaining -= size as u64;
                if sender.blocking_send(Ok(Bytes::from(bytes))).is_err() {
                    return;
                }
            }
        });
        Self { receiver }
    }
}

impl Stream for FileByteStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

fn project_error(error: ProjectError) -> Response {
    service_error_response(RuntimeHttpServiceError::from_project(error))
}

fn terminal_error(error: crate::terminal::TerminalError) -> Response {
    service_error_response(RuntimeHttpServiceError::new(
        StatusCode::BAD_REQUEST,
        error.code(),
        error.to_string(),
    ))
}

fn invalid_input(message: impl Into<String>) -> Response {
    service_error_response(RuntimeHttpServiceError::new(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        message,
    ))
}

fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Result<Option<&str>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    value.to_str().map(Some).map_err(|_| ())
}

fn positive_u32(query: &HashMap<String, String>, key: &str) -> Result<u32, Response> {
    query
        .get(key)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_input(format!("{key} must be a positive integer.")))
}

fn required_query_value<'a>(
    query: &'a HashMap<String, String>,
    key: &str,
) -> Result<&'a str, Response> {
    query
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_input(format!("{key} is required and must not be empty.")))
}

fn preview_source_kind(kind: CanvasVideoPreviewSourceKind) -> &'static str {
    match kind {
        CanvasVideoPreviewSourceKind::InitialPoster => "initial-poster",
        CanvasVideoPreviewSourceKind::PlaybackFrame => "playback-frame",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preview_file_response_streams_the_complete_file_from_its_start() {
        let path = std::env::temp_dir().join(format!(
            "debrute-preview-response-{}.png",
            uuid::Uuid::new_v4()
        ));
        let expected = b"complete preview bytes";
        std::fs::write(&path, expected).unwrap();
        let mut file = File::open(&path).unwrap();
        file.seek(SeekFrom::Start(9)).unwrap();

        let response = preview_file_response(
            crate::project::CanvasPreviewFile {
                absolute_path: path.clone(),
                file,
                content_type: "image/png",
            },
            false,
        );
        let body = axum::body::to_bytes(response.into_body(), expected.len())
            .await
            .unwrap();

        assert_eq!(body.as_ref(), expected);
        std::fs::remove_file(path).unwrap();
    }
}
