#![allow(
    clippy::items_after_statements,
    clippy::manual_let_else,
    clippy::needless_pass_by_value,
    clippy::result_large_err,
    clippy::too_many_lines
)]

use std::{
    any::Any,
    convert::Infallible,
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{Extension, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header, header::SET_COOKIE},
    response::{IntoResponse, Response, sse::Event, sse::Sse},
    routing::{delete, get, patch, post, put},
};
use futures_core::Stream;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::{
    global::{GlobalRuntimeChange, GlobalRuntimeEvent},
    project::{ProjectChange, ProjectStreamItem},
};

use super::{
    DesktopConnectionAdmission, FeedbackWorkingCopy, ProductUpdateInitiator,
    RuntimeHttpServiceError, TextWorkingCopy, WORKBENCH_SESSION_COOKIE, WorkbenchLaunchService,
    WorkbenchProjectBindingOutcome, WorkbenchRuntimeServices,
    multipart::{MultipartLimits, read_multipart_limited},
    public_project_snapshot,
    routing::{
        BrowserSession, CliRequestAuthorization, ProjectAuthorization, WorkbenchRouterState,
        browser_session_cookie, error_response,
    },
    services::public_canvas_projection,
};

const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_EDITABLE_PROJECT_TEXT_JSON_BODY_BYTES: usize =
    crate::project::MAX_EDITABLE_PROJECT_TEXT_BYTES as usize * 6 + 512;
const STREAM_CHANNEL_CAPACITY: usize = 64;

