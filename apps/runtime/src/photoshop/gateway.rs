use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use tokio::sync::{mpsc as tokio_mpsc, oneshot};

use crate::workbench::websocket::{
    WebSocketMessage, WebSocketUpgrade, read_message, read_text, write_close, write_pong,
    write_text,
};

use super::{
    PHOTOSHOP_GATEWAY_PORTS, PHOTOSHOP_MAX_FILE_BYTES, PHOTOSHOP_MAX_FRAME_BYTES,
    PHOTOSHOP_UXP_ORIGIN, PHOTOSHOP_WEBSOCKET_SUBPROTOCOL, PhotoshopError, PhotoshopIntegration,
    PluginPhotoshopMessage, RuntimePhotoshopMessage,
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const PHOTOSHOP_MAX_FILE_BODY_BYTES: usize = 256 * 1024 * 1024 + 1;

#[derive(Clone)]
struct GatewayState {
    integration: Arc<PhotoshopIntegration>,
    authority: String,
}

pub struct PhotoshopGatewayServer {
    port: Option<u16>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl PhotoshopGatewayServer {
    #[must_use]
    pub fn start(integration: Arc<PhotoshopIntegration>) -> Self {
        let Some(listener) = bind_first_gateway_listener() else {
            eprintln!(
                "Debrute Photoshop gateway disabled: ports 32124 through 32131 are unavailable"
            );
            return Self::disabled();
        };
        if let Err(error) = listener.set_nonblocking(true) {
            eprintln!("Debrute Photoshop gateway disabled: listener setup failed: {error}");
            return Self::disabled();
        }
        let Ok(address) = listener.local_addr() else {
            eprintln!("Debrute Photoshop gateway disabled: listener address is unavailable");
            return Self::disabled();
        };
        let state = GatewayState {
            integration,
            authority: address.to_string(),
        };
        let router = gateway_router(state);
        let (startup_sender, startup_receiver) = mpsc::sync_channel(0);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let server_thread = thread::Builder::new()
            .name("debrute-photoshop-gateway".to_owned())
            .spawn(move || run_gateway(listener, router, startup_sender, shutdown_receiver));
        let Ok(thread) = server_thread else {
            eprintln!("Debrute Photoshop gateway disabled: worker could not start");
            return Self::disabled();
        };
        match startup_receiver.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                eprintln!("Debrute Photoshop gateway disabled: {error}");
                let _ = thread.join();
                return Self::disabled();
            }
            Err(error) => {
                eprintln!("Debrute Photoshop gateway disabled: startup channel failed: {error}");
                let _ = thread.join();
                return Self::disabled();
            }
        }
        Self {
            port: Some(address.port()),
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }

    const fn disabled() -> Self {
        Self {
            port: None,
            shutdown: None,
            thread: None,
        }
    }

    #[must_use]
    pub const fn port(&self) -> Option<u16> {
        self.port
    }
}

impl Drop for PhotoshopGatewayServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn bind_first_gateway_listener() -> Option<TcpListener> {
    let mut ports = PHOTOSHOP_GATEWAY_PORTS;
    ports.find_map(|port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok())
}

fn gateway_router(state: GatewayState) -> Router {
    Router::new()
        .route("/photoshop/session", get(session).options(preflight))
        .route(
            "/photoshop/commands/{command_id}/content",
            get(command_content).options(preflight),
        )
        .route(
            "/photoshop/exports/{command_id}/items/{item_id}",
            post(export_item).options(preflight),
        )
        .fallback(not_found)
        .with_state(state)
}

fn run_gateway(
    listener: TcpListener,
    router: Router,
    startup: mpsc::SyncSender<Result<(), String>>,
    shutdown: oneshot::Receiver<()>,
) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
    else {
        let _ = startup.send(Err("async Runtime could not start".to_owned()));
        return;
    };
    runtime.block_on(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            let _ = startup.send(Err("async listener could not start".to_owned()));
            return;
        };
        if startup.send(Ok(())).is_err() {
            return;
        }
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        );
        tokio::select! {
            result = server => {
                if let Err(error) = result {
                    eprintln!("Debrute Photoshop gateway stopped unexpectedly: {error}");
                }
            }
            _ = shutdown => {}
        }
    });
    runtime.shutdown_timeout(SHUTDOWN_TIMEOUT);
}

