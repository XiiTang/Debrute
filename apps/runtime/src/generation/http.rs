//! Bounded model HTTP and DNS-pinned public-media retrieval.

use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr, ToSocketAddrs as _},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use reqwest::{
    Client,
    header::{HeaderMap, HeaderName, HeaderValue},
    multipart,
    redirect::Policy,
};

use super::types::{
    GenerationCancellation, GenerationDeadline, GenerationError, HttpMethod, HttpTargetPolicy,
    ModelHttpRequest, ModelHttpResponse, ModelHttpTransport, PreparedHttpBody,
};

const MAX_PUBLIC_REDIRECTS: usize = 5;
const MULTIPART_FIELD_OVERHEAD_BYTES: usize = 512;
const MULTIPART_FILE_OVERHEAD_BYTES: usize = 1024;
const MULTIPART_CLOSING_OVERHEAD_BYTES: usize = 128;
const MAX_ACTIVE_DNS_RESOLUTIONS: usize = 8;
const CANCEL_POLL: Duration = Duration::from_millis(50);
static ACTIVE_DNS_RESOLUTIONS: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
pub(crate) struct NativeModelHttpTransport;

impl ModelHttpTransport for NativeModelHttpTransport {
    fn execute(
        &self,
        request: ModelHttpRequest,
        cancellation: &GenerationCancellation,
        deadline: GenerationDeadline,
    ) -> Result<ModelHttpResponse, GenerationError> {
        deadline.remaining(cancellation)?;
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| {
                            GenerationError::new("model_request_failed", error.to_string())
                        })?
                        .block_on(async {
                            match request.target_policy {
                                HttpTargetPolicy::ModelEndpoint => {
                                    execute_model_endpoint(request, cancellation, deadline).await
                                }
                                HttpTargetPolicy::PublicMedia => {
                                    execute_public(request, cancellation, deadline).await
                                }
                            }
                        })
                })
                .join()
                .expect("Generation HTTP worker panicked")
        })
    }
}