pub(super) async fn workbench_connection(
    State(state): State<WorkbenchRouterState>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if headers.contains_key(header::AUTHORIZATION)
        || !matches!(one_header(&headers, "origin"), Ok(Some(origin)) if origin == state.origin)
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "workbench_connection_origin_invalid",
            "Workbench connection requires the exact Runtime origin.",
        );
    }
    if !headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|item| item.trim() == "text/event-stream")
        })
    {
        return error_response(
            StatusCode::NOT_ACCEPTABLE,
            "workbench_connection_accept_required",
            "Workbench connection requires Accept: text/event-stream.",
        );
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        requested_project_id: Option<String>,
        desktop_launch_ticket: Option<String>,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let services = Arc::clone(&state.services);
    if let Err(error) = services.ensure_accepting_workbench_connections() {
        return service_error_response(error);
    }
    let (browser_session, desktop, requested_project_id) =
        if let Some(ticket) = input.desktop_launch_ticket.as_deref() {
            let Some(consumption) = state.launch_service.consume_desktop_ticket(ticket) else {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "desktop_launch_ticket_invalid",
                    "Desktop launch ticket is invalid or already consumed.",
                );
            };
            let reusable_empty = matches!(consumption.route, crate::control::WorkbenchRoute::Root);
            let route_project_id = match consumption.route {
                crate::control::WorkbenchRoute::Root => None,
                crate::control::WorkbenchRoute::Project { project_id } => Some(project_id),
            };
            if input.requested_project_id != route_project_id {
                return error_response(
                    StatusCode::CONFLICT,
                    "desktop_launch_route_mismatch",
                    "Desktop launch route does not match the requested Project.",
                );
            }
            (
                consumption.browser_session,
                Some(DesktopConnectionAdmission {
                    binding: consumption.desktop,
                    reusable_empty,
                }),
                route_project_id,
            )
        } else {
            let browser_session = match browser_session_cookie(&headers) {
                Ok(Some(session)) if services.connections().browser_session_is_live(session) => {
                    session.to_owned()
                }
                Ok(_) => WorkbenchLaunchService::create_browser_session(),
                Err(()) => {
                    return error_response(
                        StatusCode::FORBIDDEN,
                        "workbench_session_invalid",
                        "Workbench session cookie is invalid.",
                    );
                }
            };
            (browser_session, None, input.requested_project_id)
        };
    let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let Some((context, cancellation)) =
        services
            .connections()
            .open(browser_session.clone(), desktop, sender.clone())
    else {
        return service_error_response(RuntimeHttpServiceError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_not_ready",
            "Runtime is not accepting new Workbench connections.",
        ));
    };
    if sender
        .try_send(json!({
            "type": "connection.opened",
            "connectionCredential": context.credential
        }))
        .is_err()
    {
        services.request_workbench_connection_close(context.credential.clone());
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_unavailable",
            "Workbench connection closed during bootstrap.",
        );
    }
    let mut global_subscription = services.subscribe_global();
    let (global_revision, settings, product) = match services.global().sync_snapshot() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            services.request_workbench_connection_close(context.credential.clone());
            return service_error_response(RuntimeHttpServiceError::from_global(error));
        }
    };
    if sender
        .try_send(json!({
            "type": "global.snapshot",
            "globalRevision": global_revision,
            "snapshot": {
                "settings": settings
            }
        }))
        .is_err()
    {
        services.request_workbench_connection_close(context.credential.clone());
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_unavailable",
            "Workbench connection closed during bootstrap.",
        );
    }
    let _ = sender.try_send(json!({
        "type": "product.changed",
        "revision": global_revision,
        "product": product
    }));
    if let Some(integrations) = services.global().integration_snapshot() {
        let _ = sender.try_send(json!({
            "type": "integrations.changed",
            "revision": global_revision,
            "integrations": integrations
        }));
    }
    let _ = sender.try_send(json!({
        "type": "photoshop.state.changed",
        "revision": global_revision,
        "state": services.photoshop().state()
    }));
    let global_sender = sender.clone();
    let global_services = Arc::clone(&services);
    let global_credential = context.credential.clone();
    tokio::spawn(async move {
        loop {
            match global_subscription.recv().await {
                Ok(event) if event.revision > global_revision => {
                    if global_sender.try_send(global_event_value(event)).is_err() {
                        global_services
                            .request_workbench_connection_close(global_credential.clone());
                        return;
                    }
                }
                Ok(_) => {}
                Err(
                    tokio::sync::broadcast::error::RecvError::Lagged(_)
                    | tokio::sync::broadcast::error::RecvError::Closed,
                ) => {
                    global_services.request_workbench_connection_close(global_credential.clone());
                    return;
                }
            }
        }
    });
    if let Some(project_id) = requested_project_id {
        let project_services = Arc::clone(&services);
        let project_sender = sender.clone();
        let project_browser_session = browser_session.clone();
        let project_credential = context.credential.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = project_services.bind_connection_project_id(
                &project_browser_session,
                &project_credential,
                &project_id,
            ) {
                let _ = project_sender.try_send(json!({
                    "type": "project.open_failed",
                    "projectId": project_id,
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "details": error.details
                    }
                }));
            }
        });
    }
    let guard = WorkbenchConnectionGuard {
        services,
        credential: context.credential,
    };
    let stream = JsonEventStream::new(receiver, cancellation, vec![Box::new(guard)]);
    let mut response = Sse::new(stream).into_response();
    let cookie =
        format!("{WORKBENCH_SESSION_COOKIE}={browser_session}; HttpOnly; SameSite=Strict; Path=/");
    if let Ok(cookie) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(SET_COOKIE, cookie);
    }
    response
}

struct WorkbenchConnectionGuard {
    services: Arc<WorkbenchRuntimeServices>,
    credential: String,
}

impl Drop for WorkbenchConnectionGuard {
    fn drop(&mut self) {
        self.services
            .request_workbench_connection_close(std::mem::take(&mut self.credential));
    }
}

pub(super) fn browser_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/workbench/recent-projects", delete(clear_recent_projects))
        .route("/settings/global", patch(global_settings_patch))
        .route(
            "/settings/models/api-key/reveal",
            post(model_api_key_reveal),
        )
        .route("/integrations/rescan", post(integrations_rescan))
        .route(
            "/integrations/{integration_id}/{operation}",
            post(integration_operation),
        )
        .route("/projects/open", post(project_open))
        .route("/projects/choose", post(project_choose))
        .route("/projects/replace", post(project_replace))
        .route(
            "/projects/{project_id}/photoshop/send",
            post(photoshop_send),
        )
        .merge(project_domain_router())
}

