#![allow(clippy::items_after_statements, clippy::manual_let_else)]

use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{ConnectInfo, OriginalUri, Request, State},
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
        header::{AUTHORIZATION, COOKIE, HOST, ORIGIN},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Serialize;

use super::{
    CliAuthorizationVerifier, WORKBENCH_CONNECTION_HEADER, WORKBENCH_SESSION_COOKIE,
    WorkbenchLaunchService, WorkbenchRuntimeServices, authority::is_opaque_value,
};
use crate::photoshop::{PHOTOSHOP_CEP_FILE_ORIGIN, PHOTOSHOP_UXP_ORIGIN};

use super::routes::{
    browser_api_router, cli_api_router, plugin_api_router, plugin_transfer_router,
};

#[derive(Clone)]
pub(super) struct WorkbenchRouterState {
    pub origin: String,
    authority: String,
    pub(super) launch_service: Arc<WorkbenchLaunchService>,
    cli_authorization: Arc<dyn CliAuthorizationVerifier>,
    pub services: Option<Arc<WorkbenchRuntimeServices>>,
    assets_directory: PathBuf,
    index_path: PathBuf,
}

#[derive(Debug, Clone)]
pub(super) struct BrowserSession(pub String);

#[derive(Debug, Clone)]
pub(super) struct ProjectAuthorization {
    pub project_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct PluginAuthorization {
    pub bearer: String,
    pub plugin_instance_id: String,
}

pub(super) fn workbench_router(
    assets_directory: PathBuf,
    index_path: PathBuf,
    launch_service: Arc<WorkbenchLaunchService>,
    cli_authorization: Arc<dyn CliAuthorizationVerifier>,
    services: Option<Arc<WorkbenchRuntimeServices>>,
) -> Router {
    let origin = launch_service.origin().to_owned();
    let authority = origin
        .strip_prefix("http://")
        .expect("Runtime creates an HTTP origin")
        .to_owned();
    let state = WorkbenchRouterState {
        origin,
        authority,
        launch_service,
        cli_authorization,
        services,
        assets_directory,
        index_path,
    };
    let cli_api = cli_api_router()
        .fallback(route_not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            authorize_cli_api,
        ));
    let workbench_api =
        browser_api_router()
            .fallback(route_not_found)
            .layer(middleware::from_fn_with_state(
                state.clone(),
                authorize_workbench_api,
            ));
    let connection_route = Router::new().route(
        "/api/workbench/connection",
        post(super::routes::workbench_connection),
    );
    let plugin_api =
        plugin_api_router()
            .fallback(route_not_found)
            .layer(middleware::from_fn_with_state(
                state.clone(),
                authorize_plugin_api,
            ));
    let plugin_transfers =
        plugin_transfer_router()
            .fallback(route_not_found)
            .layer(middleware::from_fn_with_state(
                state.clone(),
                authorize_plugin_api,
            ));
    Router::new()
        .merge(connection_route)
        .nest("/api/cli", cli_api)
        .nest("/api/adobe-bridge/plugin", plugin_api)
        .nest("/api/adobe-bridge/transfers", plugin_transfers)
        .nest("/api", workbench_api)
        .fallback(serve_web_asset)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            validate_native_boundary,
        ))
        .with_state(state)
}

