#![allow(clippy::result_large_err)]

use std::{
    collections::HashMap,
    fs::File,
    io::{Read as _, Seek as _, SeekFrom},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    thread,
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

use crate::project::{
    CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS, CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES,
    CANVAS_VIDEO_TIME_MAX_MS, CanvasMediaKind, CanvasStatePatch, CanvasTextPreviewSourceStatus,
    CanvasTextPreviewSourceTarget, CanvasVideoMetadata, CanvasVideoPreviewSourceStatus,
    CanvasVideoPreviewTarget, PreviewCancellation, ProjectCommand, ProjectCommandResult,
    ProjectDirectoryPath, ProjectError, ProjectFileSourceTarget, ProjectPathBatchAttempt,
    ProjectPathClipboardFormat, ProjectPathKind, ProjectPathRef, ProjectRelativePath,
    ProjectRevisionResult, ProjectSession, ProjectUploadEntry, RevisionedFilePlan,
    RevisionedFileResponse, UpdateCanvasFeedbackInput, admit_project_path_entries,
    canvas_media_kind_from_path, open_leased_project_file, read_project_text_file,
    resolve_existing_project_path,
};

use super::{
    RuntimeHttpServiceError, WorkbenchConnectionContext, WorkbenchRuntimeServices,
    multipart::{MultipartLimits, read_multipart, read_multipart_limited},
    routes::{json_body, json_body_with_limit, service_error_response},
    routing::{ProjectAuthorization, WorkbenchRouterState},
    services::{make_canvas_resolved_source_public, project_file_url, project_response},
    terminal_hub,
    websocket::WebSocketUpgrade,
};

const FILE_STREAM_CHUNK: usize = 64 * 1024;
const VIDEO_PREVIEW_SOURCE_MULTIPART_LIMITS: MultipartLimits = MultipartLimits {
    total_bytes: CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES + 128 * 1024,
    file_bytes: CANVAS_VIDEO_PREVIEW_SOURCE_MAX_BYTES,
    fields_bytes: 64 * 1024,
    parts: 2,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectUploadImportPlan {
    entries: Vec<ProjectUploadImportPlanEntry>,
    target_directory_project_relative_path: String,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ProjectUploadImportPlanEntry {
    Directory {
        relative_path: String,
    },
    File {
        relative_path: String,
        file_field: String,
    },
}

pub(super) async fn text_file(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_binding_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    if request.method() == Method::GET {
        return match read_project_text_file(session.root(), &path) {
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
    let input: Input = match json_body_with_limit(request, usize::MAX).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let path = match ProjectRelativePath::parse(&path) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
    execute_command(
        &session,
        &scope.binding_id,
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
    Path((_binding_id, path)): Path<(String, String)>,
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
    let path = match ProjectRelativePath::parse(&path) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
    let lease = match session.project_file_source_lease(&path, revision) {
        Ok(lease) => lease,
        Err(error) => return project_error(error),
    };
    match open_leased_project_file(&lease, range) {
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

pub(super) async fn inspect_project_path(
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
    let path = match ProjectDirectoryPath::parse(&input.project_relative_path) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
    let session = match project_session(&state.services, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let result = tokio::task::spawn_blocking(move || session.inspect_project_path(&path))
        .await
        .expect("Project path inspection worker must complete");
    match result {
        Ok(inspection) => Json(inspection).into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn resolve_project_file_source(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_path: String,
        source_token: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let target = match ProjectRelativePath::parse(&input.project_relative_path) {
        Ok(project_relative_path) => ProjectFileSourceTarget {
            project_relative_path,
            source_token: input.source_token,
        },
        Err(error) => return project_error(error),
    };
    let session = match project_session(&state.services, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let binding_id = scope.binding_id.clone();
    let source_digests = Arc::clone(state.services.project_source_digests());
    let result = tokio::task::spawn_blocking(move || {
        session.resolve_project_file_source(&target, &source_digests)
    })
    .await
    .expect("Project file source worker must complete");
    match result {
        Ok(source) => Json(json!({
            "projectRelativePath": source.project_relative_path,
            "sourceRevision": source.revision,
            "fileUrl": project_file_url(
                &binding_id,
                &source.project_relative_path,
                &source.revision,
            )
        }))
        .into_response(),
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
    let parent = match ProjectDirectoryPath::parse(&input.parent_project_relative_path) {
        Ok(parent) => parent,
        Err(error) => return project_error(error),
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::CreatePath {
            parent_project_relative_path: parent,
            name: input.name,
            kind: input.kind,
        },
    )
}

pub(super) async fn load_directory(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_directory: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let directory = match ProjectDirectoryPath::parse(&input.project_relative_directory) {
        Ok(directory) => directory,
        Err(error) => return project_error(error),
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::LoadDirectory {
            project_relative_directory: directory,
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
    let target_directory =
        match ProjectDirectoryPath::parse(&input.target_directory_project_relative_path) {
            Ok(target) => target,
            Err(error) => return project_error(error),
        };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::ImportLocalPaths {
            source_paths: input.sources.into_iter().map(Into::into).collect(),
            target_directory,
            overwrite: input.overwrite,
        },
    )
}

pub(super) async fn import_uploads(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
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
    let plan: ProjectUploadImportPlan = match serde_json::from_str(plan) {
        Ok(plan) => plan,
        Err(error) => return invalid_input(error.to_string()),
    };
    let target_directory =
        match ProjectDirectoryPath::parse(&plan.target_directory_project_relative_path) {
            Ok(target) => target,
            Err(error) => return project_error(error),
        };
    let mut referenced_files = std::collections::HashSet::new();
    let mut entries = Vec::with_capacity(plan.entries.len());
    for entry in plan.entries {
        match entry {
            ProjectUploadImportPlanEntry::Directory { relative_path } => {
                let project_relative_path =
                    match project_upload_target(&target_directory, &relative_path) {
                        Ok(path) => path,
                        Err(error) => return project_error(error),
                    };
                entries.push(ProjectUploadEntry::Directory {
                    project_relative_path,
                });
            }
            ProjectUploadImportPlanEntry::File {
                relative_path,
                file_field,
            } => {
                let Some(file) = parts.files.get(&file_field) else {
                    return invalid_input(format!("Upload file field is missing: {file_field}"));
                };
                if !referenced_files.insert(file_field.clone()) {
                    return invalid_input(format!("Upload file field is reused: {file_field}"));
                }
                let project_relative_path =
                    match project_upload_target(&target_directory, &relative_path) {
                        Ok(path) => path,
                        Err(error) => return project_error(error),
                    };
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
            target_directory,
            overwrite: plan.overwrite,
        },
    )
}

fn project_upload_target(
    target_directory: &ProjectDirectoryPath,
    relative_path: &str,
) -> Result<ProjectRelativePath, ProjectError> {
    let relative = ProjectRelativePath::parse(relative_path)?;
    let target = if target_directory.is_root() {
        relative.as_str().to_owned()
    } else {
        format!("{target_directory}/{relative}")
    };
    ProjectRelativePath::parse(&target)
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
    let target_directory =
        match ProjectDirectoryPath::parse(&input.target_directory_project_relative_path) {
            Ok(target) => target,
            Err(error) => return project_error(error),
        };
    let entries = match admit_project_path_entries(input.entries) {
        Ok(entries) => entries,
        Err(error) => return project_error(error),
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::CopyPaths {
            entries,
            target_directory,
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
    let target_directory =
        match ProjectDirectoryPath::parse(&input.target_directory_project_relative_path) {
            Ok(target) => target,
            Err(error) => return project_error(error),
        };
    let entries = match admit_project_path_entries(input.entries) {
        Ok(entries) => entries,
        Err(error) => return project_error(error),
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::MovePaths {
            entries,
            target_directory,
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
    let entries = match admit_project_path_entries(input.entries) {
        Ok(entries) => entries,
        Err(error) => return project_error(error),
    };
    command_for_scope(&state, &scope, ProjectCommand::DeletePaths { entries })
}

pub(super) async fn copy_paths_to_system_clipboard(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    enum Format {
        Absolute,
        Relative,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        format: Format,
        entries: Vec<ProjectPathRef>,
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
    match runtime.native_shell().copy_paths_to_system_clipboard(
        session.root(),
        match input.format {
            Format::Absolute => ProjectPathClipboardFormat::Absolute,
            Format::Relative => ProjectPathClipboardFormat::Relative,
        },
        &input.entries,
    ) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
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
        Ok(result) => command_response(&scope.binding_id, result),
        Err(error) => project_error(error),
    }
}

pub(super) async fn project_path(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_binding_id, path)): Path<(String, String)>,
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
    let path = match ProjectRelativePath::parse(&path) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
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
        &ProjectPathRef {
            project_relative_path: path.to_owned(),
            kind: input.kind,
        },
    ) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn model_artifact_lookup(
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
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let relative = match ProjectDirectoryPath::parse(&input.project_relative_path) {
        Ok(relative) => relative,
        Err(error) => return project_error(error),
    };
    let path = match resolve_existing_project_path(session.root(), &relative) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
    let provenance = Arc::clone(runtime.provenance());
    match tokio::task::spawn_blocking(move || provenance.lookup(&path))
        .await
        .expect("Model Artifact provenance worker must complete")
    {
        Ok(lookup) => Json(json!(lookup)).into_response(),
        Err(error) => project_error(error),
    }
}

pub(super) async fn feedback_get(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    let runtime = Arc::clone(&state.services);
    match runtime
        .projects()
        .get(std::path::Path::new(&scope.canonical_root))
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
    let feedback: UpdateCanvasFeedbackInput = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    command_for_scope(
        &state,
        &scope,
        ProjectCommand::UpdateCanvasFeedback { input: feedback },
    )
}

pub(super) async fn canvas_reset(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    command_for_scope(&state, &scope, ProjectCommand::ResetCanvas)
}

pub(super) async fn canvas_state_patch(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path(_binding_id): Path<String>,
    request: Request,
) -> Response {
    let patch: CanvasStatePatch = match json_body(request).await {
        Ok(patch) => patch,
        Err(response) => return response,
    };
    command_for_scope(&state, &scope, ProjectCommand::PatchCanvasState { patch })
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
    let revision = match required_query_value(&query, "sourceRevision") {
        Ok(revision) => revision,
        Err(response) => return response,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let path = match ProjectRelativePath::parse(path) {
        Ok(path) => path,
        Err(error) => return project_error(error),
    };
    let revision = revision.to_owned();
    blocking_preview_response(
        method == Method::HEAD,
        PreviewCachePolicy::Immutable,
        move |cancellation| {
            let lease = session.project_file_source_lease(&path, &revision)?;
            previews.resolve_image_preview_lease(&lease, width, cancellation)
        },
    )
    .await
}

pub(super) async fn canvas_sources_resolve(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Target {
        project_relative_path: String,
        source_token: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        targets: Vec<Target>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.targets.is_empty() {
        return invalid_input("Canvas source resolution requires at least one target.");
    }
    let targets = match input
        .targets
        .into_iter()
        .map(|target| {
            Ok(ProjectFileSourceTarget {
                project_relative_path: ProjectRelativePath::parse(&target.project_relative_path)?,
                source_token: target.source_token,
            })
        })
        .collect::<Result<Vec<_>, ProjectError>>()
    {
        Ok(targets) => targets,
        Err(error) => return project_error(error),
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let binding_id = scope.binding_id.clone();
    let source_digests = Arc::clone(runtime.project_source_digests());
    let result = tokio::task::spawn_blocking(move || {
        session.resolve_canvas_sources(&targets, &source_digests)
    })
    .await
    .expect("Canvas source worker must complete");
    match result {
        Ok(mut view) => {
            for source in &mut view.sources {
                make_canvas_resolved_source_public(source, &binding_id);
            }
            Json(view).into_response()
        }
        Err(error) => project_error(error),
    }
}

pub(super) async fn text_preview_source_save(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Metadata {
        project_relative_path: String,
        target_identity: String,
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
        target_identity: metadata.target_identity,
    };
    match runtime.previews().save_text_preview_source(
        session.root(),
        &target,
        &source.temporary_path,
    ) {
        Ok(()) => Json(json!({
            "ok": true,
            "source": {
                "projectRelativePath": target.project_relative_path,
                "targetIdentity": target.target_identity,
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
        target_identity: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
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
            target_identity: target.target_identity,
        })
        .collect::<Vec<_>>();
    let sources = runtime
        .previews()
        .read_text_preview_sources(session.root(), &targets)
        .into_iter()
        .map(|source| (source.target.project_relative_path.clone(), source))
        .map(|(path, source)| {
            let mut value = json!({
                "projectRelativePath": source.target.project_relative_path,
                "targetIdentity": source.target.target_identity,
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
    let target_identity = match required_query_value(&query, "targetIdentity") {
        Ok(target_identity) => target_identity.to_owned(),
        Err(response) => return response,
    };
    let target = CanvasTextPreviewSourceTarget {
        project_relative_path,
        target_identity,
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let project_root = session.root().to_path_buf();
    blocking_preview_response(
        method == Method::HEAD,
        PreviewCachePolicy::Revalidate,
        move |cancellation| {
            previews.resolve_text_preview_variant(&project_root, &target, width, cancellation)
        },
    )
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
        source_revision: String,
        frame_time_ms: u64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        targets: Vec<Target>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    if input.targets.is_empty() || input.targets.len() > CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS {
        return invalid_input(format!(
            "Canvas video preview source read requires between 1 and {CANVAS_VIDEO_PREVIEW_READ_MAX_TARGETS} targets."
        ));
    }
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let targets = match input
        .targets
        .into_iter()
        .map(|target| {
            canvas_video_preview_target(
                &target.project_relative_path,
                target.source_revision,
                target.frame_time_ms,
            )
        })
        .collect::<Result<Vec<_>, Response>>()
    {
        Ok(targets) => targets,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    let sources = match blocking_preview_task(move |cancellation| {
        previews
            .video()
            .read_sources(&targets, cancellation, |target| {
                session.project_file_source_lease(
                    &target.project_relative_path,
                    &target.source_revision,
                )
            })
    })
    .await
    {
        Ok(sources) => sources,
        Err(error) => return project_error(error),
    };
    let sources = sources
        .into_iter()
        .map(|source| {
            let mut value = json!({
                "projectRelativePath": source.target.project_relative_path.as_str(),
                "sourceRevision": source.target.source_revision,
                "frameTimeMs": source.target.frame_time_ms,
            });
            match source.status {
                CanvasVideoPreviewSourceStatus::Available {
                    source_width,
                    metadata,
                } => {
                    value["status"] = json!("available");
                    value["sourceWidth"] = json!(source_width);
                    value["metadata"] = json!(metadata);
                }
                CanvasVideoPreviewSourceStatus::Missing { metadata } => {
                    value["status"] = json!("missing");
                    if let Some(metadata) = metadata {
                        value["metadata"] = json!(metadata);
                    }
                }
                CanvasVideoPreviewSourceStatus::Error { message } => {
                    value["status"] = json!("error");
                    value["message"] = json!(message);
                }
            }
            value
        })
        .collect::<Vec<_>>();
    Json(json!({"sources": sources})).into_response()
}

pub(super) async fn video_preview_source_save(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Metadata {
        project_relative_path: String,
        source_revision: String,
        frame_time_ms: u64,
        metadata: CanvasVideoMetadata,
    }
    let parts = match read_multipart_limited(request, VIDEO_PREVIEW_SOURCE_MULTIPART_LIMITS).await {
        Ok(parts) => parts,
        Err(error) => return service_error_response(error),
    };
    if parts.fields.len() != 1 || parts.files.len() != 1 {
        return invalid_input("Video preview upload requires exactly metadata and source parts.");
    }
    let Some(metadata) = parts.fields.get("metadata") else {
        return invalid_input("Canvas video preview metadata is required.");
    };
    let input: Metadata = match serde_json::from_str(metadata) {
        Ok(input) => input,
        Err(error) => return invalid_input(error.to_string()),
    };
    let Some(source) = parts.files.get("source") else {
        return invalid_input("Canvas video preview source JPEG is required.");
    };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let target = match canvas_video_preview_target(
        &input.project_relative_path,
        input.source_revision,
        input.frame_time_ms,
    ) {
        Ok(target) => target,
        Err(response) => return response,
    };
    let uploaded_source = source.temporary_path.clone();
    let metadata = input.metadata;
    let previews = Arc::clone(runtime.previews());
    let save_session = Arc::clone(&session);
    let result = match blocking_preview_task(move |cancellation| {
        let lease = save_session
            .project_file_source_lease(&target.project_relative_path, &target.source_revision)?;
        previews
            .video()
            .save_source(&lease, &target, metadata, &uploaded_source, cancellation)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => return project_error(error),
    };
    let CanvasVideoPreviewSourceStatus::Available {
        source_width,
        metadata,
    } = result.status
    else {
        unreachable!("a saved Canvas video preview source is available");
    };
    if let Err(error) = session.canvas_video_preview_source_saved(
        result.target.project_relative_path.as_str(),
        result.target.frame_time_ms,
    ) {
        return project_error(error);
    }
    Json(json!({
        "ok": true,
        "source": {
            "projectRelativePath": result.target.project_relative_path.as_str(),
            "sourceRevision": result.target.source_revision,
            "frameTimeMs": result.target.frame_time_ms,
            "status": "available",
            "sourceWidth": source_width,
            "metadata": metadata,
        }
    }))
    .into_response()
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
    let frame_time_ms = match query
        .get("frameTimeMs")
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => {
            return invalid_input(
                "frameTimeMs must be a non-negative safe integer in milliseconds.",
            );
        }
    };
    let project_relative_path = match required_query_value(&query, "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let source_revision = match required_query_value(&query, "sourceRevision") {
        Ok(revision) => revision.to_owned(),
        Err(response) => return response,
    };
    let target =
        match canvas_video_preview_target(project_relative_path, source_revision, frame_time_ms) {
            Ok(target) => target,
            Err(response) => return response,
        };
    let runtime = Arc::clone(&state.services);
    let session = match project_session(&runtime, &scope) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let previews = Arc::clone(runtime.previews());
    blocking_preview_response(
        method == Method::HEAD,
        PreviewCachePolicy::Revalidate,
        move |cancellation| {
            let lease = session.project_file_source_lease(
                &target.project_relative_path,
                &target.source_revision,
            )?;
            previews
                .video()
                .resolve_variant(&lease, &target, width, cancellation)
        },
    )
    .await
}

pub(super) async fn terminal_create(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
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
        .create(&scope.canonical_root, &input.cwd_project_relative_path)
    {
        Ok(session) => (StatusCode::CREATED, Json(json!({"session": session}))).into_response(),
        Err(error) => terminal_error(error),
    }
}

pub(super) async fn terminal_close(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_binding_id, terminal_id)): Path<(String, String)>,
) -> Response {
    let runtime = Arc::clone(&state.services);
    match runtime
        .terminals()
        .close(&scope.canonical_root, &terminal_id)
    {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(error) => terminal_error(error),
    }
}

pub(super) async fn terminal_websocket(
    State(state): State<WorkbenchRouterState>,
    Extension(workbench_connection): Extension<WorkbenchConnectionContext>,
    Path(binding_id): Path<String>,
    request: Request,
) -> Response {
    let runtime = Arc::clone(&state.services);
    let connections = Arc::clone(runtime.connections());
    let terminals = runtime.terminals().clone();
    let canonical_root = workbench_connection
        .canonical_root
        .clone()
        .expect("authorized Terminal binding has a canonical root");
    let upgrade = match WebSocketUpgrade::from_request(request) {
        Ok(upgrade) => upgrade,
        Err(response) => return response,
    };
    upgrade.on_upgrade(move |connection| {
        tokio::spawn(terminal_hub::run(
            connection.into_io(),
            connections,
            terminals,
            workbench_connection.browser_session,
            binding_id,
            canonical_root,
        ));
    })
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
    execute_command(&session, &scope.binding_id, command)
}

fn execute_command(
    session: &ProjectSession,
    binding_id: &str,
    command: ProjectCommand,
) -> Response {
    match session.execute(command) {
        Ok(result) => command_response(binding_id, result),
        Err(error) => project_error(error),
    }
}

fn command_response(
    binding_id: &str,
    result: ProjectRevisionResult<ProjectCommandResult>,
) -> Response {
    let body = match command_response_body(result.value) {
        Ok(body) => body,
        Err(error) => return service_error_response(error),
    };
    match project_response(binding_id, result.project_revision, body) {
        Ok(body) => Json(body).into_response(),
        Err(error) => service_error_response(error),
    }
}

fn command_response_body(result: ProjectCommandResult) -> Result<Value, RuntimeHttpServiceError> {
    Ok(match result {
        ProjectCommandResult::Snapshot(_)
        | ProjectCommandResult::CanvasStateUpdated
        | ProjectCommandResult::CanvasFeedbackUpdated { .. } => {
            json!({})
        }
        ProjectCommandResult::TextFileSaved { file, .. } => {
            json!({"file": public_text_file(file)})
        }
        ProjectCommandResult::PathChanged { result, .. } => serde_json::to_value(result)
            .map_err(|error| RuntimeHttpServiceError::serialization(&error))?,
        ProjectCommandResult::PathsChanged { results, .. } => json!({"results": results}),
        ProjectCommandResult::PathsAttempted { attempt, .. } => match attempt {
            ProjectPathBatchAttempt::Applied(results) => {
                json!({"outcome": "applied", "results": results})
            }
            ProjectPathBatchAttempt::Conflict => json!({"outcome": "conflict"}),
        },
    })
}

fn project_session(
    runtime: &WorkbenchRuntimeServices,
    scope: &ProjectAuthorization,
) -> Result<std::sync::Arc<ProjectSession>, Response> {
    runtime
        .projects()
        .get(std::path::Path::new(&scope.canonical_root))
        .map_err(project_error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathBatchInput {
    entries: Vec<ProjectPathRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathBatchTargetInput {
    entries: Vec<ProjectPathRef>,
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

#[derive(Clone, Copy)]
enum PreviewCachePolicy {
    Revalidate,
    Immutable,
}

impl PreviewCachePolicy {
    fn header_value(self) -> &'static str {
        match self {
            Self::Revalidate => "no-cache",
            Self::Immutable => "private, max-age=31536000, immutable",
        }
    }
}

fn preview_file_response(
    mut preview: crate::project::CanvasPreviewFile,
    head: bool,
    cache_policy: PreviewCachePolicy,
) -> Response {
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
        .header(header::CACHE_CONTROL, cache_policy.header_value());
    if head {
        return builder.body(Body::empty()).unwrap();
    }
    builder
        .body(Body::from_stream(FileByteStream::new(preview.file, length)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn blocking_preview_response(
    head: bool,
    cache_policy: PreviewCachePolicy,
    task: impl FnOnce(&PreviewCancellation) -> Result<crate::project::CanvasPreviewFile, ProjectError>
    + Send
    + 'static,
) -> Response {
    match blocking_preview_task(task).await {
        Ok(preview) => preview_file_response(preview, head, cache_policy),
        Err(error) => project_error(error),
    }
}

async fn blocking_preview_task<T: Send + 'static>(
    task: impl FnOnce(&PreviewCancellation) -> Result<T, ProjectError> + Send + 'static,
) -> Result<T, ProjectError> {
    let cancellation = PreviewCancellation::default();
    let worker_cancellation = cancellation.clone();
    let _request_cancellation = PreviewRequestCancellation(cancellation);
    tokio::task::spawn_blocking(move || task(&worker_cancellation))
        .await
        .expect("Canvas preview worker must complete")
}

struct PreviewRequestCancellation(PreviewCancellation);

impl Drop for PreviewRequestCancellation {
    fn drop(&mut self) {
        self.0.cancel();
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

fn canvas_video_preview_target(
    project_relative_path: &str,
    source_revision: String,
    frame_time_ms: u64,
) -> Result<CanvasVideoPreviewTarget, Response> {
    if frame_time_ms > CANVAS_VIDEO_TIME_MAX_MS {
        return Err(invalid_input(
            "frameTimeMs must be a non-negative safe integer in milliseconds.",
        ));
    }
    let project_relative_path = ProjectRelativePath::parse(project_relative_path)
        .map_err(|error| invalid_input(error.to_string()))?;
    if source_revision.is_empty() {
        return Err(invalid_input(
            "Canvas video source revision must be non-empty.",
        ));
    }
    if canvas_media_kind_from_path(project_relative_path.as_str()) != CanvasMediaKind::Video {
        return Err(invalid_input(format!(
            "Canvas video preview path is not a video candidate: {}",
            project_relative_path.as_str()
        )));
    }
    Ok(CanvasVideoPreviewTarget {
        project_relative_path,
        source_revision,
        frame_time_ms,
    })
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

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    use super::*;

    #[test]
    fn upload_relative_paths_are_joined_and_validated_only_by_runtime() {
        let target = ProjectDirectoryPath::parse("assets/imported").unwrap();
        assert_eq!(
            project_upload_target(&target, "folder/片段.png")
                .unwrap()
                .as_str(),
            "assets/imported/folder/片段.png"
        );
        assert!(project_upload_target(&target, "../outside.png").is_err());
        assert!(project_upload_target(&target, "/absolute.png").is_err());
    }

    #[test]
    fn upload_import_plan_accepts_the_camel_case_protocol_fields() {
        let plan: ProjectUploadImportPlan = serde_json::from_value(serde_json::json!({
            "entries": [
                { "kind": "directory", "relativePath": "folder" },
                {
                    "kind": "file",
                    "relativePath": "folder/clip.png",
                    "fileField": "file:1"
                }
            ],
            "targetDirectoryProjectRelativePath": "assets",
            "overwrite": true
        }))
        .unwrap();

        assert_eq!(plan.target_directory_project_relative_path, "assets");
        assert!(plan.overwrite);
        assert!(matches!(
            &plan.entries[0],
            ProjectUploadImportPlanEntry::Directory { relative_path }
                if relative_path == "folder"
        ));
        assert!(matches!(
            &plan.entries[1],
            ProjectUploadImportPlanEntry::File {
                relative_path,
                file_field
            } if relative_path == "folder/clip.png" && file_field == "file:1"
        ));
    }

    #[test]
    fn upload_import_plan_rejects_legacy_or_rust_field_spellings() {
        assert!(
            serde_json::from_value::<ProjectUploadImportPlan>(serde_json::json!({
                "entries": [{
                    "kind": "file",
                    "relative_path": "clip.png",
                    "file_field": "file:1"
                }],
                "targetDirectoryProjectRelativePath": "assets"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ProjectUploadImportPlan>(serde_json::json!({
                "entries": [{
                    "kind": "file",
                    "projectRelativePath": "assets/clip.png",
                    "fileField": "file:1"
                }],
                "targetDirectoryProjectRelativePath": "assets"
            }))
            .is_err()
        );
    }

    #[tokio::test]
    async fn dropping_a_preview_request_cancels_its_blocking_worker() {
        let started = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_started = Arc::clone(&started);
        let worker_cancelled = Arc::clone(&cancelled);
        let request = tokio::spawn(blocking_preview_response(
            false,
            PreviewCachePolicy::Revalidate,
            move |cancellation| {
                worker_started.store(true, Ordering::Release);
                while cancellation.check().is_ok() {
                    thread::sleep(Duration::from_millis(1));
                }
                worker_cancelled.store(true, Ordering::Release);
                Err(cancellation
                    .check()
                    .expect_err("dropped request must cancel the preview worker"))
            },
        ));
        for _ in 0..100 {
            if started.load(Ordering::Acquire) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(started.load(Ordering::Acquire));

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        for _ in 0..100 {
            if cancelled.load(Ordering::Acquire) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("preview worker did not observe request cancellation");
    }

    #[tokio::test]
    async fn preview_request_cancellation_reaches_a_blocking_worker_within_the_drain_budget() {
        let started = Arc::new(tokio::sync::Notify::new());
        let cancellation_observed = Arc::new(tokio::sync::Notify::new());
        let worker_started = Arc::clone(&started);
        let worker_observed = Arc::clone(&cancellation_observed);
        let request = tokio::spawn(blocking_preview_response(
            false,
            PreviewCachePolicy::Revalidate,
            move |cancellation| {
                worker_started.notify_one();
                while cancellation.check().is_ok() {
                    thread::yield_now();
                }
                worker_observed.notify_one();
                Err(cancellation
                    .check()
                    .expect_err("dropped request must cancel the preview worker"))
            },
        ));
        tokio::time::timeout(Duration::from_millis(500), started.notified())
            .await
            .expect("blocking preview worker must start within the HTTP drain budget");

        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_millis(500), cancellation_observed.notified())
            .await
            .expect(
                "blocking preview worker must observe cancellation within the HTTP drain budget",
            );
    }

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
            PreviewCachePolicy::Revalidate,
        );
        let body = axum::body::to_bytes(response.into_body(), expected.len())
            .await
            .unwrap();

        assert_eq!(body.as_ref(), expected);
        std::fs::remove_file(path).unwrap();
    }
}