fn project_domain_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route(
            "/projects/{project_id}/working-copies/text/{*path}",
            put(text_working_copy).delete(text_working_copy),
        )
        .route(
            "/projects/{project_id}/working-copies/feedback/{item_id}",
            put(feedback_working_copy).delete(feedback_working_copy),
        )
        .route(
            "/projects/{project_id}/files/text/{*path}",
            get(super::project_routes::text_file).put(super::project_routes::text_file),
        )
        .route(
            "/projects/{project_id}/files/raw/{*path}",
            get(super::project_routes::raw_file).head(super::project_routes::raw_file),
        )
        .route(
            "/projects/{project_id}/files",
            post(super::project_routes::create_path),
        )
        .route(
            "/projects/{project_id}/files/load-directory",
            post(super::project_routes::load_directory),
        )
        .route(
            "/projects/{project_id}/files/import/local",
            post(super::project_routes::import_local),
        )
        .route(
            "/projects/{project_id}/files/import/uploads",
            post(super::project_routes::import_uploads),
        )
        .route(
            "/projects/{project_id}/files/batch/copy",
            post(super::project_routes::batch_copy),
        )
        .route(
            "/projects/{project_id}/files/batch/move",
            post(super::project_routes::batch_move),
        )
        .route(
            "/projects/{project_id}/files/batch/delete-permanently",
            post(super::project_routes::batch_delete),
        )
        .route(
            "/projects/{project_id}/files/path/batch/copy-to-system-clipboard",
            post(super::project_routes::copy_paths_to_system_clipboard),
        )
        .route(
            "/projects/{project_id}/files/path/batch/trash",
            post(super::project_routes::trash_paths),
        )
        .route(
            "/projects/{project_id}/files/path/{*path}",
            patch(super::project_routes::project_path).post(super::project_routes::project_path),
        )
        .route(
            "/projects/{project_id}/generated-assets/lookup",
            post(super::project_routes::generated_asset_lookup),
        )
        .route(
            "/projects/{project_id}/canvas-feedback",
            get(super::project_routes::feedback_get).patch(super::project_routes::feedback_patch),
        )
        .route(
            "/projects/{project_id}/canvases",
            post(super::project_routes::canvas_create),
        )
        .route(
            "/projects/{project_id}/canvases/index",
            put(super::project_routes::canvas_reorder),
        )
        .route(
            "/projects/{project_id}/canvases/index/repair",
            post(super::project_routes::canvas_repair),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}",
            get(super::project_routes::canvas_item)
                .patch(super::project_routes::canvas_item)
                .delete(super::project_routes::canvas_item),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}/canvas-map/project-paths",
            post(super::project_routes::canvas_map_add),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}/reset-layout",
            post(super::project_routes::canvas_reset),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}/node-layouts",
            patch(super::project_routes::canvas_layouts),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}/video-playback",
            patch(super::project_routes::canvas_video_playback),
        )
        .route(
            "/projects/{project_id}/canvases/{canvas_id}/text-viewport",
            patch(super::project_routes::canvas_text_viewport),
        )
        .route(
            "/projects/{project_id}/canvas-image-preview",
            get(super::project_routes::image_preview).head(super::project_routes::image_preview),
        )
        .route(
            "/projects/{project_id}/canvas-text-previews/source",
            post(super::project_routes::text_preview_source_save),
        )
        .route(
            "/projects/{project_id}/canvas-text-previews/sources",
            post(super::project_routes::text_preview_sources),
        )
        .route(
            "/projects/{project_id}/canvas-text-preview",
            get(super::project_routes::text_preview).head(super::project_routes::text_preview),
        )
        .route(
            "/projects/{project_id}/canvas-video-previews/sources",
            post(super::project_routes::video_preview_sources),
        )
        .route(
            "/projects/{project_id}/canvas-video-preview",
            get(super::project_routes::video_preview).head(super::project_routes::video_preview),
        )
        .route(
            "/projects/{project_id}/terminals",
            post(super::project_routes::terminal_create),
        )
        .route(
            "/projects/{project_id}/terminals/{terminal_id}",
            delete(super::project_routes::terminal_close),
        )
        .route(
            "/projects/{project_id}/terminals/ws",
            get(super::project_routes::terminal_websocket),
        )
}

