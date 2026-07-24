use std::{collections::HashMap, path::PathBuf};

use axum::{body::Bytes, extract::Request, http::header};
use futures_util::{Stream, StreamExt};
use tokio::{fs::File, io::AsyncWriteExt as _};
use uuid::Uuid;

use super::RuntimeHttpServiceError;

const MAX_MULTIPART_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_MULTIPART_PARTS: usize = 10_000;
const MAX_MULTIPART_FIELDS_BYTES: usize = 64 * 1024;
const MAX_MULTIPART_HEADERS_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub(super) struct MultipartFile {
    pub temporary_path: PathBuf,
}

#[derive(Debug)]
pub(super) struct MultipartParts {
    pub fields: HashMap<String, String>,
    pub files: HashMap<String, MultipartFile>,
    directory: PathBuf,
}

#[derive(Debug)]
pub(super) struct TemporaryBody {
    pub path: PathBuf,
    pub byte_length: u64,
    directory: PathBuf,
}

impl Drop for TemporaryBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Drop for MultipartParts {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

pub(super) async fn read_multipart(
    request: Request,
) -> Result<MultipartParts, RuntimeHttpServiceError> {
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > MAX_MULTIPART_BYTES)
    {
        return Err(too_large());
    }
    let boundary = multipart_boundary(request.headers())?;
    let directory = std::env::temp_dir().join(format!("debrute-upload-{}", Uuid::new_v4()));
    tokio::fs::create_dir(&directory)
        .await
        .map_err(|error| multipart_error(error.to_string()))?;
    let result = parse_body(request, &boundary, directory.clone()).await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }
    result
}

pub(super) async fn read_temporary_body(
    request: Request,
    maximum: u64,
) -> Result<TemporaryBody, RuntimeHttpServiceError> {
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > maximum)
    {
        return Err(too_large());
    }
    let directory = std::env::temp_dir().join(format!("debrute-body-{}", Uuid::new_v4()));
    tokio::fs::create_dir(&directory)
        .await
        .map_err(|error| multipart_error(error.to_string()))?;
    let path = directory.join("body.upload");
    let result = async {
        let mut file = File::create_new(&path)
            .await
            .map_err(|error| multipart_error(error.to_string()))?;
        let mut stream = request.into_body().into_data_stream();
        let mut byte_length = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| multipart_error(error.to_string()))?;
            byte_length = byte_length
                .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                .ok_or_else(too_large)?;
            if byte_length > maximum {
                return Err(too_large());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| multipart_error(error.to_string()))?;
        }
        file.flush()
            .await
            .map_err(|error| multipart_error(error.to_string()))?;
        file.sync_all()
            .await
            .map_err(|error| multipart_error(error.to_string()))?;
        Ok(TemporaryBody {
            path,
            byte_length,
            directory: directory.clone(),
        })
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }
    result
}

async fn parse_body(
    request: Request,
    boundary: &[u8],
    directory: PathBuf,
) -> Result<MultipartParts, RuntimeHttpServiceError> {
    let mut reader = MultipartReader::new(request.into_body().into_data_stream());
    let initial = [b"--".as_slice(), boundary, b"\r\n"].concat();
    reader.require_prefix(&initial).await?;
    let marker = [b"\r\n--".as_slice(), boundary].concat();
    let mut fields = HashMap::new();
    let mut files = HashMap::new();
    let mut fields_bytes = 0usize;
    for part_index in 0..MAX_MULTIPART_PARTS {
        let headers = reader
            .take_until(b"\r\n\r\n", MAX_MULTIPART_HEADERS_BYTES)
            .await?;
        let disposition = content_disposition(&headers)?;
        let (name, is_file) = disposition_name(disposition)?;
        if fields.contains_key(&name) || files.contains_key(&name) {
            return Err(invalid_input(format!("Duplicate multipart field: {name}")));
        }
        if is_file {
            let temporary_path = directory.join(format!("{part_index}.upload"));
            let mut file = File::create_new(&temporary_path)
                .await
                .map_err(|error| multipart_error(error.to_string()))?;
            reader.copy_until(&marker, &mut file).await?;
            file.flush()
                .await
                .map_err(|error| multipart_error(error.to_string()))?;
            file.sync_all()
                .await
                .map_err(|error| multipart_error(error.to_string()))?;
            files.insert(name, MultipartFile { temporary_path });
        } else {
            let remaining = MAX_MULTIPART_FIELDS_BYTES.saturating_sub(fields_bytes);
            let value = reader.take_part(&marker, remaining).await?;
            fields_bytes = fields_bytes
                .checked_add(value.len())
                .ok_or_else(too_large)?;
            let value = String::from_utf8(value)
                .map_err(|_| invalid_input("Multipart field is not valid UTF-8."))?;
            fields.insert(name, value);
        }
        reader.require_prefix(&marker).await?;
        let suffix = reader.take_exact(2).await?;
        if suffix == b"--" {
            reader.consume_optional_crlf().await?;
            return Ok(MultipartParts {
                fields,
                files,
                directory,
            });
        }
        if suffix != b"\r\n" {
            return Err(invalid_input("Multipart boundary terminator is invalid."));
        }
    }
    Err(too_large())
}

