use std::{
    io::{Read as _, Write as _},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use super::{
    PHOTOSHOP_CEP_FILE_ORIGIN, PHOTOSHOP_DISCOVERY_PORT, PHOTOSHOP_UXP_ORIGIN,
    PhotoshopDiscoveryPayload, PhotoshopDiscoveryStatus,
};

const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const DISCOVERY_PATH: &str = "/adobe-bridge/discovery";

pub struct PhotoshopDiscoveryServer {
    available: Arc<AtomicBool>,
    address: Option<SocketAddr>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl PhotoshopDiscoveryServer {
    #[must_use]
    pub fn start(snapshot: Arc<dyn Fn() -> PhotoshopDiscoveryPayload + Send + Sync>) -> Self {
        Self::start_on(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), PHOTOSHOP_DISCOVERY_PORT),
            snapshot,
        )
    }

    #[must_use]
    fn start_on(
        requested: SocketAddr,
        snapshot: Arc<dyn Fn() -> PhotoshopDiscoveryPayload + Send + Sync>,
    ) -> Self {
        if requested.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) {
            return Self::unavailable();
        }
        let Ok(listener) = TcpListener::bind(requested) else {
            return Self::unavailable();
        };
        let Ok(address) = listener.local_addr() else {
            return Self::unavailable();
        };
        if listener.set_nonblocking(true).is_err() {
            return Self::unavailable();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let available = Arc::new(AtomicBool::new(true));
        let thread_stop = Arc::clone(&stop);
        let thread_available = Arc::clone(&available);
        let thread = thread::Builder::new()
            .name("debrute-photoshop-discovery".to_owned())
            .spawn(move || {
                while !thread_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, peer)) => handle_connection(stream, peer, address, &snapshot),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => {
                            thread_available.store(false, Ordering::Release);
                            break;
                        }
                    }
                }
            })
            .ok();
        if thread.is_none() {
            return Self::unavailable();
        }
        Self {
            available,
            address: Some(address),
            stop,
            thread,
        }
    }

    fn unavailable() -> Self {
        Self {
            available: Arc::new(AtomicBool::new(false)),
            address: None,
            stop: Arc::new(AtomicBool::new(true)),
            thread: None,
        }
    }

    #[must_use]
    pub fn status(&self) -> PhotoshopDiscoveryStatus {
        if self.available.load(Ordering::Acquire) {
            PhotoshopDiscoveryStatus::Available
        } else {
            PhotoshopDiscoveryStatus::Unavailable
        }
    }

    #[must_use]
    pub fn address(&self) -> Option<SocketAddr> {
        self.address
    }
}

impl Drop for PhotoshopDiscoveryServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.available.store(false, Ordering::Release);
    }
}

fn handle_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    listener: SocketAddr,
    snapshot: &Arc<dyn Fn() -> PhotoshopDiscoveryPayload + Send + Sync>,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    if !peer.ip().is_loopback() {
        let _ = write_response(&mut stream, 403, "Forbidden", None, b"");
        return;
    }
    let Some(request) = read_request_head(&mut stream) else {
        let _ = write_response(&mut stream, 400, "Bad Request", None, b"");
        return;
    };
    let expected_host = format!("{}:{}", listener.ip(), listener.port());
    if request.host.as_deref() != Some(expected_host.as_str()) {
        let _ = write_response(&mut stream, 421, "Misdirected Request", None, b"");
        return;
    }
    let Some(origin) = request
        .origin
        .as_deref()
        .filter(|origin| allowed_origin(origin))
    else {
        let _ = write_response(&mut stream, 403, "Forbidden", None, b"");
        return;
    };
    if request.method != "GET" || request.target != DISCOVERY_PATH {
        let _ = write_response(&mut stream, 404, "Not Found", Some(origin), b"");
        return;
    }
    let Ok(body) = serde_json::to_vec(&snapshot()) else {
        let _ = write_response(&mut stream, 500, "Internal Server Error", Some(origin), b"");
        return;
    };
    let _ = write_response(&mut stream, 200, "OK", Some(origin), &body);
}