async fn serve_web_asset(State(state): State<WorkbenchRouterState>, request: Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "Workbench assets support only GET and HEAD.",
        );
    }
    let path = request.uri().path().trim_start_matches('/');
    if matches!(path.split('/').next(), Some("api" | "adobe-bridge")) {
        return route_not_found_response();
    }
    if path.split('/').any(|segment| {
        segment == ".." || segment.contains('\\') || segment.contains('\0') || segment.contains('%')
    }) {
        return route_not_found_response();
    }
    let requested = if path.is_empty() {
        state.index_path.clone()
    } else {
        state.assets_directory.join(path)
    };
    let selected = match tokio::fs::metadata(&requested).await {
        Ok(metadata) if metadata.is_file() => requested,
        _ if std::path::Path::new(path).extension().is_none() => state.index_path.clone(),
        _ => return route_not_found_response(),
    };
    let root = match tokio::fs::canonicalize(&state.assets_directory).await {
        Ok(root) => root,
        Err(_) => return route_not_found_response(),
    };
    let selected = match tokio::fs::canonicalize(&selected).await {
        Ok(selected) if selected.starts_with(&root) => selected,
        _ => return route_not_found_response(),
    };
    let bytes = match tokio::fs::read(&selected).await {
        Ok(bytes) => bytes,
        Err(_) => return route_not_found_response(),
    };
    let content_type = web_asset_content_type(&selected);
    let cache_control = if selected == root.join("index.html") {
        "no-cache"
    } else if is_hashed_asset(&selected) {
        "public,max-age=31536000,immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .header(axum::http::header::CONTENT_LENGTH, bytes.len())
        .header(axum::http::header::CACHE_CONTROL, cache_control)
        .body(if request.method() == Method::HEAD {
            axum::body::Body::empty()
        } else {
            axum::body::Body::from(bytes)
        })
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn web_asset_content_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn is_hashed_asset(path: &std::path::Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem.split(['-', '.']).any(|segment| {
                segment.len() >= 8 && segment.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        })
}

async fn validate_native_boundary(
    State(state): State<WorkbenchRouterState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if !peer.ip().is_loopback() || !has_exact_header(request.headers(), HOST, &state.authority) {
        return error_response(
            StatusCode::MISDIRECTED_REQUEST,
            "invalid_host",
            "Debrute Workbench requires its exact numeric loopback Host.",
        );
    }
    next.run(request).await
}

async fn authorize_workbench_api(
    State(state): State<WorkbenchRouterState>,
    request: Request,
    next: Next,
) -> Response {
    if request.headers().contains_key(AUTHORIZATION) {
        return forbidden();
    }
    let Ok(Some(session)) = browser_session_cookie(request.headers()) else {
        return forbidden();
    };
    let session = session.to_owned();
    let connection_header = HeaderName::from_static(WORKBENCH_CONNECTION_HEADER);
    let original_path = request
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| request.uri().path(), |uri| uri.0.path());
    let project_id =
        scoped_project_id(original_path).map(|project_id| project_id.map(str::to_owned));
    let Ok(project_id) = project_id else {
        return forbidden();
    };
    let Some(services) = state.services.as_ref() else {
        return forbidden();
    };
    let passive_media = matches!(*request.method(), Method::GET | Method::HEAD)
        && is_passive_project_media_route(original_path);
    let is_websocket =
        has_exact_header(request.headers(), axum::http::header::UPGRADE, "websocket");
    let is_terminal_websocket = request.uri().path().ends_with("/terminals/ws") && is_websocket;
    let context = if passive_media || is_terminal_websocket {
        services.connections().context_for_browser_session(&session)
    } else {
        let Ok(Some(credential)) = one_header(request.headers(), connection_header) else {
            return forbidden();
        };
        services.connections().authorize(&session, credential)
    };
    let Some(context) = context else {
        return forbidden();
    };
    let mut request = request;
    request
        .extensions_mut()
        .insert(BrowserSession(session.clone()));
    request.extensions_mut().insert(context.clone());
    if let Some(project_id) = project_id {
        if context.project_id.as_deref() != Some(project_id.as_str()) {
            return forbidden();
        }
        if is_terminal_websocket {
            // The first closed Terminal frame binds the Workbench connection
            // because browser WebSocket constructors cannot set custom headers.
        } else {
            request
                .extensions_mut()
                .insert(ProjectAuthorization { project_id });
        }
    }
    let supplied_origin = one_header(request.headers(), ORIGIN);
    if supplied_origin.is_err()
        || supplied_origin
            .ok()
            .flatten()
            .is_some_and(|origin| origin != state.origin)
    {
        return forbidden();
    }
    if (is_websocket || request.method() != Method::GET && request.method() != Method::HEAD)
        && !has_exact_header(request.headers(), ORIGIN, &state.origin)
    {
        return forbidden();
    }
    next.run(request).await
}

async fn authorize_cli_api(
    State(state): State<WorkbenchRouterState>,
    request: Request,
    next: Next,
) -> Response {
    if request.headers().contains_key(ORIGIN) {
        return forbidden();
    }
    let Ok(Some(authorization)) = one_header(request.headers(), AUTHORIZATION) else {
        return forbidden();
    };
    let Some(authorization) = authorization.strip_prefix("Bearer ") else {
        return forbidden();
    };
    if authorization.is_empty() || !state.cli_authorization.is_cli_authorized(authorization) {
        return forbidden();
    }
    next.run(request).await
}

