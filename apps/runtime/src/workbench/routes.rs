#![allow(clippy::result_large_err)]

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
    activity::{
        ActivityChange, ActivityEvent, ActivityMessage, ActivityNoticeReport, ActivityProgress,
        ActivityTaskStatus,
    },
    global::{GlobalRuntimeChange, GlobalRuntimeEvent},
    project::{ProjectChange, ProjectStreamItem},
};

use super::{
    FeedbackWorkingCopy, ProductUpdateInitiator, RuntimeHttpServiceError, TextWorkingCopy,
    WORKBENCH_SESSION_COOKIE, WorkbenchLaunchService, WorkbenchProjectBindingOutcome,
    WorkbenchRuntimeServices,
    multipart::{MultipartLimits, read_multipart_limited},
    public_project_snapshot,
    routing::{
        BrowserSession, CliRequestAuthorization, ProjectAuthorization, WorkbenchRouterState,
        browser_session_cookie, error_response,
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
        requested_project_root: Option<String>,
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
    let (browser_session, desktop, requested_project_root) =
        if let Some(ticket) = input.desktop_launch_ticket.as_deref() {
            let Some(consumption) = state.launch_service.consume_desktop_ticket(ticket) else {
                return error_response(
                    StatusCode::FORBIDDEN,
                    "desktop_launch_ticket_invalid",
                    "Desktop launch ticket is invalid or already consumed.",
                );
            };
            let route_project_root = match consumption.route {
                crate::control::WorkbenchRoute::Root => input.requested_project_root,
                crate::control::WorkbenchRoute::OpenProject { canonical_root } => {
                    if input.requested_project_root.as_deref() != Some(&canonical_root) {
                        return error_response(
                            StatusCode::CONFLICT,
                            "desktop_launch_route_mismatch",
                            "Desktop launch route does not match the requested Project.",
                        );
                    }
                    Some(canonical_root)
                }
            };
            (
                consumption.browser_session,
                Some(consumption.desktop),
                route_project_root,
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
            (browser_session, None, input.requested_project_root)
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
    let mut activity_subscription = services.subscribe_activity();
    let activity_snapshot = services.activity().sync_snapshot();
    if sender
        .try_send(json!({
            "type": "activity.snapshot",
            "activityRevision": activity_snapshot.revision,
            "records": activity_snapshot.records
        }))
        .is_err()
    {
        services.request_workbench_connection_close(context.credential.clone());
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "workbench_connection_unavailable",
            "Workbench connection closed during Activity bootstrap.",
        );
    }
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
    let activity_sender = sender.clone();
    let activity_services = Arc::clone(&services);
    let activity_credential = context.credential.clone();
    let activity_revision = activity_snapshot.revision;
    tokio::spawn(async move {
        loop {
            match activity_subscription.recv().await {
                Ok(event) if event.revision > activity_revision => {
                    if activity_sender
                        .try_send(activity_event_value(event))
                        .is_err()
                    {
                        activity_services
                            .request_workbench_connection_close(activity_credential.clone());
                        return;
                    }
                }
                Ok(_) => {}
                Err(
                    tokio::sync::broadcast::error::RecvError::Lagged(_)
                    | tokio::sync::broadcast::error::RecvError::Closed,
                ) => {
                    activity_services
                        .request_workbench_connection_close(activity_credential.clone());
                    return;
                }
            }
        }
    });
    if let Some(project_root) = requested_project_root {
        let project_services = Arc::clone(&services);
        let project_sender = sender.clone();
        let project_browser_session = browser_session.clone();
        let project_credential = context.credential.clone();
        tokio::task::spawn_blocking(move || {
            let result = project_services.bind_initial_connection_project_root(
                &project_browser_session,
                &project_credential,
                &project_root,
            );
            if let Err(error) = result {
                let frame = json!({
                    "type": "project.open_failed",
                    "canonicalRoot": project_root,
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "details": error.details
                    }
                });
                let _ = project_sender.try_send(frame);
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
        .route("/activities", delete(clear_terminal_activities))
        .route("/activities/{activity_id}", delete(dismiss_activity))
        .route("/activities/notices", post(report_global_activity_notice))
        .route("/workbench/recent-projects", delete(clear_recent_projects))
        .route("/settings/global/mutations", post(global_settings_mutate))
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
            "/workbench/bindings/{binding_id}/photoshop/send",
            post(photoshop_send),
        )
        .merge(project_domain_router())
}

fn project_domain_router() -> Router<WorkbenchRouterState> {
    Router::new()
        .route(
            "/workbench/bindings/{binding_id}/activities/notices",
            post(report_project_activity_notice),
        )
        .route(
            "/workbench/bindings/{binding_id}/working-copies/text/{*path}",
            put(text_working_copy).delete(text_working_copy),
        )
        .route(
            "/workbench/bindings/{binding_id}/working-copies/feedback/{item_id}",
            put(feedback_working_copy).delete(feedback_working_copy),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/text/{*path}",
            get(super::project_routes::text_file).put(super::project_routes::text_file),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/raw/{*path}",
            get(super::project_routes::raw_file).head(super::project_routes::raw_file),
        )
        .route(
            "/workbench/bindings/{binding_id}/files",
            post(super::project_routes::create_path),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/load-directory",
            post(super::project_routes::load_directory),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/import/local",
            post(super::project_routes::import_local),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/import/uploads",
            post(super::project_routes::import_uploads),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/batch/copy",
            post(super::project_routes::batch_copy),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/batch/move",
            post(super::project_routes::batch_move),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/batch/delete-permanently",
            post(super::project_routes::batch_delete),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/path/batch/copy-to-system-clipboard",
            post(super::project_routes::copy_paths_to_system_clipboard),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/path/batch/trash",
            post(super::project_routes::trash_paths),
        )
        .route(
            "/workbench/bindings/{binding_id}/files/path/{*path}",
            patch(super::project_routes::project_path).post(super::project_routes::project_path),
        )
        .route(
            "/workbench/bindings/{binding_id}/model-artifacts/lookup",
            post(super::project_routes::model_artifact_lookup),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-feedback",
            get(super::project_routes::feedback_get).patch(super::project_routes::feedback_patch),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas/reset",
            post(super::project_routes::canvas_reset),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas/state",
            patch(super::project_routes::canvas_state_patch),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-sources/resolve",
            post(super::project_routes::canvas_sources_resolve),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-image-preview",
            get(super::project_routes::image_preview).head(super::project_routes::image_preview),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-text-previews/source",
            post(super::project_routes::text_preview_source_save),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-text-previews/sources",
            post(super::project_routes::text_preview_sources),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-text-preview",
            get(super::project_routes::text_preview).head(super::project_routes::text_preview),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-video-previews/probe",
            post(super::project_routes::video_preview_probe),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-video-previews/ensure",
            post(super::project_routes::video_preview_ensure),
        )
        .route(
            "/workbench/bindings/{binding_id}/canvas-video-preview",
            get(super::project_routes::video_preview).head(super::project_routes::video_preview),
        )
        .route(
            "/workbench/bindings/{binding_id}/terminals",
            post(super::project_routes::terminal_create),
        )
        .route(
            "/workbench/bindings/{binding_id}/terminals/{terminal_id}",
            delete(super::project_routes::terminal_close),
        )
        .route(
            "/workbench/bindings/{binding_id}/terminals/ws",
            get(super::project_routes::terminal_websocket),
        )
}

async fn report_global_activity_notice(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let report: ActivityNoticeReport = match json_body(request).await {
        Ok(report) => report,
        Err(response) => return response,
    };
    if report.is_project_scoped() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "activity_scope_invalid",
            "Project Activity notices require a current Project scope.",
        );
    }
    let record = state.services.activity().publish_notice(None, report);
    Json(json!({ "activityId": record.id })).into_response()
}

async fn report_project_activity_notice(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    request: Request,
) -> Response {
    let report: ActivityNoticeReport = match json_body(request).await {
        Ok(report) => report,
        Err(response) => return response,
    };
    if !report.is_project_scoped() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "activity_scope_invalid",
            "Global Activity notices cannot claim a Project scope.",
        );
    }
    let project = match state
        .services
        .project_activity_context(&scope.canonical_root)
    {
        Ok(project) => project,
        Err(error) => return service_error_response(error),
    };
    let record = state
        .services
        .activity()
        .publish_notice(Some(project), report);
    Json(json!({ "activityId": record.id })).into_response()
}

