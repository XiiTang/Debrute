use std::io;

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};

const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub const MAX_WEBSOCKET_FRAME_BYTES: usize = 1024 * 1024;

pub struct WebSocketUpgrade {
    request: Request,
    accept: HeaderValue,
}

impl WebSocketUpgrade {
    #[allow(clippy::result_large_err)]
    pub fn from_request(request: Request) -> Result<Self, Response> {
        if !has_token(request.headers(), header::CONNECTION, "upgrade")
            || !has_exact(request.headers(), header::UPGRADE, "websocket")
            || !has_exact(request.headers(), header::SEC_WEBSOCKET_VERSION, "13")
        {
            return Err(StatusCode::UPGRADE_REQUIRED.into_response());
        }
        let key = one_header(request.headers(), header::SEC_WEBSOCKET_KEY)
            .ok()
            .flatten()
            .filter(|value| {
                STANDARD
                    .decode(value)
                    .is_ok_and(|decoded| decoded.len() == 16)
            })
            .ok_or_else(|| StatusCode::BAD_REQUEST.into_response())?;
        let mut proof = Vec::with_capacity(key.len() + WEBSOCKET_GUID.len());
        proof.extend_from_slice(key.as_bytes());
        proof.extend_from_slice(WEBSOCKET_GUID.as_bytes());
        let accept = HeaderValue::from_str(&STANDARD.encode(sha1(&proof)))
            .map_err(|_| StatusCode::BAD_REQUEST.into_response())?;
        Ok(Self { request, accept })
    }

    pub fn on_upgrade(
        mut self,
        handler: impl FnOnce(WebSocketConnection) + Send + 'static,
    ) -> Response {
        let pending = hyper::upgrade::on(&mut self.request);
        tokio::spawn(async move {
            if let Ok(upgraded) = pending.await {
                handler(WebSocketConnection::new(upgraded));
            }
        });
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_ACCEPT, self.accept)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

pub struct WebSocketConnection {
    io: TokioIo<Upgraded>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebSocketMessage {
    Text(String),
    Ping(Vec<u8>),
    Pong,
    Close,
}

impl WebSocketConnection {
    fn new(upgraded: Upgraded) -> Self {
        Self {
            io: TokioIo::new(upgraded),
        }
    }

    pub fn into_io(self) -> TokioIo<Upgraded> {
        self.io
    }
}

pub async fn read_text<Reader>(reader: &mut Reader, maximum: usize) -> io::Result<Option<String>>
where
    Reader: AsyncRead + Unpin,
{
    loop {
        match read_message(reader, maximum).await? {
            Some(WebSocketMessage::Text(text)) => return Ok(Some(text)),
            Some(WebSocketMessage::Close) | None => return Ok(None),
            Some(WebSocketMessage::Ping(_) | WebSocketMessage::Pong) => {}
        }
    }
}

pub async fn read_message<Reader>(
    reader: &mut Reader,
    maximum: usize,
) -> io::Result<Option<WebSocketMessage>>
where
    Reader: AsyncRead + Unpin,
{
    let mut header_bytes = [0_u8; 2];
    match reader.read_exact(&mut header_bytes).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let final_frame = header_bytes[0] & 0x80 != 0;
    let reserved = header_bytes[0] & 0x70;
    let opcode = header_bytes[0] & 0x0f;
    let masked = header_bytes[1] & 0x80 != 0;
    if !final_frame || reserved != 0 || !masked {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "fragmented or unmasked WebSocket frame",
        ));
    }
    let mut length = u64::from(header_bytes[1] & 0x7f);
    if length == 126 {
        length = u64::from(reader.read_u16().await?);
    } else if length == 127 {
        length = reader.read_u64().await?;
    }
    if length > maximum as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "WebSocket frame exceeds its limit",
        ));
    }
    if opcode >= 0x8 && length > 125 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "WebSocket control frame exceeds 125 bytes",
        ));
    }
    let mut mask = [0_u8; 4];
    reader.read_exact(&mut mask).await?;
    let mut payload = vec![0; usize::try_from(length).unwrap_or(maximum + 1)];
    reader.read_exact(&mut payload).await?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    match opcode {
        0x1 => String::from_utf8(payload)
            .map(WebSocketMessage::Text)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        0x8 => Ok(Some(WebSocketMessage::Close)),
        0x9 => Ok(Some(WebSocketMessage::Ping(payload))),
        0xA => Ok(Some(WebSocketMessage::Pong)),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported WebSocket opcode",
        )),
    }
}

pub async fn write_text<Writer>(writer: &mut Writer, text: &str) -> io::Result<()>
where
    Writer: AsyncWrite + Unpin,
{
    write_frame(writer, 0x1, text.as_bytes()).await
}

