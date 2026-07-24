---
models:
  - elevenlabs-sound-effects
source_urls:
  - https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
captured_at: 2026-07-06
cleanup:
  - removed navigation, SDK install chrome, playground UI, and unrelated endpoint lists
---

# Official ElevenLabs Sound Effects Contract

## Endpoint

Debrute sends `POST https://api.elevenlabs.io/v1/sound-generation?output_format={output_format}`.

## Authentication

Debrute sends `xi-api-key: <key>` and `Content-Type: application/json`.

## Request fields

- `output_format`: derived from Debrute `format`; Debrute sends `mp3_44100_128` for `mp3`.
- `text`: Debrute `prompt`.
- `model_id`: Debrute upstream model id `eleven_text_to_sound_v2`.
- `duration_seconds`: Debrute `duration_seconds` when provided.
- `loop`: Debrute `loop` when provided.

## Response fields

The successful response body is the generated MP3 sound effect bytes. Debrute records response status, headers, byte length, and resolved MIME type in model-run logs.

## Audio encoding

Debrute stores the returned audio bytes directly.

## MIME type

Debrute uses the response `Content-Type` header. If the header is missing, Debrute maps Debrute `format` to `audio/mpeg`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll ElevenLabs sound-effect requests.