async fn text_working_copy(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    let services = Arc::clone(&state.services);
    match *request.method() {
        Method::PUT => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Input {
                content: String,
                language: String,
                base_revision: String,
            }
            let input: Input = match json_body(request).await {
                Ok(input) => input,
                Err(response) => return response,
            };
            match services.put_text_working_copy(
                &scope.project_id,
                TextWorkingCopy {
                    project_relative_path: path,
                    content: input.content,
                    language: input.language,
                    base_revision: input.base_revision,
                },
            ) {
                Ok(working_copy) => Json(working_copy).into_response(),
                Err(error) => service_error_response(error),
            }
        }
        Method::DELETE => match services.clear_text_working_copy(&scope.project_id, &path) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => service_error_response(error),
        },
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

async fn feedback_working_copy(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, item_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    let services = Arc::clone(&state.services);
    match *request.method() {
        Method::PUT => {
            let working_copy: FeedbackWorkingCopy = match json_body(request).await {
                Ok(input) => input,
                Err(response) => return response,
            };
            if working_copy.item_id != item_id {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "working_copy_invalid",
                    "Feedback Working Copy itemId must match the request path.",
                );
            }
            match services.put_feedback_working_copy(&scope.project_id, working_copy) {
                Ok(working_copy) => Json(working_copy).into_response(),
                Err(error) => service_error_response(error),
            }
        }
        Method::DELETE => match services.clear_feedback_working_copy(&scope.project_id, &item_id) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => service_error_response(error),
        },
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

pub(super) fn product_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/runtime/product/update/check", post(product_check))
        .route("/runtime/product/update/apply", post(product_apply))
}

pub(super) fn cli_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/run", post(cli_run))
        .route("/run-stream", post(cli_run_stream))
        .route("/model-operations", post(cli_model_operation_submit))
}

