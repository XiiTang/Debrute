---
models:
  - gemini-tts
source_urls:
  - https://ai.google.dev/gemini-api/docs/speech-generation
  - https://ai.google.dev/api/interactions-api
captured_at: 2026-07-06
cleanup:
  - removed navigation, language switcher chrome, unrelated Gemini guides, and quickstart boilerplate
---

# Official Gemini TTS Contract

## Endpoint

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`.

## Authentication

Debrute sends `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Request fields

- `model`: Debrute upstream model id `gemini-2.5-flash-preview-tts`.
- `input`: Debrute `text`, prefixed by Debrute `instructions` when provided.
- `response_format.type`: fixed to `audio`.
- `generation_config.speech_config[0].voice`: Debrute `voice`, default `Kore`.

## Response fields

- `steps`: interaction step array.
- `steps[].type`: Debrute reads the `model_output` step.
- `steps[].content[]`: Debrute reads the item whose `type` is `audio`.
- `steps[].content[].data`: base64-encoded generated audio.
- `steps[].content[].mime_type`: MIME string for the audio block.

## Audio encoding

Gemini TTS returns raw PCM audio for Debrute's selected request. Debrute decodes the `model_output` audio `data` field from base64 and wraps PCM in WAV.

## MIME type

Debrute parses `audio/pcm`, `audio/pcm;rate=24000`, and `audio/L16;codec=pcm;rate=24000` as 24 kHz, mono, 16-bit PCM unless the MIME string contains a different positive `rate` or `channels` parameter.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll Gemini TTS requests.