async fn authorize_plugin_api(
    State(state): State<WorkbenchRouterState>,
    request: Request,
    next: Next,
) -> Response {
    let Ok(Some(origin)) = one_header(request.headers(), ORIGIN) else {
        return forbidden();
    };
    let origin = origin.to_owned();
    if !matches!(
        origin.as_str(),
        PHOTOSHOP_UXP_ORIGIN | PHOTOSHOP_CEP_FILE_ORIGIN
    ) {
        return forbidden();
    }
    let path = request.uri().path();
    let Some(allowed_methods) = plugin_allowed_methods(path) else {
        return route_not_found_response();
    };
    if request.method() == Method::OPTIONS {
        let requested_method = one_header(
            request.headers(),
            axum::http::header::ACCESS_CONTROL_REQUEST_METHOD,
        )
        .ok()
        .flatten();
        if requested_method.is_none_or(|method| {
            !allowed_methods
                .split(',')
                .any(|allowed| allowed.trim() == method)
        }) || !plugin_preflight_headers_allowed(request.headers())
        {
            return forbidden();
        }
        let mut response = plugin_cors_response(StatusCode::NO_CONTENT.into_response(), &origin);
        response.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(allowed_methods),
        );
        response.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        return response;
    }
    if request.headers().contains_key(COOKIE) {
        return forbidden();
    }
    let is_websocket = path == "/ws"
        && has_exact_header(request.headers(), axum::http::header::UPGRADE, "websocket");
    let mut request = request;
    if is_websocket {
        if request.headers().contains_key(AUTHORIZATION) {
            return forbidden();
        }
    } else {
        let Ok(Some(authorization)) = one_header(request.headers(), AUTHORIZATION) else {
            return forbidden();
        };
        let Some(bearer) = authorization.strip_prefix("Bearer ") else {
            return forbidden();
        };
        let bearer = bearer.to_owned();
        let Some(services) = state.services.as_ref() else {
            return forbidden();
        };
        let plugin_instance_id = match services.photoshop().state_for_bearer(&bearer) {
            Ok(view) => view
                .paired_plugins
                .first()
                .map(|plugin| plugin.plugin_instance_id.clone()),
            Err(_) => None,
        };
        let Some(plugin_instance_id) = plugin_instance_id else {
            return forbidden();
        };
        request.extensions_mut().insert(PluginAuthorization {
            bearer,
            plugin_instance_id,
        });
    }
    let response = next.run(request).await;
    plugin_cors_response(response, &origin)
}

fn plugin_cors_response(mut response: Response, origin: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(origin) {
        response
            .headers_mut()
            .insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    response.headers_mut().insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Authorization, Content-Type, X-Debrute-Plugin-Instance, X-Debrute-Transfer-Id, X-Debrute-Target-Directory, X-Debrute-Suggested-Name",
        ),
    );
    response
        .headers_mut()
        .insert(axum::http::header::VARY, HeaderValue::from_static("Origin"));
    response
}

fn plugin_allowed_methods(path: &str) -> Option<&'static str> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    match segments.as_slice() {
        ["ws"] => Some("GET"),
        ["projects", project_id, "link"] if is_opaque_value(project_id) => Some("POST, DELETE"),
        ["projects", project_id, "uploads"] if is_opaque_value(project_id) => Some("POST"),
        [transfer_id, "content"] if is_opaque_value(transfer_id) => Some("GET, HEAD"),
        _ => None,
    }
}

fn plugin_preflight_headers_allowed(headers: &HeaderMap) -> bool {
    let Ok(requested) = one_header(headers, axum::http::header::ACCESS_CONTROL_REQUEST_HEADERS)
    else {
        return false;
    };
    const ALLOWED: &[&str] = &[
        "authorization",
        "content-type",
        "x-debrute-plugin-instance",
        "x-debrute-transfer-id",
        "x-debrute-target-directory",
        "x-debrute-suggested-name",
    ];
    requested.is_none_or(|requested| {
        requested.split(',').map(str::trim).all(|name| {
            !name.is_empty()
                && ALLOWED
                    .iter()
                    .any(|allowed| name.eq_ignore_ascii_case(allowed))
        })
    })
}