async fn clear_recent_projects(State(state): State<WorkbenchRouterState>) -> Response {
    let services = Arc::clone(&state.services);
    match services.global().clear_recent_projects() {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn global_settings_patch(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let services = Arc::clone(&state.services);
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match services.global().settings_save(&body) {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn model_api_key_reveal(
    State(state): State<WorkbenchRouterState>,
    Extension(_connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        model_id: String,
    }

    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    match state
        .services
        .global()
        .reveal_model_api_key(&input.model_id)
    {
        Ok(api_key) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "apiKey": api_key })),
        )
            .into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn integrations_rescan(State(state): State<WorkbenchRouterState>) -> Response {
    let services = Arc::clone(&state.services);
    services.global().integrations_rescan();
    Json(json!({"ok": true})).into_response()
}

async fn integration_operation(
    State(state): State<WorkbenchRouterState>,
    Path((integration_id, operation)): Path<(String, String)>,
) -> Response {
    let services = Arc::clone(&state.services);
    match services.integration_operation(&integration_id, &operation) {
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn product_check(State(state): State<WorkbenchRouterState>) -> Response {
    product_call(&state, ProductCall::Check, Value::Null).await
}

async fn product_apply(
    State(state): State<WorkbenchRouterState>,
    Extension(connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    let input = match optional_json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let initiator = if connection.desktop.is_some() {
        ProductUpdateInitiator::Desktop {
            project_id: connection.project_id,
        }
    } else {
        ProductUpdateInitiator::Browser {
            project_id: connection.project_id,
        }
    };
    product_call(&state, ProductCall::Apply(initiator), input).await
}

enum ProductCall {
    Check,
    Apply(ProductUpdateInitiator),
}

async fn product_call(state: &WorkbenchRouterState, call: ProductCall, input: Value) -> Response {
    let product = Arc::clone(
        state
            .product
            .as_ref()
            .expect("Product routes are registered only with a Product service"),
    );
    let result = tokio::task::spawn_blocking(move || match call {
        ProductCall::Check => product.check(),
        ProductCall::Apply(initiator) => product.apply(&input, initiator),
    })
    .await
    .expect("Product worker must complete");
    match result {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn project_open(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    Extension(connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    let services = Arc::clone(&state.services);
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_root: Option<String>,
        project_id: Option<String>,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let result = match (input.project_root, input.project_id) {
        (Some(project_root), None) => {
            services.bind_connection_project_root(&browser.0, &connection.credential, &project_root)
        }
        (None, Some(project_id)) => {
            services.bind_connection_project_id(&browser.0, &connection.credential, &project_id)
        }
        _ => {
            return service_error_response(RuntimeHttpServiceError::new(
                StatusCode::BAD_REQUEST,
                "project_target_invalid",
                "OpenProject requires exactly one of projectRoot or projectId.",
            ));
        }
    };
    result.map_or_else(service_error_response, project_binding_response)
}

async fn project_choose(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {}
    let _: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let services = Arc::clone(&state.services);
    let native_shell = Arc::clone(services.native_shell());
    let selected = match tokio::task::spawn_blocking(move || native_shell.choose_directory())
        .await
        .expect("native Project picker worker must complete")
    {
        Ok(selected) => selected,
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::from_project(error));
        }
    };
    let Some(selected) = selected else {
        return Json(json!({"selected": false})).into_response();
    };
    let Some(selected) = selected.to_str() else {
        return service_error_response(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Selected Project path is not valid UTF-8.",
        ));
    };
    Json(json!({
        "selected": true,
        "projectRoot": selected
    }))
    .into_response()
}

async fn project_replace(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    Extension(connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_root: String,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let services = Arc::clone(&state.services);
    match services.replace_connection_project_root(
        &browser.0,
        &connection.credential,
        &input.project_root,
    ) {
        Ok(result) => project_binding_response(result),
        Err(error) => service_error_response(error),
    }
}

fn project_binding_response(outcome: WorkbenchProjectBindingOutcome) -> Response {
    match outcome {
        WorkbenchProjectBindingOutcome::Bound(opened) => Json(json!({
            "outcome": "bound",
            "projectId": opened.project_id
        }))
        .into_response(),
        WorkbenchProjectBindingOutcome::FocusedExistingDesktop { project_id } => Json(json!({
            "outcome": "focused_existing_desktop",
            "projectId": project_id
        }))
        .into_response(),
    }
}

async fn photoshop_send(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_relative_path: String,
        plugin_session_id: String,
        document_id: u64,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match state
        .services
        .photoshop()
        .send_project_file(
            &scope.project_id,
            &input.project_relative_path,
            &input.plugin_session_id,
            input.document_id,
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn cli_run(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let _permit = if cli_request_requires_product_work(&body) {
        let Some(permit) = state.services.runtime_state().begin_product_work() else {
            return product_work_unavailable_response();
        };
        Some(permit)
    } else {
        None
    };
    match state.cli.run(&body) {
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn cli_model_operation_submit(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let Some(_permit) = state.services.runtime_state().begin_product_work() else {
        return product_work_unavailable_response();
    };
    const INPUT_LIMIT: u64 = crate::model_operation::MAX_MODEL_OPERATION_INPUT_BYTES as u64;
    let mut parts = match read_multipart_limited(
        request,
        MultipartLimits {
            total_bytes: INPUT_LIMIT + 128 * 1024,
            file_bytes: INPUT_LIMIT,
            fields_bytes: 64 * 1024,
            parts: 2,
        },
    )
    .await
    {
        Ok(parts) => parts,
        Err(error) => return service_error_response(error),
    };
    if parts.fields.len() != 1 || parts.files.len() != 1 {
        return service_error_response(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Model Operation submission requires exactly request and input multipart parts.",
        ));
    }
    let Some(request) = parts.fields.remove("request") else {
        return service_error_response(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Model Operation submission omitted the request field.",
        ));
    };
    let Some(input) = parts.files.remove("input") else {
        return service_error_response(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Model Operation submission omitted the input file.",
        ));
    };
    let request = match serde_json::from_str::<Value>(&request) {
        Ok(request) => request,
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::new(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                format!("Model Operation request metadata is invalid: {error}"),
            ));
        }
    };
    let input = match tokio::fs::read(input.temporary_path).await {
        Ok(input) => input,
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                error.to_string(),
            ));
        }
    };
    match state.cli.submit(&request, &input) {
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

fn cli_request_requires_product_work(request: &Value) -> bool {
    let Some(command) = request.get("command").and_then(Value::as_str) else {
        return false;
    };
    crate::cli::command_specs()
        .iter()
        .find(|spec| spec.command == command)
        .is_some_and(|spec| spec.writes != "none")
}

fn product_work_unavailable_response() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "product_update_preparing",
        "Runtime is preparing a Product update and is not accepting new work.",
    )
}

async fn cli_run_stream(
    State(state): State<WorkbenchRouterState>,
    Extension(authorization): Extension<CliRequestAuthorization>,
    request: Request,
) -> Response {
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let verifier = Arc::clone(&state.cli_authorization);
    let observer_is_alive = Arc::new(move || verifier.is_cli_authorized(&authorization.0));
    match state.cli.run_stream(&body, observer_is_alive) {
        Ok(records) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/x-ndjson")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from_stream(NdjsonRecordStream { records }))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(error) => service_error_response(error),
    }
}

struct NdjsonRecordStream {
    records: super::RuntimeCliRecordStream,
}

impl Stream for NdjsonRecordStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.records).poll_next(context) {
            Poll::Ready(Some(record)) => {
                let Ok(line) = serde_json::to_vec(&record) else {
                    return Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Runtime failed to serialize a CLI stream record.",
                    ))));
                };
                let mut line = line;
                line.push(b'\n');
                Poll::Ready(Some(Ok(Bytes::from(line))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

fn global_event_value(event: GlobalRuntimeEvent) -> Value {
    match event.change {
        GlobalRuntimeChange::GlobalSettingsChanged(settings) => json!({
            "type": "globalSettings.changed",
            "revision": event.revision,
            "settings": settings
        }),
        GlobalRuntimeChange::RecentProjectsChanged(recent_projects) => json!({
            "type": "recentProjects.changed",
            "revision": event.revision,
            "recentProjects": recent_projects
        }),
        GlobalRuntimeChange::IntegrationsChanged(integrations) => json!({
            "type": "integrations.changed",
            "revision": event.revision,
            "integrations": integrations
        }),
        GlobalRuntimeChange::PhotoshopChanged(state) => json!({
            "type": "photoshop.state.changed",
            "revision": event.revision,
            "state": state
        }),
        GlobalRuntimeChange::ProductChanged(product) => json!({
            "type": "product.changed",
            "revision": event.revision,
            "product": product
        }),
    }
}

pub(crate) fn project_stream_value(
    item: ProjectStreamItem,
) -> Result<Value, RuntimeHttpServiceError> {
    Ok(match item {
        ProjectStreamItem::Snapshot(sync) => {
            let snapshot = public_project_snapshot(&sync.snapshot, &sync.project_id)?;
            json!({
            "type": "sync",
            "domain": "project",
            "projectId": sync.project_id,
            "revision": sync.project_revision,
            "snapshot": snapshot
            })
        }
        ProjectStreamItem::Event(event) => match event.change {
            ProjectChange::ProjectChanged(snapshot) => {
                let snapshot = public_project_snapshot(&snapshot, &event.project_id)?;
                json!({
                "type": "project.changed",
                "projectId": event.project_id,
                "projectRevision": event.project_revision,
                "snapshot": snapshot
                })
            }
            ProjectChange::ProjectFileChanged {
                project_relative_path,
                snapshot,
            } => {
                let snapshot = public_project_snapshot(&snapshot, &event.project_id)?;
                json!({
                "type": "project.fileChanged",
                "projectId": event.project_id,
                "projectRevision": event.project_revision,
                "event": {"projectRelativePath": project_relative_path},
                "snapshot": snapshot
                })
            }
            ProjectChange::CanvasChanged { canvas, projection } => {
                let projection = public_canvas_projection(&projection, &event.project_id)?;
                json!({
                    "type": "canvas.changed",
                    "projectId": event.project_id,
                    "projectRevision": event.project_revision,
                    "canvas": canvas,
                    "projection": projection
                })
            }
            ProjectChange::CanvasFeedbackChanged { feedback, .. } => json!({
                "type": "canvas.feedback.changed",
                "projectId": event.project_id,
                "projectRevision": event.project_revision,
                "feedback": feedback
            }),
        },
    })
}

struct JsonEventStream {
    receiver: mpsc::Receiver<Value>,
    cancellation: oneshot::Receiver<()>,
    _guards: Vec<Box<dyn Any + Send>>,
}

impl JsonEventStream {
    fn new(
        receiver: mpsc::Receiver<Value>,
        cancellation: oneshot::Receiver<()>,
        guards: Vec<Box<dyn Any + Send>>,
    ) -> Self {
        Self {
            receiver,
            cancellation,
            _guards: guards,
        }
    }
}

impl Stream for JsonEventStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if Pin::new(&mut self.cancellation).poll(context).is_ready() {
            return Poll::Ready(None);
        }
        self.receiver
            .poll_recv(context)
            .map(|value| value.map(|value| Ok(Event::default().json_data(value).unwrap())))
    }
}

