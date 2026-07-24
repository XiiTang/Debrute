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
    fs::File,
    future::Future,
    io::Read as _,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    thread,
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{Extension, Path, Query, Request, State},
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
    photoshop::{
        PHOTOSHOP_BRIDGE_MAX_FRAME_BYTES, PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES,
        PhotoshopBridgeErrorCode, PhotoshopHelloMessage, PhotoshopRuntimeMessage,
        RuntimePhotoshopMessage,
    },
    project::{ProjectChange, ProjectStreamItem},
};

use super::{
    FeedbackWorkingCopy, ProductUpdateInitiator, RuntimeHttpServiceError, TextWorkingCopy,
    WORKBENCH_SESSION_COOKIE, WorkbenchLaunchService, WorkbenchProjectBindingOutcome,
    WorkbenchRuntimeServices,
    multipart::read_temporary_body,
    public_project_snapshot, public_project_sync,
    routing::{
        BrowserSession, PluginAuthorization, ProjectAuthorization, WorkbenchRouterState,
        error_response,
    },
    services::public_canvas_projection,
    websocket::{
        WebSocketConnection, WebSocketMessage, WebSocketUpgrade, read_message, read_text,
        write_close, write_pong, write_text,
    },
};

const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;
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
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
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
                Some(consumption.desktop),
                route_project_id,
            )
        } else {
            (
                WorkbenchLaunchService::create_browser_session(),
                None,
                input.requested_project_id,
            )
        };
    let (sender, receiver) = mpsc::channel(STREAM_CHANNEL_CAPACITY);
    let (context, cancellation) =
        services
            .connections()
            .open(browser_session.clone(), desktop, sender.clone());
    if sender
        .try_send(json!({
            "type": "connection.opened",
            "connectionCredential": context.credential
        }))
        .is_err()
    {
        services.close_workbench_connection(&context.credential);
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_unavailable",
            "Workbench connection closed during bootstrap.",
        );
    }
    let mut global_subscription = services.subscribe_global();
    let (global_revision, settings) = match services.global().sync_snapshot() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            services.close_workbench_connection(&context.credential);
            return service_error_response(RuntimeHttpServiceError::from_global(error));
        }
    };
    let photoshop = match services.photoshop().state() {
        Ok(state) => match serde_json::to_value(state) {
            Ok(value) => value,
            Err(error) => {
                services.close_workbench_connection(&context.credential);
                return service_error_response(RuntimeHttpServiceError::new(
                    500,
                    "photoshop_state_invalid",
                    error.to_string(),
                ));
            }
        },
        Err(error) => {
            services.close_workbench_connection(&context.credential);
            return service_error_response(RuntimeHttpServiceError::from_photoshop(error));
        }
    };
    let product = match services.product() {
        Ok(service) => match service.state() {
            Ok(product) => Some(product),
            Err(error) => {
                services.close_workbench_connection(&context.credential);
                return service_error_response(error);
            }
        },
        Err(error) if error.code == "product_service_unavailable" => None,
        Err(error) => {
            services.close_workbench_connection(&context.credential);
            return service_error_response(error);
        }
    };
    let recent_projects = settings.chrome.recent_projects.clone();
    let integrations = settings.integrations.clone();
    if sender
        .try_send(json!({
            "type": "global.snapshot",
            "globalRevision": global_revision,
            "snapshot": {
                "settings": settings,
                "recentProjects": recent_projects,
                "integrations": integrations,
                "photoshop": photoshop,
                "product": product
            }
        }))
        .is_err()
    {
        services.close_workbench_connection(&context.credential);
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_unavailable",
            "Workbench connection closed during bootstrap.",
        );
    }
    if let Some(project_id) = requested_project_id
        && let Err(error) = services.bind_connection_project_id(
            &browser_session,
            &context.credential,
            &project_id,
            false,
        )
    {
        let _ = sender
            .send(json!({
                "type": "project.open_failed",
                "projectId": project_id,
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "details": error.details
                }
            }))
            .await;
    }
    let global_sender = sender.clone();
    let global_connections = Arc::clone(services.connections());
    let global_credential = context.credential.clone();
    tokio::spawn(async move {
        loop {
            match global_subscription.recv().await {
                Ok(event) if event.revision > global_revision => {
                    if global_sender.try_send(global_event_value(event)).is_err() {
                        global_connections.close(&global_credential);
                        return;
                    }
                }
                Ok(_) => {}
                Err(
                    tokio::sync::broadcast::error::RecvError::Lagged(_)
                    | tokio::sync::broadcast::error::RecvError::Closed,
                ) => {
                    global_connections.close(&global_credential);
                    return;
                }
            }
        }
    });
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
        self.services.close_workbench_connection(&self.credential);
    }
}