async fn dismiss_activity(
    State(state): State<WorkbenchRouterState>,
    Path(activity_id): Path<String>,
) -> Response {
    if state.services.activity().dismiss_terminal(&activity_id) {
        Json(json!({ "ok": true })).into_response()
    } else {
        error_response(
            StatusCode::CONFLICT,
            "activity_not_clearable",
            "Activity is missing or still in progress.",
        )
    }
}

async fn clear_terminal_activities(State(state): State<WorkbenchRouterState>) -> Response {
    let cleared = state.services.activity().clear_terminal();
    Json(json!({ "ok": true, "cleared": cleared })).into_response()
}

async fn text_working_copy(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_binding_id, path)): Path<(String, String)>,
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
                &scope.canonical_root,
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
        Method::DELETE => match services.clear_text_working_copy(&scope.canonical_root, &path) {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(error) => service_error_response(error),
        },
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

async fn feedback_working_copy(
    State(state): State<WorkbenchRouterState>,
    Extension(scope): Extension<ProjectAuthorization>,
    Path((_binding_id, item_id)): Path<(String, String)>,
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
            match services.put_feedback_working_copy(&scope.canonical_root, working_copy) {
                Ok(working_copy) => Json(working_copy).into_response(),
                Err(error) => service_error_response(error),
            }
        }
        Method::DELETE => {
            match services.clear_feedback_working_copy(&scope.canonical_root, &item_id) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(error) => service_error_response(error),
            }
        }
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