fn route_not_found_response() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "not_found",
        "Unknown Debrute Runtime route.",
    )
}

async fn route_not_found() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "not_found",
        "Unknown Debrute Runtime route.",
    )
}

fn forbidden() -> Response {
    error_response(
        StatusCode::FORBIDDEN,
        "forbidden",
        "Debrute Runtime session is not authorized for this route.",
    )
}

pub(super) fn error_response(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> Response {
    (
        status,
        Json(ErrorEnvelope {
            error: ErrorBody {
                code,
                message: message.into(),
            },
        }),
    )
        .into_response()
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

fn browser_session_cookie(headers: &HeaderMap) -> Result<Option<&str>, ()> {
    let mut session = None;
    for cookie_header in headers.get_all(COOKIE) {
        let cookie_header = cookie_header.to_str().map_err(|_| ())?;
        for part in cookie_header.split(';') {
            let Some((name, value)) = part.trim().split_once('=') else {
                continue;
            };
            if name != WORKBENCH_SESSION_COOKIE {
                continue;
            }
            if session.is_some() || !is_opaque_value(value) {
                return Err(());
            }
            session = Some(value);
        }
    }
    Ok(session)
}

fn has_exact_header(headers: &HeaderMap, name: axum::http::HeaderName, expected: &str) -> bool {
    matches!(one_header(headers, name), Ok(Some(value)) if value == expected)
}

fn one_header(headers: &HeaderMap, name: axum::http::HeaderName) -> Result<Option<&str>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    value.to_str().map(Some).map_err(|_| ())
}

fn scoped_project_id(path: &str) -> Result<Option<&str>, ()> {
    if matches!(
        path,
        "/api/projects/open"
            | "/api/projects/choose"
            | "/api/projects/discover"
            | "/api/projects/replace"
    ) {
        return Ok(None);
    }
    let Some(tail) = path.strip_prefix("/api/projects/") else {
        return Ok(None);
    };
    let project_id = tail.split('/').next().ok_or(())?;
    if !is_opaque_value(project_id) {
        return Err(());
    }
    Ok(Some(project_id))
}

fn is_passive_project_media_route(path: &str) -> bool {
    path.contains("/files/raw/")
        || path.contains("/generated-assets/") && path.ends_with("/raw")
        || path.ends_with("/canvas-image-preview")
        || path.ends_with("/canvas-text-preview")
        || path.ends_with("/canvas-video-preview")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_surface_has_exact_methods_and_origins() {
        assert_eq!(plugin_allowed_methods("/ws"), Some("GET"));
        assert_eq!(
            plugin_allowed_methods("/projects/project-1/link"),
            Some("POST, DELETE")
        );
        assert_eq!(
            plugin_allowed_methods("/projects/project-1/uploads"),
            Some("POST")
        );
        assert_eq!(
            plugin_allowed_methods("/transfer-1/content"),
            Some("GET, HEAD")
        );
        assert_eq!(plugin_allowed_methods("/projects/project-1/unknown"), None);
        assert_ne!(PHOTOSHOP_UXP_ORIGIN, "null");
        assert_ne!(PHOTOSHOP_CEP_FILE_ORIGIN, "null");
    }

    #[test]
    fn static_asset_cache_detection_requires_a_content_hash_segment() {
        assert!(is_hashed_asset(std::path::Path::new(
            "assets/app-a1b2c3d4.js"
        )));
        assert!(is_hashed_asset(std::path::Path::new(
            "assets/app.a1b2c3d4.css"
        )));
        assert!(!is_hashed_asset(std::path::Path::new("index.html")));
        assert!(!is_hashed_asset(std::path::Path::new("assets/runtime.js")));
    }

    #[test]
    fn passive_project_media_routes_cover_dom_resource_requests_only() {
        assert!(is_passive_project_media_route(
            "/api/projects/project-1/canvas-image-preview"
        ));
        assert!(is_passive_project_media_route(
            "/api/projects/project-1/canvas-text-preview"
        ));
        assert!(is_passive_project_media_route(
            "/api/projects/project-1/canvas-video-preview"
        ));
        assert!(!is_passive_project_media_route(
            "/api/projects/project-1/canvas-text-previews/source"
        ));
    }
}
