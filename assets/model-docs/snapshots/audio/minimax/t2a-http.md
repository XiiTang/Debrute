---
models:
  - minimax-speech-2-8-hd
source_urls:
  - https://platform.minimax.io/docs/api-reference/speech-t2a-http
captured_at: 2026-07-06
cleanup:
  - removed navigation, console chrome, duplicated language lists, and unrelated endpoints
---

# Official MiniMax T2A HTTP Contract

## Endpoint

Debrute sends `POST https://api.minimax.io/v1/t2a_v2`.

## Authentication

Debrute sends `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Request fields

- `model`: Debrute upstream model id `speech-2.8-hd`.
- `text`: Debrute `text`.
- `stream`: fixed to `false`.
- `output_format`: fixed to `hex`.
- `voice_setting.voice_id`: Debrute `voice`, default `male-qn-qingse`.
- `voice_setting.speed`: Debrute `speed` when provided.
- `voice_setting.pitch`: Debrute `pitch` when provided.
- `audio_setting.sample_rate`: Debrute `sample_rate`, default `32000`.
- `audio_setting.bitrate`: Debrute `bitrate`, default `128000`.
- `audio_setting.format`: Debrute `format`, default `mp3`.
- `audio_setting.channel`: fixed to `1`.

## Response fields

- `data.audio`: hex-encoded generated audio.
- `data.status`: documented success status value `2`.
- `extra_info.audio_format`: generated audio format when present.
- `base_resp.status_code`: success value `0` when present.

## Audio encoding

Debrute decodes `data.audio` as hex and stores the resulting bytes.

## MIME type

Debrute maps `mp3` to `audio/mpeg`, `wav` to `audio/wav`, and `flac` to `audio/flac`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll MiniMax TTS requests.