async fn global_settings_mutate(
    State(state): State<WorkbenchRouterState>,
    request: Request,
) -> Response {
    let services = Arc::clone(&state.services);
    let body: crate::global::GlobalSettingsMutation = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    match services.settings_mutate(&body) {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => service_error_response(error),
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
        ProductUpdateInitiator::Desktop
    } else {
        ProductUpdateInitiator::Browser
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
        project_root: String,
    }
    let input: Input = match json_body(request).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let browser_session_id = browser.0;
    let connection_credential = connection.credential;
    let result = tokio::task::spawn_blocking(move || {
        services.bind_connection_project_root(
            &browser_session_id,
            &connection_credential,
            &input.project_root,
        )
    })
    .await
    .expect("Project open worker must complete");
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
    let browser_session_id = browser.0;
    let connection_credential = connection.credential;
    let result = tokio::task::spawn_blocking(move || {
        services.replace_connection_project_root(
            &browser_session_id,
            &connection_credential,
            &input.project_root,
        )
    })
    .await
    .expect("Project replace worker must complete");
    match result {
        Ok(result) => project_binding_response(result),
        Err(error) => service_error_response(error),
    }
}

fn project_binding_response(outcome: WorkbenchProjectBindingOutcome) -> Response {
    match outcome {
        WorkbenchProjectBindingOutcome::Bound(opened) => Json(json!({
            "outcome": "bound",
            "bindingId": opened.binding_id,
            "canonicalRoot": opened.canonical_root
        }))
        .into_response(),
        WorkbenchProjectBindingOutcome::FocusedExistingDesktop { canonical_root } => Json(json!({
            "outcome": "focused_existing_desktop",
            "canonicalRoot": canonical_root
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
    let project = match state
        .services
        .project_activity_context(&scope.canonical_root)
    {
        Ok(project) => project,
        Err(error) => return service_error_response(error),
    };
    let activity = state.services.activity().start_task(
        Some(project),
        ActivityMessage::PhotoshopSend {
            project_relative_path: input.project_relative_path.clone(),
            document_title: None,
        },
        ActivityProgress::Indeterminate,
    );
    let result = state
        .services
        .photoshop()
        .send_project_file(
            &scope.canonical_root,
            &input.project_relative_path,
            &input.plugin_session_id,
            input.document_id,
        )
        .await;
    let status = if result.is_ok() {
        ActivityTaskStatus::Succeeded
    } else {
        ActivityTaskStatus::Failed
    };
    let _ = state.services.activity().update_task(
        &activity.id,
        status,
        ActivityProgress::Indeterminate,
    );
    match result {
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
            "recentProjectRoots": recent_projects
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

fn activity_event_value(event: ActivityEvent) -> Value {
    match event.change {
        ActivityChange::Upsert { record } => json!({
            "type": "activity.upsert",
            "activityRevision": event.revision,
            "record": record
        }),
        ActivityChange::Remove { activity_ids } => json!({
            "type": "activity.remove",
            "activityRevision": event.revision,
            "activityIds": activity_ids
        }),
    }
}

pub(crate) fn project_stream_value(item: ProjectStreamItem, binding_id: &str) -> Value {
    match item {
        ProjectStreamItem::Snapshot(sync) => {
            let snapshot = public_project_snapshot(&sync.snapshot, binding_id);
            json!({
            "type": "sync",
            "domain": "project",
            "bindingId": binding_id,
            "revision": sync.project_revision,
            "snapshot": snapshot
            })
        }
        ProjectStreamItem::Event(event) => match event.change {
            ProjectChange::ProjectChanged(snapshot) => {
                let snapshot = public_project_snapshot(&snapshot, binding_id);
                json!({
                "type": "project.changed",
                "bindingId": binding_id,
                "projectRevision": event.project_revision,
                "snapshot": snapshot
                })
            }
            ProjectChange::ProjectFileChanged {
                project_relative_path,
                snapshot,
            } => {
                let snapshot = public_project_snapshot(&snapshot, binding_id);
                json!({
                "type": "project.fileChanged",
                "bindingId": binding_id,
                "projectRevision": event.project_revision,
                "event": {"projectRelativePath": project_relative_path},
                "snapshot": snapshot
                })
            }
            ProjectChange::CanvasStateChanged { change } => json!({
                "type": "canvas.state.changed",
                "bindingId": binding_id,
                "projectRevision": event.project_revision,
                "change": change
            }),
            ProjectChange::CanvasFeedbackChanged { feedback, .. } => json!({
                "type": "canvas.feedback.changed",
                "bindingId": binding_id,
                "projectRevision": event.project_revision,
                "feedback": feedback
            }),
        },
    }
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
        for command in ["operation.cancel", "request.single", "request.batch"] {
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
            change: GlobalRuntimeChange::RecentProjectsChanged(vec!["/project".to_owned()]),
        });
        assert_eq!(global["type"], "recentProjects.changed");
        assert_eq!(global["revision"], 2);
    }
}