pub(super) async fn json_body<T: DeserializeOwned>(request: Request) -> Result<T, Response> {
    json_body_with_limit(request, MAX_JSON_BODY_BYTES).await
}

pub(super) async fn json_body_with_limit<T: DeserializeOwned>(
    request: Request,
    maximum_bytes: usize,
) -> Result<T, Response> {
    let bytes = to_bytes(request.into_body(), maximum_bytes)
        .await
        .map_err(|_| {
            service_error_response(RuntimeHttpServiceError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_body_too_large",
                "JSON request body exceeds the endpoint limit or could not be read.",
            ))
        })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        service_error_response(RuntimeHttpServiceError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            error.to_string(),
        ))
    })
}

async fn optional_json_body(request: Request) -> Result<Value, Response> {
    let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| {
            service_error_response(RuntimeHttpServiceError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_body_too_large",
                "JSON request body exceeds 2 MiB.",
            ))
        })?;
    if bytes.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&bytes).map_err(|error| {
            service_error_response(RuntimeHttpServiceError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                error.to_string(),
            ))
        })
    }
}

pub(super) fn service_error_response(error: RuntimeHttpServiceError) -> Response {
    (
        error.status,
        Json(json!({
            "error": {
                "code": error.code,
                "message": error.message,
                "details": error.details
            }
        })),
    )
        .into_response()
}