async fn execute_model_endpoint(
    request: ModelHttpRequest,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<ModelHttpResponse, GenerationError> {
    let url = parse_model_url(&request.url)?;
    let addresses = resolve_url_addresses(&url, cancellation, deadline, false)?;
    execute_once(request, url, &addresses, false, cancellation, deadline).await
}

async fn execute_public(
    mut request: ModelHttpRequest,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<ModelHttpResponse, GenerationError> {
    for redirect in 0..=MAX_PUBLIC_REDIRECTS {
        deadline.remaining(cancellation)?;
        let url = parse_public_url(&request.url)?;
        let addresses = resolve_url_addresses(&url, cancellation, deadline, true)?;
        request.url = url.to_string();
        let response = execute_once(
            request.clone(),
            url.clone(),
            &addresses,
            true,
            cancellation,
            deadline,
        )
        .await?;
        if !(300..400).contains(&response.status) {
            return Ok(response);
        }
        if redirect == MAX_PUBLIC_REDIRECTS {
            return Err(GenerationError::new(
                "remote_media_redirect_limit",
                "Remote media exceeded the redirect limit.",
            ));
        }
        let location = response.headers.get("location").ok_or_else(|| {
            GenerationError::new(
                "remote_media_redirect_invalid",
                "Remote media redirect omitted Location.",
            )
        })?;
        request.url = url
            .join(location)
            .map_err(|error| {
                GenerationError::new("remote_media_redirect_invalid", error.to_string())
            })?
            .to_string();
        request.method = HttpMethod::Get;
        request.body = PreparedHttpBody::Empty;
        request.headers.remove("authorization");
        request.headers.remove("x-api-key");
    }
    Err(GenerationError::new(
        "remote_media_redirect_limit",
        "Remote media exceeded the redirect limit.",
    ))
}

async fn execute_once(
    request: ModelHttpRequest,
    url: url::Url,
    pinned_addresses: &[SocketAddr],
    disable_proxy: bool,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<ModelHttpResponse, GenerationError> {
    validate_request_size(&request.body, super::common::MAX_MODEL_REQUEST_BYTES)?;
    let request_timeout = deadline.remaining(cancellation)?;
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .timeout(request_timeout)
        .connect_timeout(request_timeout.min(Duration::from_secs(30)));
    if disable_proxy {
        builder = builder.no_proxy();
    }
    if let Some(host) = url.host_str() {
        builder = builder.resolve_to_addrs(host, pinned_addresses);
    }
    let client = builder
        .build()
        .map_err(|error| GenerationError::new("model_request_failed", error.to_string()))?;
    let method = match request.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
    };
    let request_headers = outbound_headers(&request)?;
    let outbound = client.request(method, url).headers(request_headers);
    let outbound = attach_body(outbound, request.body)?;
    let mut response = cancellable(outbound.send(), cancellation, deadline)
        .await?
        .map_err(|error| map_request_error(request_timeout, &error))?;
    deadline.remaining(cancellation)?;
    if response
        .content_length()
        .is_some_and(|length| length > request.maximum_response_bytes as u64)
    {
        return Err(GenerationError::new(
            "model_response_too_large",
            format!(
                "Model response exceeds {} bytes.",
                request.maximum_response_bytes
            ),
        ));
    }
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
        })
        .collect();
    let mut body = Vec::new();
    loop {
        let chunk = cancellable(response.chunk(), cancellation, deadline)
            .await?
            .map_err(|error| GenerationError::new("model_response_failed", error.to_string()))?;
        let Some(chunk) = chunk else {
            break;
        };
        if body.len().saturating_add(chunk.len()) > request.maximum_response_bytes {
            return Err(GenerationError::new(
                "model_response_too_large",
                format!(
                    "Model response exceeds {} bytes.",
                    request.maximum_response_bytes
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(ModelHttpResponse {
        status,
        headers,
        body,
    })
}

fn outbound_headers(request: &ModelHttpRequest) -> Result<HeaderMap, GenerationError> {
    let mut headers = header_map(&request.headers)?;
    if matches!(&request.body, PreparedHttpBody::Json(_))
        && !headers.contains_key(reqwest::header::CONTENT_TYPE)
    {
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
    }
    Ok(headers)
}

fn attach_body(
    outbound: reqwest::RequestBuilder,
    body: PreparedHttpBody,
) -> Result<reqwest::RequestBuilder, GenerationError> {
    Ok(match body {
        PreparedHttpBody::Empty => outbound,
        PreparedHttpBody::Json(body) => outbound.body(body.into_serialized()),
        PreparedHttpBody::Multipart { fields, files } => {
            let mut form = multipart::Form::new();
            for (name, value) in fields {
                form = form.text(name, value);
            }
            for file in files {
                let part = multipart::Part::bytes(file.bytes)
                    .file_name(file.filename)
                    .mime_str(&file.content_type)
                    .map_err(|error| {
                        GenerationError::new("model_request_invalid", error.to_string())
                    })?;
                form = form.part(file.name, part);
            }
            outbound.multipart(form)
        }
    })
}

async fn cancellable<T, F>(
    future: F,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<T, GenerationError>
where
    F: std::future::Future<Output = T>,
{
    tokio::pin!(future);
    loop {
        let remaining = deadline.remaining(cancellation)?;
        tokio::select! {
            result = &mut future => return Ok(result),
            () = tokio::time::sleep(remaining.min(CANCEL_POLL)) => {}
        }
    }
}

fn parse_model_url(url: &str) -> Result<url::Url, GenerationError> {
    let url = url::Url::parse(url)
        .map_err(|error| GenerationError::new("model_request_invalid", error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(GenerationError::new(
            "model_request_invalid",
            "Model request URL must be absolute HTTP(S).",
        ));
    }
    Ok(url)
}

pub(crate) fn parse_public_url(url: &str) -> Result<url::Url, GenerationError> {
    let url = url::Url::parse(url)
        .map_err(|error| GenerationError::new("remote_media_url_invalid", error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(GenerationError::new(
            "remote_media_url_invalid",
            "Remote media URL must be credential-free HTTP(S).",
        ));
    }
    url.host_str().ok_or_else(|| {
        GenerationError::new("remote_media_url_invalid", "Remote media URL has no host.")
    })?;
    url.port_or_known_default().ok_or_else(|| {
        GenerationError::new("remote_media_url_invalid", "Remote media URL has no port.")
    })?;
    Ok(url)
}

pub(crate) fn validate_public_url(
    value: &str,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<url::Url, GenerationError> {
    let url = parse_public_url(value)?;
    resolve_url_addresses(&url, cancellation, deadline, true)?;
    Ok(url)
}

fn resolve_url_addresses(
    url: &url::Url,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
    require_public: bool,
) -> Result<Vec<SocketAddr>, GenerationError> {
    let host = url.host_str().ok_or_else(|| {
        GenerationError::new("remote_media_url_invalid", "Remote media URL has no host.")
    })?;
    let port = url.port_or_known_default().ok_or_else(|| {
        GenerationError::new("remote_media_url_invalid", "Remote media URL has no port.")
    })?;
    let addresses = bounded_resolve(host, port, cancellation, deadline)?;
    if require_public
        && (addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())))
    {
        return Err(GenerationError::new(
            "remote_media_host_blocked",
            "Remote media host did not resolve exclusively to public addresses.",
        ));
    }
    Ok(addresses)
}

fn bounded_resolve(
    host: &str,
    port: u16,
    cancellation: &GenerationCancellation,
    deadline: GenerationDeadline,
) -> Result<Vec<SocketAddr>, GenerationError> {
    deadline.remaining(cancellation)?;
    let slot = DnsSlot::acquire()?;
    let host = host.to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("debrute-generation-dns".to_owned())
        .spawn(move || {
            let _slot = slot;
            let result = match (host.as_str(), port).to_socket_addrs() {
                Ok(addresses) => Ok(addresses.collect::<Vec<_>>()),
                Err(error) => Err(error),
            };
            let _ = sender.send(result);
        })
        .map_err(|error| GenerationError::new("remote_media_dns_failed", error.to_string()))?;
    loop {
        let remaining = deadline.remaining(cancellation)?;
        match receiver.recv_timeout(remaining.min(CANCEL_POLL)) {
            Ok(Ok(addresses)) if !addresses.is_empty() => return Ok(addresses),
            Ok(Ok(_)) => {
                return Err(GenerationError::new(
                    "remote_media_dns_failed",
                    "Remote host did not resolve to any address.",
                ));
            }
            Ok(Err(error)) => {
                return Err(GenerationError::new(
                    "remote_media_dns_failed",
                    error.to_string(),
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(GenerationError::new(
                    "remote_media_dns_failed",
                    "Remote DNS worker stopped without a result.",
                ));
            }
        }
    }
}

struct DnsSlot;

impl DnsSlot {
    fn acquire() -> Result<Self, GenerationError> {
        ACTIVE_DNS_RESOLUTIONS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_ACTIVE_DNS_RESOLUTIONS).then_some(active + 1)
            })
            .map(|_| Self)
            .map_err(|_| {
                GenerationError::new(
                    "remote_media_dns_busy",
                    "Runtime DNS resolution capacity is exhausted.",
                )
            })
    }
}

impl Drop for DnsSlot {
    fn drop(&mut self) {
        ACTIVE_DNS_RESOLUTIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && matches!(b, 18 | 19)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || (segments[0] & 0xffc0) == 0xfec0
                || segments[0] == 0x0064 && segments[1] == 0xff9b
                || (segments[0] == 0x0100 && segments[1] == 0)
                || (segments[0] == 0x2001 && segments[1] == 0x0002)
                || (segments[0] == 0x2001 && (0x0010..=0x001f).contains(&segments[1]))
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| !is_public_ip(IpAddr::V4(mapped))))
        }
    }
}

pub(crate) fn validate_request_size(
    body: &PreparedHttpBody,
    maximum_bytes: usize,
) -> Result<(), GenerationError> {
    let bytes = match body {
        PreparedHttpBody::Empty => 0,
        PreparedHttpBody::Json(body) => body.serialized().len(),
        PreparedHttpBody::Multipart { fields, files } => fields
            .iter()
            .map(|(key, value)| {
                MULTIPART_FIELD_OVERHEAD_BYTES
                    .saturating_add(multipart_quoted_header_upper_bound(key))
                    .saturating_add(value.len())
            })
            .chain(files.iter().map(|file| {
                MULTIPART_FILE_OVERHEAD_BYTES
                    .saturating_add(multipart_quoted_header_upper_bound(&file.name))
                    .saturating_add(multipart_quoted_header_upper_bound(&file.filename))
                    .saturating_add(file.content_type.len())
                    .saturating_add(file.bytes.len())
            }))
            .fold(MULTIPART_CLOSING_OVERHEAD_BYTES, usize::saturating_add),
    };
    if bytes > maximum_bytes {
        Err(GenerationError::new(
            "model_request_too_large",
            format!("Model request exceeds {maximum_bytes} bytes."),
        ))
    } else {
        Ok(())
    }
}

fn multipart_quoted_header_upper_bound(value: &str) -> usize {
    value.len().saturating_mul(3)
}

fn header_map(headers: &BTreeMap<String, String>) -> Result<HeaderMap, GenerationError> {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| GenerationError::new("model_request_invalid", error.to_string()))?;
        let value = HeaderValue::from_str(value)
            .map_err(|error| GenerationError::new("model_request_invalid", error.to_string()))?;
        result.insert(name, value);
    }
    Ok(result)
}

fn map_request_error(request_timeout: Duration, error: &reqwest::Error) -> GenerationError {
    if error.is_timeout() {
        GenerationError::new(
            "generation_timeout",
            format!(
                "Generation request exceeded its {}ms timeout.",
                request_timeout.as_millis()
            ),
        )
    } else {
        GenerationError::new("model_request_failed", error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_media_rejects_loopback_and_private_ranges() {
        for ip in [
            "127.0.0.1".parse().unwrap(),
            "10.0.0.1".parse().unwrap(),
            "169.254.1.1".parse().unwrap(),
            "::1".parse().unwrap(),
            "fc00::1".parse().unwrap(),
            "198.18.0.1".parse().unwrap(),
            "2001:db8::1".parse().unwrap(),
            "64:ff9b::1".parse().unwrap(),
            "fec0::1".parse().unwrap(),
        ] {
            assert!(!is_public_ip(ip));
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn request_bodies_are_bounded_before_network_access() {
        let body = PreparedHttpBody::Multipart {
            fields: BTreeMap::new(),
            files: vec![crate::generation::types::MultipartFile {
                name: "image".to_owned(),
                filename: "large.png".to_owned(),
                content_type: "image/png".to_owned(),
                bytes: vec![0_u8; 4],
            }],
        };
        assert_eq!(
            validate_request_size(&body, 3).unwrap_err().code(),
            "model_request_too_large"
        );
    }

    #[test]
    fn stalled_http_is_interrupted_by_cancellation() {
        use std::io::Read as _;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0_u8; 1024];
            while stream.read(&mut buffer).is_ok_and(|read| read > 0) {}
        });
        let cancellation = GenerationCancellation::default();
        let cancel = cancellation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel.cancel();
        });
        let started = std::time::Instant::now();
        let error = NativeModelHttpTransport
            .execute(
                ModelHttpRequest {
                    method: HttpMethod::Get,
                    url: format!("http://{address}/stalled"),
                    headers: BTreeMap::new(),
                    body: PreparedHttpBody::Empty,
                    maximum_response_bytes: 1024,
                    target_policy: HttpTargetPolicy::ModelEndpoint,
                },
                &cancellation,
                GenerationDeadline::after(Duration::from_secs(5)).unwrap(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "generation_cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
        server.join().unwrap();
    }
}
