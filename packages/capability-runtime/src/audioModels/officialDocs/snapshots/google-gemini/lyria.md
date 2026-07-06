---
models:
  - google-lyria-3-clip-preview
  - google-lyria-3-pro-preview
source_urls:
  - https://ai.google.dev/gemini-api/docs/music-generation
  - https://ai.google.dev/api/interactions-api
captured_at: 2026-07-06
cleanup:
  - removed navigation, language switcher chrome, unrelated Gemini guides, and quickstart boilerplate
---

# Official Google Lyria Contract

## Endpoint

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`.

## Authentication

Debrute sends `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Request fields

- `model`: `lyria-3-clip-preview` or `lyria-3-pro-preview`.
- `input`: Debrute `prompt`.
- `response_format.type`: fixed to `audio` only for `lyria-3-pro-preview` when Debrute `format` is `wav`.

## Response fields

- `steps`: interaction step array.
- `steps[].type`: Debrute reads the `model_output` step.
- `steps[].content[]`: Debrute reads the item whose `type` is `audio`.
- `steps[].content[].data`: base64-encoded generated audio.
- `steps[].content[].mime_type`: MIME string for the audio block.

## Audio encoding

Debrute decodes the `model_output` audio `data` field from base64 and stores the resulting bytes.

## MIME type

Debrute reads `steps[].content[].mime_type` for generated audio. For the selected Debrute output contracts, `lyria-3-clip-preview` is `audio/mpeg`; `lyria-3-pro-preview` is `audio/mpeg` for `mp3` and `audio/wav` for `wav`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll Google Lyria requests.