async fn session(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if !base_request_valid(&state, peer, &headers) {
        eprintln!(
            "Debrute Photoshop WebSocket rejected: request was not exact loopback gateway traffic"
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    if !uxp_origin_valid(&headers) {
        eprintln!("Debrute Photoshop WebSocket rejected: unexpected UXP origin");
        return StatusCode::FORBIDDEN.into_response();
    }
    if exact_header(&headers, header::SEC_WEBSOCKET_PROTOCOL)
        != Some(PHOTOSHOP_WEBSOCKET_SUBPROTOCOL)
    {
        eprintln!("Debrute Photoshop WebSocket rejected: required subprotocol was not requested");
        return StatusCode::FORBIDDEN.into_response();
    }
    let upgrade = match WebSocketUpgrade::from_request(request) {
        Ok(upgrade) => upgrade,
        Err(response) => return response,
    };
    let integration = Arc::clone(&state.integration);
    let mut response = upgrade.on_upgrade(move |connection| {
        tokio::spawn(run_session(connection, integration));
    });
    response.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(PHOTOSHOP_WEBSOCKET_SUBPROTOCOL),
    );
    response
}

async fn run_session(
    connection: crate::workbench::websocket::WebSocketConnection,
    integration: Arc<PhotoshopIntegration>,
) {
    let (mut reader, mut writer) = tokio::io::split(connection.into_io());
    let first = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        read_text(&mut reader, PHOTOSHOP_MAX_FRAME_BYTES),
    )
    .await;
    let first = match first {
        Ok(Ok(Some(first))) => first,
        Ok(Ok(None)) => {
            eprintln!("Debrute Photoshop session rejected: connection closed before session start");
            let _ = write_close(&mut writer).await;
            return;
        }
        Ok(Err(error)) => {
            eprintln!("Debrute Photoshop session rejected: invalid WebSocket frame: {error}");
            let _ = write_close(&mut writer).await;
            return;
        }
        Err(_) => {
            eprintln!("Debrute Photoshop session rejected: session start timed out");
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let message = match serde_json::from_str::<PluginPhotoshopMessage>(&first) {
        Ok(message) => message,
        Err(error) => {
            eprintln!("Debrute Photoshop session rejected: invalid session start: {error}");
            let _ = write_close(&mut writer).await;
            return;
        }
    };
    let Some((host_version, placement_mime_types, documents)) = message.session_start() else {
        eprintln!("Debrute Photoshop session rejected: first message was not session start");
        let _ = write_close(&mut writer).await;
        return;
    };
    let (outbound, mut outgoing) = tokio_mpsc::channel(64);
    let admission =
        match integration.connect(host_version, placement_mime_types, documents, outbound) {
            Ok(admission) => admission,
            Err(error) => {
                eprintln!("Debrute Photoshop session rejected: {error}");
                let _ = write_close(&mut writer).await;
                return;
            }
        };
    if write_message(&mut writer, &admission.ready).await.is_err()
        || write_message(&mut writer, &admission.projects)
            .await
            .is_err()
    {
        eprintln!("Debrute Photoshop session ended while sending its initial snapshots");
        integration.disconnect(&admission.plugin_session_id);
        let _ = write_close(&mut writer).await;
        return;
    }
    let session_id = admission.plugin_session_id;
    loop {
        tokio::select! {
            outgoing_message = outgoing.recv() => {
                let Some(message) = outgoing_message else { break; };
                if write_message(&mut writer, &message).await.is_err() { break; }
            }
            incoming = read_message(&mut reader, PHOTOSHOP_MAX_FRAME_BYTES) => {
                match incoming {
                    Ok(Some(WebSocketMessage::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<PluginPhotoshopMessage>(&text) else { break; };
                        if integration.handle_message(&session_id, message).is_err() { break; }
                    }
                    Ok(Some(WebSocketMessage::Ping(payload))) => {
                        if write_pong(&mut writer, &payload).await.is_err() { break; }
                    }
                    Ok(Some(WebSocketMessage::Pong)) => {}
                    Ok(Some(WebSocketMessage::Close) | None) | Err(_) => break,
                }
            }
        }
    }
    integration.disconnect(&session_id);
    let _ = write_close(&mut writer).await;
}

async fn command_content(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(command_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(bearer) = authorize_http(&state, peer, &headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    match state.integration.content(&bearer, &command_id) {
        Ok(content) => cors(
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_LENGTH, content.byte_length)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(content.bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        ),
        Err(error) => error_response(&error),
    }
}

async fn export_item(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((command_id, item_id)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let Some(bearer) = authorize_http(&state, peer, &headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if exact_header(&headers, header::CONTENT_TYPE) != Some("image/png") {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_transfer_payload",
            "Photoshop export item must be image/png.",
        );
    }
    let Some(declared_length) =
        exact_header(&headers, header::CONTENT_LENGTH).and_then(|value| value.parse::<u64>().ok())
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_transfer_payload",
            "Photoshop export item requires Content-Length.",
        );
    };
    if declared_length > PHOTOSHOP_MAX_FILE_BYTES {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "Photoshop export item exceeds 256 MiB.",
        );
    }
    let Ok(body) = to_bytes(request.into_body(), PHOTOSHOP_MAX_FILE_BODY_BYTES).await else {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "Photoshop export item exceeds 256 MiB.",
        );
    };
    if body.len() as u64 != declared_length {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_transfer_payload",
            "Photoshop export length does not match Content-Length.",
        );
    }
    match state
        .integration
        .upload(&bearer, &command_id, &item_id, &body)
    {
        Ok(result) => cors(Json(result).into_response()),
        Err(error) => error_response(&error),
    }
}

async fn preflight(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !base_request_valid(&state, peer, &headers) || !uxp_http_origin_valid(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = cors(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

async fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

fn authorize_http(state: &GatewayState, peer: SocketAddr, headers: &HeaderMap) -> Option<String> {
    if !base_request_valid(state, peer, headers) || !uxp_http_origin_valid(headers) {
        return None;
    }
    exact_header(headers, header::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn base_request_valid(state: &GatewayState, peer: SocketAddr, headers: &HeaderMap) -> bool {
    peer.ip().is_loopback() && exact_header(headers, header::HOST) == Some(state.authority.as_str())
}

fn uxp_origin_valid(headers: &HeaderMap) -> bool {
    exact_header(headers, header::ORIGIN) == Some(PHOTOSHOP_UXP_ORIGIN)
}

fn uxp_http_origin_valid(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(header::ORIGIN).iter();
    match (values.next(), values.next()) {
        (None, None) => true,
        (Some(value), None) => value.to_str().ok() == Some(PHOTOSHOP_UXP_ORIGIN),
        _ => false,
    }
}

fn exact_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

fn cors(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(PHOTOSHOP_UXP_ORIGIN),
    );
    response
}

fn error_response(error_value: &PhotoshopError) -> Response {
    let status = match error_value.code().as_str() {
        "photoshop_session_invalid" => StatusCode::FORBIDDEN,
        "photoshop_busy" | "project_revision_changed" => StatusCode::CONFLICT,
        "file_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "target_directory_missing" => StatusCode::NOT_FOUND,
        _ => StatusCode::BAD_REQUEST,
    };
    error(
        status,
        error_value.code().as_str(),
        &error_value.to_string(),
    )
}

fn error(status: StatusCode, code: &'static str, message: &str) -> Response {
    cors(
        (
            status,
            Json(json!({"error": {"code": code, "message": message}})),
        )
            .into_response(),
    )
}

async fn write_message<Writer>(
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

#[cfg(test)]
mod tests {
    use std::{net::TcpStream, thread, time::Duration};

    use super::*;

    #[test]
    fn uxp_origin_is_the_exact_file_origin_emitted_by_photoshop() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static(PHOTOSHOP_UXP_ORIGIN),
        );
        assert!(uxp_origin_valid(&headers));

        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!uxp_origin_valid(&headers));
        headers.remove(header::ORIGIN);
        assert!(!uxp_origin_valid(&headers));
    }

    #[test]
    fn uxp_http_origin_allows_the_absent_origin_emitted_by_photoshop_fetch() {
        let mut headers = HeaderMap::new();
        assert!(uxp_http_origin_valid(&headers));

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static(PHOTOSHOP_UXP_ORIGIN),
        );
        assert!(uxp_http_origin_valid(&headers));

        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!uxp_http_origin_valid(&headers));
    }

    #[test]
    fn gateway_uses_first_free_port_in_the_closed_pool() {
        let mut occupied = PHOTOSHOP_GATEWAY_PORTS
            .filter_map(|port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok())
            .collect::<Vec<_>>();
        let released = occupied
            .pop()
            .expect("at least one Photoshop gateway port must be free for this test");
        let expected = released.local_addr().unwrap().port();
        drop(released);
        let listener = bind_first_gateway_listener().unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), expected);
        drop(occupied);
    }

    #[test]
    fn gateway_worker_remains_live_until_shutdown() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route("/health", get(|| async { StatusCode::NO_CONTENT }));
        let (startup_sender, startup_receiver) = mpsc::sync_channel(0);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let worker = thread::spawn(move || {
            run_gateway(listener, router, startup_sender, shutdown_receiver);
        });
        assert_eq!(startup_receiver.recv().unwrap(), Ok(()));

        thread::sleep(Duration::from_millis(650));
        let connection = TcpStream::connect(address).unwrap();
        drop(connection);
        shutdown.send(()).unwrap();
        worker.join().unwrap();
    }
}
