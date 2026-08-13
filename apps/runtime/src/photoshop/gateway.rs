use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Path, Request, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{MethodFilter, MethodRouter},
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
        .route(
            "/photoshop/session",
            MethodRouter::new()
                .on(MethodFilter::GET, session)
                .on(MethodFilter::HEAD, method_not_allowed)
                .fallback(method_not_allowed),
        )
        .route(
            "/photoshop/commands/{command_id}/content",
            MethodRouter::new()
                .on(MethodFilter::GET, command_content)
                .on(MethodFilter::HEAD, method_not_allowed)
                .on(MethodFilter::OPTIONS, command_content_preflight)
                .fallback(method_not_allowed),
        )
        .route(
            "/photoshop/exports/{command_id}/items/{item_id}",
            MethodRouter::new()
                .on(MethodFilter::POST, export_item)
                .on(MethodFilter::OPTIONS, export_item_preflight)
                .fallback(method_not_allowed),
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
        return websocket_handshake_invalid_response();
    }
    if !uxp_origin_valid(&headers) {
        eprintln!("Debrute Photoshop WebSocket rejected: unexpected UXP origin");
        return websocket_handshake_invalid_response();
    }
    if exact_header(&headers, header::SEC_WEBSOCKET_PROTOCOL)
        != Some(PHOTOSHOP_WEBSOCKET_SUBPROTOCOL)
    {
        eprintln!("Debrute Photoshop WebSocket rejected: required subprotocol was not requested");
        return websocket_handshake_invalid_response();
    }
    let upgrade = match WebSocketUpgrade::from_request(request) {
        Ok(upgrade) => upgrade,
        Err(_) => {
            eprintln!("Debrute Photoshop WebSocket rejected: upgrade request was invalid");
            return websocket_handshake_invalid_response();
        }
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
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let Ok(Path(command_id)) = path else {
        return invalid_path_parameter_response();
    };
    let Some(bearer) = authorize_http(&state, peer, &headers) else {
        return session_invalid_response();
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
        Err(error) if error.code().as_str() == "invalid_transfer_payload" => {
            session_invalid_response()
        }
        Err(error) => error_response(&error),
    }
}

async fn export_item(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let Ok(Path((command_id, item_id))) = path else {
        return invalid_path_parameter_response();
    };
    let Some(bearer) = authorize_http(&state, peer, &headers) else {
        return session_invalid_response();
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
        Err(error) if error.code().as_str() == "invalid_transfer_payload" => {
            session_invalid_response()
        }
        Err(error) => error_response(&error),
    }
}

async fn command_content_preflight(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !base_request_valid(&state, peer, &headers)
        || !exact_preflight(&headers, "GET", &["Authorization"])
    {
        return session_invalid_response();
    }
    let mut response = cors(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization"),
    );
    response
}

async fn export_item_preflight(
    State(state): State<GatewayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !base_request_valid(&state, peer, &headers)
        || !exact_preflight(&headers, "POST", &["Authorization", "Content-Type"])
    {
        return session_invalid_response();
    }
    let mut response = cors(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("POST"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    response
}

async fn not_found() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "photoshop_protocol_invalid",
        "Photoshop gateway route does not exist.",
    )
}

async fn method_not_allowed() -> Response {
    error(
        StatusCode::METHOD_NOT_ALLOWED,
        "photoshop_protocol_invalid",
        "Photoshop gateway method is not allowed.",
    )
}

fn invalid_path_parameter_response() -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "photoshop_protocol_invalid",
        "Photoshop gateway path parameter is invalid.",
    )
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

fn exact_preflight(headers: &HeaderMap, method: &str, allowed_headers: &[&str]) -> bool {
    if !uxp_origin_valid(headers)
        || exact_header(headers, header::ACCESS_CONTROL_REQUEST_METHOD) != Some(method)
    {
        return false;
    }
    let Some(requested_headers) = exact_header(headers, header::ACCESS_CONTROL_REQUEST_HEADERS)
    else {
        return false;
    };
    let requested_headers = requested_headers
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    requested_headers.len() == allowed_headers.len()
        && requested_headers.iter().all(|requested| {
            !requested.is_empty()
                && allowed_headers
                    .iter()
                    .any(|allowed| requested.eq_ignore_ascii_case(allowed))
        })
        && allowed_headers.iter().all(|allowed| {
            requested_headers
                .iter()
                .any(|requested| requested.eq_ignore_ascii_case(allowed))
        })
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

fn session_invalid_response() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "photoshop_session_invalid",
        "Photoshop session is not live.",
    )
}

