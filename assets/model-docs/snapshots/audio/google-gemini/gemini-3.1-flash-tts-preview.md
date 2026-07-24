---
models:
  - gemini-3-1-flash-tts-preview
source_urls:
  - https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview
  - https://ai.google.dev/gemini-api/docs/speech-generation
  - https://ai.google.dev/api/interactions-api
captured_at: 2026-07-21
cleanup:
  - removed navigation, legacy generateContent examples, unrelated models, and SDK boilerplate
---

# Gemini 3.1 Flash TTS Preview

## Endpoint and authentication

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes the Interactions text input.
- `speech_config` is required. A single-speaker entry has exact shape
  `{ "voice": "..." }`; a two-speaker request uses up to two exact
  `{ "speaker": "...", "voice": "..." }` entries whose speaker names occur in
  the text.
- `language` is optional.

Debrute fixes `model` to `gemini-3.1-flash-tts-preview`, `store` to `false`,
and `response_format.type` to `audio`.

## Response

Debrute reads audio content from every exact
`steps[type="model_output"].content[type="audio"]` block and decodes its Base64
`data`. The returned raw PCM bytes remain a raw PCM artifact; Debrute does not
wrap them in WAV.

This Model uses one completed Interactions response.
