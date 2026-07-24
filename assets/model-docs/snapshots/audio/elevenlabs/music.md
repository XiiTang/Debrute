---
models:
  - elevenlabs-music
source_urls:
  - https://elevenlabs.io/docs/api-reference/music/compose
captured_at: 2026-07-06
cleanup:
  - removed navigation, SDK install chrome, playground UI, and unrelated endpoint lists
---

# Official ElevenLabs Music Contract

## Endpoint

Debrute sends `POST https://api.elevenlabs.io/v1/music?output_format={output_format}`.

## Authentication

Debrute sends `xi-api-key: <key>` and `Content-Type: application/json`.

## Request fields

- `output_format`: derived from Debrute `format`; Debrute sends `mp3_44100_128` for `mp3`.
- `prompt`: Debrute `prompt`.
- `model_id`: Debrute upstream model id `music_v2`.
- `music_length_ms`: Debrute `duration_seconds` multiplied by 1000 when provided.
- `force_instrumental`: Debrute `instrumental` when provided.
- `seed`: Debrute `seed` when provided.

## Response fields

The successful response body is the generated audio file bytes. Debrute records response status, headers, byte length, and resolved MIME type in model-run logs.

## Audio encoding

Debrute stores the returned audio bytes directly.

## MIME type

Debrute uses the response `Content-Type` header. If the header is missing, Debrute maps Debrute `format` to `audio/mpeg`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll ElevenLabs music requests.