pub(super) fn browser_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/workbench/recent-projects", delete(clear_recent_projects))
        .route(
            "/settings/global",
            get(global_settings_get).patch(global_settings_patch),
        )
        .route("/integrations/rescan", post(integrations_rescan))
        .route(
            "/integrations/{integration_id}/{operation}",
            post(integration_operation),
        )
        .route("/runtime/product", get(product_state))
        .route("/runtime/product/update/check", post(product_check))
        .route("/runtime/product/update/apply", post(product_apply))
        .route("/runtime/product/quit", post(product_quit))
        .route("/projects/open", post(project_open))
        .route("/projects/choose", post(project_choose))
        .route("/projects/replace", post(project_replace))
        .route("/projects/{project_id}", get(project_snapshot))
        .route("/projects/{project_id}/health", get(project_health))
        .route("/projects/{project_id}/refresh", post(project_refresh))
        .route("/adobe-bridge", get(photoshop_state))
        .route("/adobe-bridge/pairings", post(photoshop_pairing_create))
        .route(
            "/adobe-bridge/pairings/{pairing_id}",
            delete(photoshop_pairing_cancel),
        )
        .route(
            "/adobe-bridge/plugin-instances/{plugin_instance_id}/pairing",
            delete(photoshop_pairing_remove),
        )
        .route(
            "/projects/{project_id}/adobe-bridge/links",
            post(photoshop_link),
        )
        .route(
            "/projects/{project_id}/adobe-bridge/links/{plugin_instance_id}",
            delete(photoshop_unlink),
        )
        .route(
            "/projects/{project_id}/adobe-bridge/send-to-photoshop",
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
            "/projects/{project_id}/working-copies/feedback",
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
            "/projects/{project_id}/files/path/batch/copy-path",
            post(super::project_routes::copy_absolute_paths),
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
            "/projects/{project_id}/generated-assets",
            get(super::project_routes::generated_assets_list),
        )
        .route(
            "/projects/{project_id}/generated-assets/lookup",
            post(super::project_routes::generated_asset_lookup),
        )
        .route(
            "/projects/{project_id}/generated-assets/{asset_id}",
            get(super::project_routes::generated_asset_read),
        )
        .route(
            "/projects/{project_id}/generated-assets/{asset_id}/raw",
            get(super::project_routes::generated_asset_raw)
                .head(super::project_routes::generated_asset_raw),
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
            "/projects/{project_id}/canvases/{canvas_id}/node-stack-order/bring-to-front",
            post(super::project_routes::canvas_bring_front),
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
            get(super::project_routes::terminals).post(super::project_routes::terminals),
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
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
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
    request: Request,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match *request.method() {
        Method::PUT => {
            let working_copy: FeedbackWorkingCopy = match json_body(request).await {
                Ok(input) => input,
                Err(response) => return response,
            };
            match services.put_feedback_working_copy(&scope.project_id, working_copy) {
                Ok(working_copy) => Json(working_copy).into_response(),
                Err(error) => service_error_response(error),
            }
        }
        Method::DELETE => match services.clear_feedback_working_copy(&scope.project_id) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => service_error_response(error),
        },
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

pub(super) fn cli_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/run", post(cli_run))
        .route("/run-stream", post(cli_run_stream))
}