pub async fn write_close<Writer>(writer: &mut Writer) -> io::Result<()>
where
    Writer: AsyncWrite + Unpin,
{
    write_frame(writer, 0x8, &[]).await
}

pub async fn write_pong<Writer>(writer: &mut Writer, payload: &[u8]) -> io::Result<()>
where
    Writer: AsyncWrite + Unpin,
{
    if payload.len() > 125 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "WebSocket pong exceeds 125 bytes",
        ));
    }
    write_frame(writer, 0xA, payload).await
}

async fn write_frame<Writer>(writer: &mut Writer, opcode: u8, payload: &[u8]) -> io::Result<()>
where
    Writer: AsyncWrite + Unpin,
{
    if payload.len() > MAX_WEBSOCKET_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "WebSocket frame exceeds its limit",
        ));
    }
    writer.write_u8(0x80 | opcode).await?;
    match payload.len() {
        length if length < 126 => {
            writer
                .write_u8(u8::try_from(length).expect("short WebSocket length fits u8"))
                .await?;
        }
        length if u16::try_from(length).is_ok() => {
            writer.write_u8(126).await?;
            writer
                .write_u16(u16::try_from(length).expect("medium WebSocket length fits u16"))
                .await?;
        }
        length => {
            writer.write_u8(127).await?;
            writer.write_u64(length as u64).await?;
        }
    }
    writer.write_all(payload).await?;
    writer.flush().await
}

fn one_header(headers: &HeaderMap, name: header::HeaderName) -> Result<Option<&str>, ()> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(());
    }
    value.to_str().map(Some).map_err(|_| ())
}

fn has_exact(headers: &HeaderMap, name: header::HeaderName, expected: &str) -> bool {
    matches!(one_header(headers, name), Ok(Some(value)) if value.eq_ignore_ascii_case(expected))
}

fn has_token(headers: &HeaderMap, name: header::HeaderName, expected: &str) -> bool {
    one_header(headers, name).is_ok_and(|value| {
        value.is_some_and(|value| {
            value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case(expected))
        })
    })
}

#[allow(clippy::many_single_char_names)]
fn sha1(input: &[u8]) -> [u8; 20] {
    let bit_length = (input.len() as u64).wrapping_mul(8);
    let mut message = input.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());
    let mut h = [
        0x6745_2301_u32,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    for block in message.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temporary = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temporary;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut digest = [0_u8; 20];
    for (index, word) in h.into_iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [0x12, 0x34, 0x56, 0x78];
        assert!(payload.len() < 126);
        let mut frame = vec![0x80 | opcode, 0x80 | u8::try_from(payload.len()).unwrap()];
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(index, byte)| byte ^ mask[index % mask.len()]),
        );
        frame
    }

    #[test]
    fn websocket_accept_matches_rfc6455_example() {
        let mut proof = b"dGhlIHNhbXBsZSBub25jZQ==".to_vec();
        proof.extend_from_slice(WEBSOCKET_GUID.as_bytes());
        assert_eq!(
            STANDARD.encode(sha1(&proof)),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[tokio::test]
    async fn masked_text_ping_and_pong_use_closed_rfc6455_frames() {
        let text_frame = masked_frame(0x1, b"hello");
        let mut text = text_frame.as_slice();
        assert_eq!(
            read_message(&mut text, 16).await.unwrap(),
            Some(WebSocketMessage::Text("hello".to_owned()))
        );

        let ping_frame = masked_frame(0x9, b"alive");
        let mut ping = ping_frame.as_slice();
        assert_eq!(
            read_message(&mut ping, 16).await.unwrap(),
            Some(WebSocketMessage::Ping(b"alive".to_vec()))
        );

        let mut encoded_pong = Vec::new();
        write_pong(&mut encoded_pong, b"alive").await.unwrap();
        assert_eq!(encoded_pong, [0x8A, 5, b'a', b'l', b'i', b'v', b'e']);
    }

    #[tokio::test]
    async fn unmasked_fragmented_and_oversized_frames_are_rejected() {
        let mut unmasked = [0x81, 0x01, b'a'].as_slice();
        assert_eq!(
            read_message(&mut unmasked, 16).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let mut fragmented = masked_frame(0x1, b"a");
        fragmented[0] &= 0x7F;
        assert_eq!(
            read_message(&mut fragmented.as_slice(), 16)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        let oversized_frame = masked_frame(0x1, b"too large");
        let mut oversized = oversized_frame.as_slice();
        assert_eq!(
            read_message(&mut oversized, 4).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