struct MultipartReader<S> {
    stream: S,
    buffer: Vec<u8>,
    received: u64,
    ended: bool,
}

impl<S, E> MultipartReader<S>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    fn new(stream: S) -> Self {
        Self {
            stream,
            buffer: Vec::new(),
            received: 0,
            ended: false,
        }
    }

    async fn fill(&mut self) -> Result<bool, RuntimeHttpServiceError> {
        if self.ended {
            return Ok(false);
        }
        match self.stream.next().await {
            Some(Ok(chunk)) => {
                self.received = self
                    .received
                    .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                    .ok_or_else(too_large)?;
                if self.received > MAX_MULTIPART_BYTES {
                    return Err(too_large());
                }
                self.buffer.extend_from_slice(&chunk);
                Ok(true)
            }
            Some(Err(error)) => Err(multipart_error(error.to_string())),
            None => {
                self.ended = true;
                Ok(false)
            }
        }
    }

    async fn require_prefix(&mut self, prefix: &[u8]) -> Result<(), RuntimeHttpServiceError> {
        while self.buffer.len() < prefix.len() && self.fill().await? {}
        if !self.buffer.starts_with(prefix) {
            return Err(invalid_input("Multipart boundary is missing or malformed."));
        }
        self.buffer.drain(..prefix.len());
        Ok(())
    }

    async fn take_exact(&mut self, length: usize) -> Result<Vec<u8>, RuntimeHttpServiceError> {
        while self.buffer.len() < length && self.fill().await? {}
        if self.buffer.len() < length {
            return Err(invalid_input("Multipart request ended unexpectedly."));
        }
        Ok(self.buffer.drain(..length).collect())
    }

    async fn take_until(
        &mut self,
        needle: &[u8],
        limit: usize,
    ) -> Result<Vec<u8>, RuntimeHttpServiceError> {
        loop {
            if let Some(index) = find_bytes(&self.buffer, needle) {
                if index > limit {
                    return Err(too_large());
                }
                let value = self.buffer.drain(..index).collect();
                self.buffer.drain(..needle.len());
                return Ok(value);
            }
            if self.buffer.len() > limit.saturating_add(needle.len()) {
                return Err(too_large());
            }
            if !self.fill().await? {
                return Err(invalid_input("Multipart request ended unexpectedly."));
            }
        }
    }

    async fn take_part(
        &mut self,
        marker: &[u8],
        limit: usize,
    ) -> Result<Vec<u8>, RuntimeHttpServiceError> {
        loop {
            if let Some(index) = find_bytes(&self.buffer, marker) {
                if index > limit {
                    return Err(too_large());
                }
                return Ok(self.buffer.drain(..index).collect());
            }
            if self.buffer.len() > limit.saturating_add(marker.len()) {
                return Err(too_large());
            }
            if !self.fill().await? {
                return Err(invalid_input("Multipart request ended unexpectedly."));
            }
        }
    }

    async fn copy_until(
        &mut self,
        marker: &[u8],
        output: &mut File,
    ) -> Result<u64, RuntimeHttpServiceError> {
        let mut written = 0u64;
        loop {
            if let Some(index) = find_bytes(&self.buffer, marker) {
                output
                    .write_all(&self.buffer[..index])
                    .await
                    .map_err(|error| multipart_error(error.to_string()))?;
                written = written
                    .checked_add(u64::try_from(index).unwrap_or(u64::MAX))
                    .ok_or_else(too_large)?;
                self.buffer.drain(..index);
                return Ok(written);
            }
            let retain = marker.len().saturating_sub(1);
            if self.buffer.len() > retain {
                let flush = self.buffer.len() - retain;
                output
                    .write_all(&self.buffer[..flush])
                    .await
                    .map_err(|error| multipart_error(error.to_string()))?;
                written = written
                    .checked_add(u64::try_from(flush).unwrap_or(u64::MAX))
                    .ok_or_else(too_large)?;
                self.buffer.drain(..flush);
            }
            if !self.fill().await? {
                return Err(invalid_input("Multipart request ended unexpectedly."));
            }
        }
    }

    async fn consume_optional_crlf(&mut self) -> Result<(), RuntimeHttpServiceError> {
        while self.buffer.len() < 2 && !self.ended {
            if !self.fill().await? {
                break;
            }
        }
        if self.buffer.starts_with(b"\r\n") {
            self.buffer.drain(..2);
        }
        Ok(())
    }
}