fn websocket_handshake_invalid_response() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "photoshop_protocol_invalid",
        "Photoshop WebSocket handshake is invalid.",
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
    use std::{
        fs,
        io::{BufReader, Read as _, Write as _},
        net::{SocketAddr, TcpStream},
        path::{Path, PathBuf},
        sync::Arc,
        thread,
        time::Duration,
    };

    use axum::routing::get;
    use reqwest::blocking::Client;
    use serde_json::json;

    use crate::{
        control::RuntimeControlState,
        project::{
            CanvasFeedbackArtifacts, DefaultProjectNodeAdapter, ProjectPreviewService,
            ProjectSessionRegistry, ProjectUse, ProjectUseKind,
        },
    };

    use super::*;

    struct TemporaryDirectory(PathBuf);

    impl TemporaryDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "debrute-photoshop-gateway-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
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
            fs::remove_dir_all(&self.0).unwrap_or_else(|error| {
                panic!(
                    "failed to remove temporary Photoshop gateway directory {}: {error}",
                    self.0.display()
                )
            });
        }
    }

    struct TestGateway {
        address: SocketAddr,
        integration: Arc<PhotoshopIntegration>,
        canonical_root: String,
        project_revision: u64,
        shutdown: Option<oneshot::Sender<()>>,
        worker: Option<thread::JoinHandle<()>>,
        _project_use: ProjectUse,
        _project: TemporaryDirectory,
        _home: TemporaryDirectory,
    }

    impl TestGateway {
        fn start() -> Self {
            let home = TemporaryDirectory::new("home");
            let project = TemporaryDirectory::new("project");
            fs::write(project.as_ref().join("source.png"), b"project source").unwrap();
            let previews = Arc::new(ProjectPreviewService::new_for_test());
            let feedback = Arc::new(CanvasFeedbackArtifacts::new(previews).unwrap());
            let projects = ProjectSessionRegistry::new(
                home.as_ref(),
                Arc::new(DefaultProjectNodeAdapter),
                feedback,
            );
            let opened = projects
                .open_project(project.as_ref(), ProjectUseKind::Workbench)
                .unwrap();
            let summary = opened.session.summary().unwrap();
            let canonical_root = summary.canonical_root;
            let project_revision = summary.project_revision;
            let runtime_state = Arc::new(RuntimeControlState::new("runtime-1"));
            assert!(runtime_state.finish_startup());
            let integration = Arc::new(PhotoshopIntegration::new(
                "runtime-1".to_owned(),
                runtime_state,
                projects,
                Arc::new(|_| {}),
            ));
            integration.initialize_enabled(true);
            integration.set_gateway_available(true);

            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let router = gateway_router(GatewayState {
                integration: Arc::clone(&integration),
                authority: address.to_string(),
            });
            let (startup_sender, startup_receiver) = mpsc::sync_channel(0);
            let (shutdown, shutdown_receiver) = oneshot::channel();
            let worker = thread::spawn(move || {
                run_gateway(listener, router, startup_sender, shutdown_receiver);
            });
            assert_eq!(startup_receiver.recv().unwrap(), Ok(()));
            Self {
                address,
                integration,
                canonical_root,
                project_revision,
                shutdown: Some(shutdown),
                worker: Some(worker),
                _project_use: opened.project_use,
                _project: project,
                _home: home,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.address)
        }
    }

    impl Drop for TestGateway {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                shutdown
                    .send(())
                    .expect("Photoshop gateway worker exited before test teardown");
            }
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
            drop(TcpListener::bind(self.address).unwrap_or_else(|error| {
                panic!(
                    "Photoshop gateway test listener {} was not released: {error}",
                    self.address
                )
            }));
        }
    }

    fn client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    struct TestWebSocket {
        reader: BufReader<TcpStream>,
        bearer: String,
        session_id: String,
    }

    impl TestWebSocket {
        fn connect(gateway: &TestGateway) -> Self {
            let stream = TcpStream::connect(gateway.address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            write!(
                reader.get_mut(),
                "GET /photoshop/session HTTP/1.1\r\nHost: {}\r\nOrigin: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: {}\r\n\r\n",
                gateway.address,
                PHOTOSHOP_UXP_ORIGIN,
                PHOTOSHOP_WEBSOCKET_SUBPROTOCOL,
            )
            .unwrap();
            reader.get_mut().flush().unwrap();
            let headers = read_http_headers(&mut reader);
            assert!(headers.starts_with("HTTP/1.1 101 "), "{headers}");
            write_masked_text(
                reader.get_mut(),
                &json!({
                    "type": "photoshop.session.start",
                    "hostVersion": "27.8.0",
                    "placementMimeTypes": ["image/png"],
                    "documents": [{"documentId": 7, "title": "A.psd"}]
                })
                .to_string(),
            );
            let ready: serde_json::Value =
                serde_json::from_str(&read_server_text(&mut reader)).unwrap();
            assert_eq!(ready["type"], "photoshop.session.ready");
            let projects: serde_json::Value =
                serde_json::from_str(&read_server_text(&mut reader)).unwrap();
            assert_eq!(projects["type"], "photoshop.projects.snapshot");
            Self {
                reader,
                bearer: ready["bearer"].as_str().unwrap().to_owned(),
                session_id: ready["pluginSessionId"].as_str().unwrap().to_owned(),
            }
        }
    }

    fn read_http_headers(reader: &mut BufReader<TcpStream>) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(
                bytes.len() < 16 * 1024,
                "HTTP response headers exceeded test limit"
            );
            let mut byte = [0_u8; 1];
            reader.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        String::from_utf8(bytes).unwrap()
    }

    fn write_masked_text(stream: &mut TcpStream, text: &str) {
        let payload = text.as_bytes();
        let mask = [0x12_u8, 0x34, 0x56, 0x78];
        let mut frame = vec![0x81];
        if payload.len() < 126 {
            frame.push(0x80 | u8::try_from(payload.len()).unwrap());
        } else {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&u16::try_from(payload.len()).unwrap().to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % 4]),
        );
        stream.write_all(&frame).unwrap();
        stream.flush().unwrap();
    }

    fn read_server_text(reader: &mut BufReader<TcpStream>) -> String {
        let mut header_bytes = [0_u8; 2];
        reader.read_exact(&mut header_bytes).unwrap();
        assert_eq!(header_bytes[0], 0x81);
        assert_eq!(header_bytes[1] & 0x80, 0);
        let mut length = u64::from(header_bytes[1] & 0x7f);
        if length == 126 {
            let mut bytes = [0_u8; 2];
            reader.read_exact(&mut bytes).unwrap();
            length = u64::from(u16::from_be_bytes(bytes));
        } else if length == 127 {
            let mut bytes = [0_u8; 8];
            reader.read_exact(&mut bytes).unwrap();
            length = u64::from_be_bytes(bytes);
        }
        let mut payload = vec![0_u8; usize::try_from(length).unwrap()];
        reader.read_exact(&mut payload).unwrap();
        String::from_utf8(payload).unwrap()
    }

    fn assert_session_invalid(response: reqwest::blocking::Response) {
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            PHOTOSHOP_UXP_ORIGIN
        );
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_session_invalid",
                    "message": "Photoshop session is not live."
                }
            })
        );
    }

    #[test]
    fn unknown_route_is_one_closed_json_failure_from_the_real_gateway() {
        let gateway = TestGateway::start();
        let response = client()
            .get(gateway.url("/photoshop/not-a-route"))
            .send()
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop gateway route does not exist."
                }
            })
        );
    }

    #[test]
    fn malformed_percent_encoded_route_parameter_uses_the_closed_json_failure() {
        let gateway = TestGateway::start();
        let response = client()
            .get(gateway.url("/photoshop/commands/%FF/content"))
            .send()
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop gateway path parameter is invalid."
                }
            })
        );
    }

    #[test]
    fn session_route_rejects_options_and_head_as_closed_methods() {
        let gateway = TestGateway::start();
        let client = client();
        let options = client
            .request(reqwest::Method::OPTIONS, gateway.url("/photoshop/session"))
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .send()
            .unwrap();
        assert_eq!(options.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            options.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop gateway method is not allowed."
                }
            })
        );

        let head = client
            .head(gateway.url("/photoshop/session"))
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .send()
            .unwrap();
        assert_eq!(head.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            head.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }

    #[test]
    fn command_content_exposes_only_get_and_its_exact_preflight() {
        let gateway = TestGateway::start();
        let client = client();
        let path = gateway.url("/photoshop/commands/not-a-command/content");
        let options = client
            .request(reqwest::Method::OPTIONS, &path)
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD.as_str(), "GET")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS.as_str(),
                "authorization",
            )
            .send()
            .unwrap();
        assert_eq!(options.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            options
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_METHODS)
                .unwrap(),
            "GET"
        );
        assert_eq!(
            options
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .unwrap(),
            "Authorization"
        );

        let head = client
            .head(path)
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .send()
            .unwrap();
        assert_eq!(head.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            head.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }

    #[test]
    fn export_item_exposes_only_post_and_its_exact_preflight() {
        let gateway = TestGateway::start();
        let client = client();
        let path = gateway.url("/photoshop/exports/not-a-command/items/not-an-item");
        let options = client
            .request(reqwest::Method::OPTIONS, &path)
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD.as_str(), "POST")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS.as_str(),
                "authorization, content-type",
            )
            .send()
            .unwrap();
        assert_eq!(options.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            options
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_METHODS)
                .unwrap(),
            "POST"
        );
        assert_eq!(
            options
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
                .unwrap(),
            "Authorization, Content-Type"
        );

        let get = client.get(path).send().unwrap();
        assert_eq!(get.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            get.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop gateway method is not allowed."
                }
            })
        );
    }

    #[test]
    fn byte_route_perimeter_rejections_are_indistinguishable_and_use_static_cors() {
        let gateway = TestGateway::start();
        let client = client();
        assert_session_invalid(
            client
                .get(gateway.url("/photoshop/commands/not-a-command/content"))
                .send()
                .unwrap(),
        );
        assert_session_invalid(
            client
                .post(gateway.url("/photoshop/exports/not-a-command/items/not-an-item"))
                .header(header::ORIGIN.as_str(), "https://attacker.example")
                .header(header::AUTHORIZATION.as_str(), "Bearer attacker")
                .header(header::CONTENT_TYPE.as_str(), "image/png")
                .body(vec![1_u8])
                .send()
                .unwrap(),
        );
        assert_session_invalid(
            client
                .get(gateway.url("/photoshop/commands/not-a-command/content"))
                .header(header::AUTHORIZATION.as_str(), "Bearer first")
                .header(header::AUTHORIZATION.as_str(), "Bearer second")
                .send()
                .unwrap(),
        );
    }

    #[test]
    fn websocket_wrong_subprotocol_is_one_closed_handshake_failure() {
        let gateway = TestGateway::start();
        let response = client()
            .get(gateway.url("/photoshop/session"))
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .header(header::CONNECTION.as_str(), "Upgrade")
            .header(header::UPGRADE.as_str(), "websocket")
            .header(header::SEC_WEBSOCKET_VERSION.as_str(), "13")
            .header(
                header::SEC_WEBSOCKET_KEY.as_str(),
                "dGhlIHNhbXBsZSBub25jZQ==",
            )
            .header(header::SEC_WEBSOCKET_PROTOCOL.as_str(), "not-debrute")
            .send()
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            PHOTOSHOP_UXP_ORIGIN
        );
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop WebSocket handshake is invalid."
                }
            })
        );
    }

    #[test]
    fn malformed_websocket_upgrade_is_the_same_closed_handshake_failure() {
        let gateway = TestGateway::start();
        let response = client()
            .get(gateway.url("/photoshop/session"))
            .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
            .header(header::CONNECTION.as_str(), "Upgrade")
            .header(header::UPGRADE.as_str(), "websocket")
            .header(header::SEC_WEBSOCKET_VERSION.as_str(), "12")
            .header(
                header::SEC_WEBSOCKET_KEY.as_str(),
                "dGhlIHNhbXBsZSBub25jZQ==",
            )
            .header(
                header::SEC_WEBSOCKET_PROTOCOL.as_str(),
                PHOTOSHOP_WEBSOCKET_SUBPROTOCOL,
            )
            .send()
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "photoshop_protocol_invalid",
                    "message": "Photoshop WebSocket handshake is invalid."
                }
            })
        );
    }

    #[test]
    fn preflight_must_match_the_exact_byte_route_contract() {
        let gateway = TestGateway::start();
        let client = client();
        assert_session_invalid(
            client
                .request(
                    reqwest::Method::OPTIONS,
                    gateway.url("/photoshop/commands/not-a-command/content"),
                )
                .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
                .send()
                .unwrap(),
        );
        assert_session_invalid(
            client
                .request(
                    reqwest::Method::OPTIONS,
                    gateway.url("/photoshop/commands/not-a-command/content"),
                )
                .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD.as_str(), "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS.as_str(),
                    "authorization, content-type",
                )
                .send()
                .unwrap(),
        );
        assert_session_invalid(
            client
                .request(
                    reqwest::Method::OPTIONS,
                    gateway.url("/photoshop/exports/not-a-command/items/not-an-item"),
                )
                .header(header::ORIGIN.as_str(), PHOTOSHOP_UXP_ORIGIN)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD.as_str(), "GET")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS.as_str(),
                    "authorization",
                )
                .send()
                .unwrap(),
        );
    }

    #[test]
    fn cross_session_bearer_cannot_read_another_session_command() {
        let gateway = TestGateway::start();
        let mut first = TestWebSocket::connect(&gateway);
        let second = TestWebSocket::connect(&gateway);
        let integration = Arc::clone(&gateway.integration);
        let canonical_root = gateway.canonical_root.clone();
        let first_session_id = first.session_id.clone();
        let sending = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(integration.send_project_file(
                &canonical_root,
                "source.png",
                &first_session_id,
                7,
            ))
        });
        let place_request: serde_json::Value =
            serde_json::from_str(&read_server_text(&mut first.reader)).unwrap();
        assert_eq!(place_request["type"], "photoshop.place.request");
        let command_id = place_request["commandId"].as_str().unwrap();

        assert_session_invalid(
            client()
                .get(gateway.url(&format!("/photoshop/commands/{}/content", command_id)))
                .header(
                    header::AUTHORIZATION.as_str(),
                    format!("Bearer {}", second.bearer),
                )
                .send()
                .unwrap(),
        );

        drop(first.reader);
        assert!(sending.join().unwrap().is_err());
        drop(second.reader);
    }

    #[test]
    fn cross_session_bearer_cannot_upload_to_another_session_command() {
        let gateway = TestGateway::start();
        let mut first = TestWebSocket::connect(&gateway);
        let second = TestWebSocket::connect(&gateway);
        write_masked_text(
            first.reader.get_mut(),
            &json!({
                "type": "photoshop.export.start",
                "commandId": "command-1",
                "canonicalRoot": gateway.canonical_root,
                "projectRevision": gateway.project_revision,
                "directory": "",
                "items": [{"itemId": "item-1", "sourceName": "Hero"}]
            })
            .to_string(),
        );
        let ready: serde_json::Value =
            serde_json::from_str(&read_server_text(&mut first.reader)).unwrap();
        assert_eq!(
            ready,
            json!({"type": "photoshop.export.ready", "commandId": "command-1"})
        );

        assert_session_invalid(
            client()
                .post(gateway.url("/photoshop/exports/command-1/items/item-1"))
                .header(
                    header::AUTHORIZATION.as_str(),
                    format!("Bearer {}", second.bearer),
                )
                .header(header::CONTENT_TYPE.as_str(), "image/png")
                .body(vec![1_u8])
                .send()
                .unwrap(),
        );

        drop(first.reader);
        drop(second.reader);
    }

    #[test]
    fn authorized_export_post_commits_and_returns_the_closed_success_shape() {
        let gateway = TestGateway::start();
        let mut session = TestWebSocket::connect(&gateway);
        write_masked_text(
            session.reader.get_mut(),
            &json!({
                "type": "photoshop.export.start",
                "commandId": "command-1",
                "canonicalRoot": gateway.canonical_root,
                "projectRevision": gateway.project_revision,
                "directory": "",
                "items": [{"itemId": "item-1", "sourceName": "Hero"}]
            })
            .to_string(),
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&read_server_text(&mut session.reader))
                .unwrap(),
            json!({"type": "photoshop.export.ready", "commandId": "command-1"})
        );

        let response = client()
            .post(gateway.url("/photoshop/exports/command-1/items/item-1"))
            .header(
                header::AUTHORIZATION.as_str(),
                format!("Bearer {}", session.bearer),
            )
            .header(header::CONTENT_TYPE.as_str(), "image/png")
            .body(b"png bytes".to_vec())
            .send()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            PHOTOSHOP_UXP_ORIGIN
        );
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({"fileName": "Hero.png"})
        );
        assert_eq!(
            fs::read(gateway._project.as_ref().join("Hero.png")).unwrap(),
            b"png bytes"
        );

        drop(session.reader);
    }

    #[test]
    fn authorized_export_payload_failure_uses_the_closed_error_envelope() {
        let gateway = TestGateway::start();
        let mut session = TestWebSocket::connect(&gateway);
        write_masked_text(
            session.reader.get_mut(),
            &json!({
                "type": "photoshop.export.start",
                "commandId": "command-1",
                "canonicalRoot": gateway.canonical_root,
                "projectRevision": gateway.project_revision,
                "directory": "",
                "items": [{"itemId": "item-1", "sourceName": "Hero"}]
            })
            .to_string(),
        );
        let _ready = read_server_text(&mut session.reader);

        let response = client()
            .post(gateway.url("/photoshop/exports/command-1/items/item-1"))
            .header(
                header::AUTHORIZATION.as_str(),
                format!("Bearer {}", session.bearer),
            )
            .header(header::CONTENT_TYPE.as_str(), "application/octet-stream")
            .body(vec![1_u8])
            .send()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(
            response.json::<serde_json::Value>().unwrap(),
            json!({
                "error": {
                    "code": "invalid_transfer_payload",
                    "message": "Photoshop export item must be image/png."
                }
            })
        );

        drop(session.reader);
    }

    #[test]
    fn websocket_disconnect_revokes_its_bearer_at_the_real_http_boundary() {
        let gateway = TestGateway::start();
        let mut session = TestWebSocket::connect(&gateway);
        let integration = Arc::clone(&gateway.integration);
        let canonical_root = gateway.canonical_root.clone();
        let session_id = session.session_id.clone();
        let sending = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(integration.send_project_file(
                &canonical_root,
                "source.png",
                &session_id,
                7,
            ))
        });
        let place_request: serde_json::Value =
            serde_json::from_str(&read_server_text(&mut session.reader)).unwrap();
        let command_id = place_request["commandId"].as_str().unwrap();
        let url = gateway.url(&format!("/photoshop/commands/{command_id}/content"));
        let authorization = format!("Bearer {}", session.bearer);
        let live = client()
            .get(&url)
            .header(header::AUTHORIZATION.as_str(), &authorization)
            .send()
            .unwrap();
        assert_eq!(live.status(), StatusCode::OK);
        assert_eq!(live.bytes().unwrap().as_ref(), b"project source");

        drop(session.reader);
        assert!(sending.join().unwrap().is_err());
        assert_session_invalid(
            client()
                .get(url)
                .header(header::AUTHORIZATION.as_str(), authorization)
                .send()
                .unwrap(),
        );
    }

    #[test]
    fn duplicate_host_and_origin_headers_are_closed_perimeter_failures() {
        let gateway = TestGateway::start();
        let duplicate_host = format!(
            "GET /photoshop/commands/not-a-command/content HTTP/1.1\r\nHost: {}\r\nHost: {}\r\nConnection: close\r\n\r\n",
            gateway.address, gateway.address
        );
        let response = raw_http(&gateway, &duplicate_host);
        assert!(response.starts_with("HTTP/1.1 403 "), "{response}");
        assert!(response.contains("access-control-allow-origin: file://"));
        assert!(response.contains("\"code\":\"photoshop_session_invalid\""));

        let duplicate_origin = format!(
            "GET /photoshop/commands/not-a-command/content HTTP/1.1\r\nHost: {}\r\nOrigin: file://\r\nOrigin: file://\r\nConnection: close\r\n\r\n",
            gateway.address
        );
        let response = raw_http(&gateway, &duplicate_origin);
        assert!(response.starts_with("HTTP/1.1 403 "), "{response}");
        assert!(response.contains("\"code\":\"photoshop_session_invalid\""));
    }

    fn raw_http(gateway: &TestGateway, request: &str) -> String {
        let mut stream = TcpStream::connect(gateway.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        stream.flush().unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

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