fn one_header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    value.to_str().map(Some).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn editable_text_json_limit_accepts_a_full_boundary_body_after_escaping() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Input {
            content: String,
            expected_revision: String,
        }
        let content = "\"".repeat(
            usize::try_from(crate::project::MAX_EDITABLE_PROJECT_TEXT_BYTES)
                .expect("editable text limit should fit usize"),
        );
        let body = serde_json::to_vec(&json!({
            "content": content,
            "expectedRevision": "sha256:revision"
        }))
        .expect("fixture should serialize");
        assert!(body.len() > MAX_JSON_BODY_BYTES);
        let request = Request::new(Body::from(body));

        let input: Input = json_body_with_limit(request, MAX_EDITABLE_PROJECT_TEXT_JSON_BODY_BYTES)
            .await
            .expect("the complete editable text envelope should fit its transport limit");

        assert_eq!(
            input.content.len(),
            usize::try_from(crate::project::MAX_EDITABLE_PROJECT_TEXT_BYTES)
                .expect("editable text limit should fit usize")
        );
        assert_eq!(input.expected_revision, "sha256:revision");
    }

    #[test]
    fn cli_product_work_admission_follows_the_closed_command_write_contract() {
        for command in [
            "runtime.status",
            "models.video.list",
            "project.validate",
            "operation.inspect",
            "operation.wait",
        ] {
            assert!(
                !cli_request_requires_product_work(&json!({ "command": command })),
                "read-only command must remain observable: {command}"
            );
        }
        for command in [
            "project.init",
            "canvas.create",
            "operation.cancel",
            "request.single",
            "request.batch",
        ] {
            assert!(
                cli_request_requires_product_work(&json!({ "command": command })),
                "mutating command must participate in Product work drain: {command}"
            );
        }
        assert!(!cli_request_requires_product_work(&json!({
            "command": "unknown.command"
        })));
        assert!(!cli_request_requires_product_work(&json!({})));
    }

    #[test]
    fn project_and_global_events_have_closed_snapshot_first_envelopes() {
        let global = global_event_value(GlobalRuntimeEvent {
            revision: 2,
            change: GlobalRuntimeChange::RecentProjectsChanged(vec![
                crate::global::RecentProjectEntry {
                    project_id: "project-id".to_owned(),
                    project_root: "/project".to_owned(),
                },
            ]),
        });
        assert_eq!(global["type"], "recentProjects.changed");
        assert_eq!(global["revision"], 2);
    }
}
