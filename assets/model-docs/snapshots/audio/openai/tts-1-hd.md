---
models:
  - openai-tts-1-hd
source_urls:
  - https://developers.openai.com/api/docs/guides/text-to-speech
captured_at: 2026-07-21
cleanup:
  - removed navigation, playground UI, unrelated models, and SDK boilerplate
---

# OpenAI TTS-1 HD

## Endpoint and authentication

Debrute sends `POST https://api.openai.com/v1/audio/speech` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes OpenAI `input`.
- `voice` is required. It is either a built-in voice string or the exact custom
  voice object `{ "id": "..." }`.
- `format` is optional and becomes `response_format`.
- `speed` is optional.

Debrute fixes request `model` to `tts-1-hd`. When `format` is omitted, Debrute
leaves `response_format` absent; OpenAI currently selects MP3. That is the
remote endpoint's default, not a materialized Debrute argument.

## Response

A successful request returns the complete generated audio body. Debrute stores
MP3, Opus, AAC, FLAC, WAV, and raw PCM bytes without container conversion. In
particular, `pcm` remains a raw PCM artifact.

This Model uses one synchronous response and has no Debrute task-polling phase.
