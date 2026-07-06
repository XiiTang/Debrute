---
models:
  - minimax-music-2-6
source_urls:
  - https://platform.minimax.io/docs/api-reference/music-generation
captured_at: 2026-07-06
cleanup:
  - removed navigation, console chrome, SDK boilerplate, and unrelated endpoints
---

# Official MiniMax Music Generation Contract

## Endpoint

Debrute sends `POST https://api.minimax.io/v1/music_generation`.

## Authentication

Debrute sends `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Request fields

- `model`: Debrute upstream model id `music-2.6`.
- `prompt`: Debrute `prompt`.
- `lyrics`: Debrute `lyrics` when provided.
- `is_instrumental`: Debrute `instrumental`; Debrute sends `true` when lyrics are absent.
- `output_format`: fixed to `hex`.
- `audio_setting.sample_rate`: Debrute `sample_rate`, default `44100`.
- `audio_setting.bitrate`: Debrute `bitrate`, default `256000`.
- `audio_setting.format`: Debrute `format`, default `mp3`.

## Response fields

- `data.audio`: hex-encoded generated music audio.
- `data.status`: documented success status value `2`.
- `extra_info.music_sample_rate`: generated sample rate.
- `extra_info.music_channel`: generated channel count.
- `base_resp.status_code`: success value `0` when present.

## Audio encoding

Debrute decodes `data.audio` as hex and stores the resulting bytes.

## MIME type

Debrute maps `mp3` to `audio/mpeg`, `wav` to `audio/wav`, and `flac` to `audio/flac`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll MiniMax music requests.