pub(super) fn plugin_api_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route("/ws", get(photoshop_plugin_websocket))
        .route(
            "/projects/{project_id}/link",
            post(photoshop_plugin_link).delete(photoshop_plugin_link),
        )
        .route(
            "/projects/{project_id}/uploads",
            post(photoshop_plugin_upload),
        )
}

pub(super) fn plugin_transfer_router() -> Router<WorkbenchRouterState> {
    Router::new().route(
        "/{transfer_id}/content",
        get(photoshop_transfer_content).head(photoshop_transfer_content),
    )
}

async fn clear_recent_projects(State(state): State<WorkbenchRouterState>) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.global().clear_recent_projects() {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn global_settings_get(State(state): State<WorkbenchRouterState>) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.global().settings_get() {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn global_settings_patch(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match services.global().settings_save(&body) {
        Ok(view) => match services.photoshop().set_enabled(view.adobe_bridge.enabled) {
            Ok(()) => Json(view).into_response(),
            Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
        },
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn integrations_rescan(State(state): State<WorkbenchRouterState>) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.global().integrations_rescan() {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_global(error)),
    }
}

async fn integration_operation(
    State(state): State<WorkbenchRouterState>,
    Path((integration_id, operation)): Path<(String, String)>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.integration_operation(&integration_id, &operation) {
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn product_state(State(state): State<WorkbenchRouterState>) -> Response {
    product_call(&state, ProductCall::State, Value::Null).await
}

async fn product_check(State(state): State<WorkbenchRouterState>) -> Response {
    product_call(&state, ProductCall::Check, Value::Null).await
}

async fn product_apply(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    request: Request,
) -> Response {
    let input = match optional_json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    product_call(
        &state,
        ProductCall::Apply(ProductUpdateInitiator::Frontend {
            browser_session: browser.0,
        }),
        input,
    )
    .await
}

async fn product_quit(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    let input = match optional_json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    product_call(&state, ProductCall::Quit, input).await
}

enum ProductCall {
    State,
    Check,
    Apply(ProductUpdateInitiator),
    Quit,
}

async fn product_call(state: &WorkbenchRouterState, call: ProductCall, input: Value) -> Response {
    let services = match services(state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let product = match services.product() {
        Ok(product) => product,
        Err(error) => return service_error_response(error),
    };
    let asynchronous_transition = matches!(&call, ProductCall::Apply(_) | ProductCall::Quit);
    let result = tokio::task::spawn_blocking(move || match call {
        ProductCall::State => product.state(),
        ProductCall::Check => product.check(),
        ProductCall::Apply(initiator) => product.apply(&input, initiator),
        ProductCall::Quit => product.quit(&input),
    })
    .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::new(
                500,
                "product_worker_failed",
                format!("Product worker failed: {error}"),
            ));
        }
    };
    match result {
        Ok(value) if asynchronous_transition && value.get("transitionId").is_some() => {
            (StatusCode::ACCEPTED, Json(value)).into_response()
        }
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn project_open(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    Extension(connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        project_root: Option<String>,
        project_id: Option<String>,
        #[serde(default)]
        force_open_here: bool,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let result = match (input.project_root, input.project_id) {
        (Some(project_root), None) => services.bind_connection_project_root(
            &browser.0,
            &connection.credential,
            &project_root,
            input.force_open_here,
        ),
        (None, Some(project_id)) => services.bind_connection_project_id(
            &browser.0,
            &connection.credential,
            &project_id,
            input.force_open_here,
        ),
        _ => {
            return service_error_response(RuntimeHttpServiceError::new(
                400,
                "project_target_invalid",
                "OpenProject requires exactly one of projectRoot or projectId.",
            ));
        }
    };
    result.map_or_else(service_error_response, project_binding_response)
}

async fn project_choose(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    Extension(connection): Extension<super::WorkbenchConnectionContext>,
    request: Request,
) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        mode: ProjectChooseMode,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum ProjectChooseMode {
        Open,
        Replace,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let native_shell = Arc::clone(services.native_shell());
    let selected = match tokio::task::spawn_blocking(move || native_shell.choose_directory()).await
    {
        Ok(Ok(selected)) => selected,
        Ok(Err(error)) => {
            return service_error_response(RuntimeHttpServiceError::from_project(error));
        }
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::new(
                500,
                "native_project_picker_failed",
                error.to_string(),
            ));
        }
    };
    let Some(selected) = selected else {
        return Json(json!({"opened": false})).into_response();
    };
    let Some(selected) = selected.to_str() else {
        return service_error_response(RuntimeHttpServiceError::new(
            400,
            "invalid_input",
            "Selected Project path is not valid UTF-8.",
        ));
    };
    let result = match input.mode {
        ProjectChooseMode::Open => services.bind_connection_project_root(
            &browser.0,
            &connection.credential,
            selected,
            false,
        ),
        ProjectChooseMode::Replace => services.replace_connection_project_root(
            &browser.0,
            &connection.credential,
            selected,
            false,
        ),
    };
    match result {
        Ok(WorkbenchProjectBindingOutcome::Bound(opened)) => Json(json!({
            "opened": true,
            "outcome": "bound",
            "projectId": opened.project_id
        }))
        .into_response(),
        Ok(WorkbenchProjectBindingOutcome::FocusedExistingDesktop { project_id }) => Json(json!({
            "opened": true,
            "outcome": "focused_existing_desktop",
            "projectId": project_id
        }))
        .into_response(),
        Err(error) => service_error_response(error),
    }
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
        #[serde(default)]
        force_open_here: bool,
    }
    let input: Input = match json_body(request).await {
        Ok(input) => input,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.replace_connection_project_root(
        &browser.0,
        &connection.credential,
        &input.project_root,
        input.force_open_here,
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

async fn project_snapshot(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services
        .projects()
        .get(&scope.project_id)
        .and_then(|session| session.sync_snapshot())
    {
        Ok(sync) => match public_project_sync(&sync) {
            Ok(value) => Json(value).into_response(),
            Err(error) => service_error_response(error),
        },
        Err(error) => service_error_response(RuntimeHttpServiceError::from_project(error)),
    }
}

async fn project_health(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services
        .projects()
        .get(&scope.project_id)
        .and_then(|session| session.sync_snapshot())
    {
        Ok(sync) => match super::services::public_project_health(&sync.snapshot.health) {
            Ok(value) => Json(value).into_response(),
            Err(error) => service_error_response(error),
        },
        Err(error) => service_error_response(RuntimeHttpServiceError::from_project(error)),
    }
}

async fn project_refresh(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let session = match services.projects().get(&scope.project_id) {
        Ok(session) => session,
        Err(error) => {
            return service_error_response(RuntimeHttpServiceError::from_project(error));
        }
    };
    match session.refresh() {
        Ok(result) => match public_project_snapshot(&result.value, &result.project_id) {
            Ok(snapshot) => Json(json!({
                "projectId": result.project_id,
                "projectRevision": result.project_revision,
                "snapshot": snapshot
            }))
            .into_response(),
            Err(error) => service_error_response(error),
        },
        Err(error) => service_error_response(RuntimeHttpServiceError::from_project(error)),
    }
}

async fn photoshop_state(State(state): State<WorkbenchRouterState>) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().state() {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_pairing_create(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().create_pairing(&browser.0) {
        Ok(pairing) => Json(pairing).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_pairing_cancel(
    State(state): State<WorkbenchRouterState>,
    Extension(browser): Extension<BrowserSession>,
    Path(pairing_id): Path<String>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().cancel_pairing(&browser.0, &pairing_id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_pairing_remove(
    State(state): State<WorkbenchRouterState>,
    Path(plugin_instance_id): Path<String>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().remove_pairing(&plugin_instance_id) {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_link(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        plugin_instance_id: String,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services
        .photoshop()
        .link_project_for_browser(&scope.project_id, &input.plugin_instance_id)
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_unlink(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_project_id, plugin_instance_id)): Path<(String, String)>,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services
        .photoshop()
        .unlink_project_for_browser(&scope.project_id, &plugin_instance_id)
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
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
        plugin_instance_id: String,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().send_project_file(
        &scope.project_id,
        &input.plugin_instance_id,
        &input.project_relative_path,
        &state.origin,
    ) {
        Ok(dispatch) => {
            if let Err(error) =
                services.send_photoshop_message(&dispatch.plugin_session_id, dispatch.message)
            {
                let _ = services
                    .photoshop()
                    .disconnect_session(&dispatch.plugin_session_id);
                return service_error_response(error);
            }
            Json(json!({"transfer": dispatch.transfer})).into_response()
        }
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_plugin_websocket(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let upgrade = match WebSocketUpgrade::from_request(request) {
        Ok(upgrade) => upgrade,
        Err(response) => return response,
    };
    upgrade.on_upgrade(move |connection| {
        tokio::spawn(run_photoshop_websocket(connection, services));
    })
}

async fn run_photoshop_websocket(
    connection: WebSocketConnection,
    services: Arc<WorkbenchRuntimeServices>,
) {
    let (mut reader, mut writer) = tokio::io::split(connection.into_io());
    let challenge = match services.photoshop().begin_handshake() {
        Ok(challenge) => challenge,
        Err(error) => {
            let _ = write_photoshop_error(&mut writer, &error).await;
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    if write_photoshop_message(&mut writer, &challenge.message)
        .await
        .is_err()
    {
        return;
    }
    let hello = tokio::time::timeout(
        Duration::from_secs(5),
        read_text(&mut reader, PHOTOSHOP_BRIDGE_MAX_FRAME_BYTES),
    )
    .await;
    let Ok(Ok(Some(hello))) = hello else {
        let _ = write_close(&mut writer).await;
        return;
    };
    let hello = match serde_json::from_str::<PhotoshopHelloMessage>(&hello) {
        Ok(hello) => hello,
        Err(error) => {
            let _ = write_photoshop_message(
                &mut writer,
                &RuntimePhotoshopMessage::BridgeError {
                    code: PhotoshopBridgeErrorCode::InvalidTransferPayload,
                    message: error.to_string(),
                },
            )
            .await;
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let admission = match services
        .photoshop()
        .complete_handshake(&challenge.challenge_id, &hello)
    {
        Ok(admission) => admission,
        Err(error) => {
            let _ = write_photoshop_error(&mut writer, &error).await;
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let session_id = admission.grant.plugin_session_id.clone();
    let ready = RuntimePhotoshopMessage::BridgeReady {
        plugin_session_id: session_id.clone(),
        bearer: admission.grant.bearer,
        state: admission.grant.state,
    };
    let (sender, mut receiver) = mpsc::channel(64);
    services.register_photoshop_socket(
        session_id.clone(),
        admission.replaced_session_id.as_deref(),
        sender,
    );
    if write_photoshop_message(&mut writer, &ready).await.is_ok() {
        loop {
            tokio::select! {
                outbound = receiver.recv() => {
                    let Some(outbound) = outbound else { break; };
                    if write_photoshop_message(&mut writer, &outbound).await.is_err() {
                        break;
                    }
                }
                incoming = read_message(&mut reader, PHOTOSHOP_BRIDGE_MAX_FRAME_BYTES) => {
                    let incoming = match incoming {
                        Ok(Some(WebSocketMessage::Text(incoming))) => incoming,
                        Ok(Some(WebSocketMessage::Ping(payload))) => {
                            if write_pong(&mut writer, &payload).await.is_err() { break; }
                            continue;
                        }
                        Ok(Some(WebSocketMessage::Pong)) => continue,
                        Ok(Some(WebSocketMessage::Close) | None) | Err(_) => break,
                    };
                    let message = match serde_json::from_str::<PhotoshopRuntimeMessage>(&incoming) {
                        Ok(message) => message,
                        Err(error) => {
                            if write_photoshop_message(
                                &mut writer,
                                &RuntimePhotoshopMessage::BridgeError {
                                    code: PhotoshopBridgeErrorCode::InvalidTransferPayload,
                                    message: error.to_string(),
                                },
                            ).await.is_err() {
                                break;
                            }
                            continue;
                        }
                    };
                    if let Err(error) = services.photoshop().update_plugin_message(&session_id, message) {
                        let _ = write_photoshop_error(&mut writer, &error).await;
                        break;
                    }
                }
            }
        }
    }
    services.unregister_photoshop_socket(&session_id);
    let _ = services.photoshop().disconnect_session(&session_id);
    let _ = write_close(&mut writer).await;
}

async fn photoshop_plugin_link(
    State(state): State<WorkbenchRouterState>,
    Extension(plugin): Extension<PluginAuthorization>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    if let Err(response) = require_plugin_instance(&headers, &plugin) {
        return response;
    }
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    let result = if method == Method::POST {
        services
            .photoshop()
            .link_project_for_plugin(&plugin.bearer, &project_id)
    } else {
        services
            .photoshop()
            .unlink_project_for_plugin(&plugin.bearer, &project_id)
    };
    match result {
        Ok(view) => Json(view).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_plugin_upload(
    State(state): State<WorkbenchRouterState>,
    Extension(plugin): Extension<PluginAuthorization>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if let Err(response) = require_plugin_instance(&headers, &plugin) {
        return response;
    }
    let transfer_id = match required_header(&headers, "x-debrute-transfer-id") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let target_directory = match required_percent_header(&headers, "x-debrute-target-directory") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let suggested_name = match required_percent_header(&headers, "x-debrute-suggested-name") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mime_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_owned();
    let declared_byte_length = match headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(length) => length,
        None => return invalid_header(),
    };
    let body = match read_temporary_body(request, PHOTOSHOP_BRIDGE_MAX_UPLOAD_BYTES as u64).await {
        Ok(body) => body,
        Err(error) => return service_error_response(error),
    };
    if body.byte_length != declared_byte_length {
        return service_error_response(RuntimeHttpServiceError::new(
            400,
            "invalid_transfer_payload",
            "Photoshop upload length does not match Content-Length.",
        ));
    }
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.photoshop().import_png_file(
        &plugin.bearer,
        &transfer_id,
        &project_id,
        &target_directory,
        &suggested_name,
        &mime_type,
        declared_byte_length,
        body.path.clone(),
    ) {
        Ok(result) => Json(result).into_response(),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn photoshop_transfer_content(
    State(state): State<WorkbenchRouterState>,
    Extension(plugin): Extension<PluginAuthorization>,
    Path(transfer_id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
) -> Response {
    let token = query.get("token").map(String::as_str).unwrap_or_default();
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services
        .photoshop()
        .take_download(&plugin.bearer, &transfer_id, token)
    {
        Ok(plan) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, plan.mime_type)
            .header(header::CONTENT_LENGTH, plan.byte_length)
            .header(
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename=\"{}\"",
                    safe_header_filename(&plan.file_name)
                ),
            )
            .body(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from_stream(BlockingFileStream::new(plan.file))
            })
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(error) => service_error_response(RuntimeHttpServiceError::from_photoshop(error)),
    }
}

async fn write_photoshop_message<Writer>(
    writer: &mut Writer,
    message: &RuntimePhotoshopMessage,
) -> std::io::Result<()>
where
    Writer: tokio::io::AsyncWrite + Unpin,
{
    let text = serde_json::to_string(message)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    write_text(writer, &text).await
}

async fn write_photoshop_error<Writer>(
    writer: &mut Writer,
    error: &crate::photoshop::PhotoshopBridgeError,
) -> std::io::Result<()>
where
    Writer: tokio::io::AsyncWrite + Unpin,
{
    write_photoshop_message(
        writer,
        &RuntimePhotoshopMessage::BridgeError {
            code: error.code(),
            message: error.to_string(),
        },
    )
    .await
}

async fn cli_run(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.cli().and_then(|service| service.run(&body)) {
        Ok(value) => Json(value).into_response(),
        Err(error) => service_error_response(error),
    }
}

async fn cli_run_stream(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    let body: Value = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let services = match services(&state) {
        Ok(services) => services,
        Err(response) => return response,
    };
    match services.cli().and_then(|service| service.run_stream(&body)) {
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
        GlobalRuntimeChange::PhotoshopBridgeChanged(state) => json!({
            "type": "adobeBridge.state.changed",
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

struct BlockingFileStream {
    receiver: mpsc::Receiver<Result<Bytes, std::io::Error>>,
}

impl BlockingFileStream {
    fn new(mut file: File) -> Self {
        let (sender, receiver) = mpsc::channel(8);
        thread::spawn(move || {
            loop {
                let mut buffer = vec![0_u8; 64 * 1024];
                match file.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(length) => {
                        buffer.truncate(length);
                        if sender.blocking_send(Ok(Bytes::from(buffer))).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.blocking_send(Err(error));
                        return;
                    }
                }
            }
        });
        Self { receiver }
    }
}

impl Stream for BlockingFileStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

fn require_plugin_instance(
    headers: &HeaderMap,
    plugin: &PluginAuthorization,
) -> Result<(), Response> {
    let supplied = required_header(headers, "x-debrute-plugin-instance")?;
    if supplied == plugin.plugin_instance_id {
        Ok(())
    } else {
        Err(error_response(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Photoshop plugin identity does not match its live bearer.",
        ))
    }
}

fn required_header(headers: &HeaderMap, name: &'static str) -> Result<String, Response> {
    match one_header(headers, name) {
        Ok(Some(value)) if !value.trim().is_empty() => Ok(value.to_owned()),
        _ => Err(invalid_header()),
    }
}

fn required_percent_header(headers: &HeaderMap, name: &'static str) -> Result<String, Response> {
    percent_decode(&required_header(headers, name)?).ok_or_else(invalid_header)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            decoded.push(high << 4 | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn safe_header_filename(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_graphic() && !matches!(character, '"' | '\\' | '\r' | '\n')
        })
        .collect()
}

pub(super) fn services(
    state: &WorkbenchRouterState,
) -> Result<Arc<WorkbenchRuntimeServices>, Response> {
    state.services.clone().ok_or_else(|| {
        error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_services_unavailable",
            "Rust Runtime services are not installed on this listener.",
        )
    })
}

pub(super) async fn json_body<T: DeserializeOwned>(request: Request) -> Result<T, Response> {
    let bytes = to_bytes(request.into_body(), MAX_JSON_BODY_BYTES)
        .await
        .map_err(|_| {
            service_error_response(RuntimeHttpServiceError::new(
                413,
                "request_body_too_large",
                "JSON request body exceeds 2 MiB or could not be read.",
            ))
        })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        service_error_response(RuntimeHttpServiceError::new(
            400,
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
                413,
                "request_body_too_large",
                "JSON request body exceeds 2 MiB.",
            ))
        })?;
    if bytes.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&bytes).map_err(|error| {
            service_error_response(RuntimeHttpServiceError::new(
                400,
                "invalid_json",
                error.to_string(),
            ))
        })
    }
}

pub(super) fn service_error_response(error: RuntimeHttpServiceError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
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

fn invalid_header() -> Response {
    error_response(
        StatusCode::BAD_REQUEST,
        "invalid_header",
        "Required Runtime header is absent or ambiguous.",
    )
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

    #[test]
    fn all_explicit_deletion_routes_are_absent_from_the_final_builders() {
        let source = include_str!("routes.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for deleted in [
            "route(\"/status\"",
            "route(\"/runtime\"",
            "route(\"/workbench/title-bar\"",
            "route(\"/workbench/events\"",
            "/electron-windows/",
            "/events?clientId=",
            "/input\"",
            "/resize\"",
        ] {
            assert!(
                !source.contains(deleted),
                "deleted route remains: {deleted}"
            );
        }
    }
}