struct RequestHead {
    method: String,
    target: String,
    host: Option<String>,
    origin: Option<String>,
}

fn read_request_head(stream: &mut TcpStream) -> Option<RequestHead> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while bytes.len() < MAX_REQUEST_HEAD_BYTES {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if bytes.len() >= MAX_REQUEST_HEAD_BYTES {
        return None;
    }
    let head = std::str::from_utf8(&bytes).ok()?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let target = request_line.next()?.to_owned();
    if request_line.next()? != "HTTP/1.1" || request_line.next().is_some() {
        return None;
    }
    let mut host = None;
    let mut origin = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value.to_owned()).is_some() {
                return None;
            }
        } else if name.eq_ignore_ascii_case("origin") && origin.replace(value.to_owned()).is_some()
        {
            return None;
        }
    }
    Some(RequestHead {
        method,
        target,
        host,
        origin,
    })
}

fn allowed_origin(origin: &str) -> bool {
    matches!(origin, PHOTOSHOP_UXP_ORIGIN | PHOTOSHOP_CEP_FILE_ORIGIN)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    origin: Option<&str>,
    body: &[u8],
) -> std::io::Result<()> {
    let cors = origin.map_or_else(String::new, |origin| {
        format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n")
    });
    let content_type = if body.is_empty() {
        String::new()
    } else {
        "Content-Type: application/json\r\n".to_owned()
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\n{cors}{content_type}Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    stream.shutdown(std::net::Shutdown::Write)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PhotoshopDiscoveryPayload {
        PhotoshopDiscoveryPayload {
            product: "debrute",
            product_version: "1.2.3".to_owned(),
            bridge_version: 1,
            runtime_instance_id: "runtime-1".to_owned(),
            enabled: true,
            workbench_origin: "http://127.0.0.1:4444".to_owned(),
            api_base_url: "http://127.0.0.1:4444/api/adobe-bridge".to_owned(),
            ws_url: "ws://127.0.0.1:4444/api/adobe-bridge/plugin/ws".to_owned(),
        }
    }

    fn request(address: SocketAddr, path: &str, host: &str, origin: Option<&str>) -> String {
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {host}\r\n{}Connection: close\r\n\r\n",
            origin.map_or_else(String::new, |value| format!("Origin: {value}\r\n"))
        )
        .unwrap();
        let mut response = String::new();
        match stream.read_to_string(&mut response) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            Err(error) => panic!("discovery response failed: {error}"),
        }
        response
    }

    #[test]
    fn discovery_enforces_exact_loopback_host_origin_and_path_without_credentials() {
        let server =
            PhotoshopDiscoveryServer::start_on("127.0.0.1:0".parse().unwrap(), Arc::new(payload));
        let address = server.address().unwrap();
        let host = address.to_string();
        let ok = request(address, DISCOVERY_PATH, &host, Some(PHOTOSHOP_UXP_ORIGIN));
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(ok.contains(&format!(
            "Access-Control-Allow-Origin: {PHOTOSHOP_UXP_ORIGIN}"
        )));
        assert!(ok.contains("Cache-Control: no-store"));
        assert!(!ok.to_ascii_lowercase().contains("allow-credentials"));
        assert!(ok.contains("\"runtimeInstanceId\":\"runtime-1\""));

        assert!(request(address, DISCOVERY_PATH, &host, None).starts_with("HTTP/1.1 403"));
        assert!(request(address, DISCOVERY_PATH, &host, Some("null")).starts_with("HTTP/1.1 403"));
        assert!(
            request(address, DISCOVERY_PATH, "localhost:1", Some("null"))
                .starts_with("HTTP/1.1 421")
        );
        assert!(
            request(
                address,
                "/adobe-bridge/discovery?x=1",
                &host,
                Some("file://")
            )
            .starts_with("HTTP/1.1 404")
        );
        assert!(
            request(address, DISCOVERY_PATH, &host, Some("https://evil.example"))
                .starts_with("HTTP/1.1 403")
        );
    }
}