fn multipart_boundary(headers: &axum::http::HeaderMap) -> Result<Vec<u8>, RuntimeHttpServiceError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| invalid_input("Multipart Content-Type is required."))?;
    let mut segments = content_type.split(';').map(str::trim);
    if segments.next() != Some("multipart/form-data") {
        return Err(invalid_input("Content-Type must be multipart/form-data."));
    }
    let boundary = segments.find_map(|segment| segment.strip_prefix("boundary="));
    let boundary = boundary
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty() && value.len() <= 70)
        .ok_or_else(|| invalid_input("Multipart boundary is invalid."))?;
    if !boundary
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'"' | b'\\'))
    {
        return Err(invalid_input("Multipart boundary is invalid."));
    }
    Ok(boundary.as_bytes().to_vec())
}

fn content_disposition(headers: &[u8]) -> Result<&str, RuntimeHttpServiceError> {
    let headers = std::str::from_utf8(headers)
        .map_err(|_| invalid_input("Multipart headers are not valid UTF-8."))?;
    headers
        .split("\r\n")
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-disposition")
                .then(|| value.trim())
        })
        .ok_or_else(|| invalid_input("Multipart Content-Disposition is required."))
}

fn disposition_name(value: &str) -> Result<(String, bool), RuntimeHttpServiceError> {
    let mut segments = value.split(';').map(str::trim);
    if segments.next() != Some("form-data") {
        return Err(invalid_input("Multipart disposition must be form-data."));
    }
    let mut name = None;
    let mut is_file = false;
    for segment in segments {
        if let Some(value) = quoted_parameter(segment, "name") {
            name = Some(value.to_owned());
        } else if quoted_parameter(segment, "filename").is_some() {
            is_file = true;
        }
    }
    let name = name
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| invalid_input("Multipart field name is invalid."))?;
    Ok((name, is_file))
}

fn quoted_parameter<'a>(segment: &'a str, name: &str) -> Option<&'a str> {
    let value = segment.strip_prefix(name)?.strip_prefix('=')?;
    value.strip_prefix('"')?.strip_suffix('"')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn invalid_input(message: impl Into<String>) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(400, "invalid_input", message)
}

fn too_large() -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(
        413,
        "request_body_too_large",
        "Multipart request exceeds the Runtime upload limits.",
    )
}

fn multipart_error(message: impl Into<String>) -> RuntimeHttpServiceError {
    RuntimeHttpServiceError::new(400, "invalid_multipart", message)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;

    #[tokio::test]
    async fn streams_fields_and_files_into_a_runtime_owned_directory() {
        let boundary = "debrute-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"plan\"\r\n\r\n{{\"ok\":true}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file:0\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\nabc123\r\n--{boundary}--\r\n"
        );
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        let parts = read_multipart(request).await.unwrap();
        assert_eq!(
            parts.fields.get("plan").map(String::as_str),
            Some("{\"ok\":true}")
        );
        let file = parts.files.get("file:0").unwrap();
        assert_eq!(
            tokio::fs::metadata(&file.temporary_path)
                .await
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            tokio::fs::read(&file.temporary_path).await.unwrap(),
            b"abc123"
        );
    }

    #[tokio::test]
    async fn rejects_duplicate_fields_and_cleans_the_temporary_directory() {
        let boundary = "duplicate";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n2\r\n--{boundary}--\r\n"
        );
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .unwrap();
        assert_eq!(read_multipart(request).await.unwrap_err().status, 400);
    }
}
