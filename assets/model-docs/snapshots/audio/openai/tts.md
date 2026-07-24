---
models:
  - openai-gpt-4o-mini-tts
  - openai-tts-1
  - openai-tts-1-hd
source_urls:
  - https://developers.openai.com/api/docs/guides/text-to-speech
  - https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
captured_at: 2026-07-06
cleanup:
  - removed navigation, interactive playground UI, unrelated model families, and pricing chrome
---

# Official OpenAI TTS Contract

## Endpoint

Debrute sends `POST https://api.openai.com/v1/audio/speech`.

## Authentication

Debrute sends `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Request fields

- `model`: `gpt-4o-mini-tts`, `tts-1`, or `tts-1-hd`.
- `input`: Debrute `text`.
- `voice`: Debrute `voice`, default `alloy`.
- `response_format`: Debrute `format`, default `mp3`.
- `speed`: Debrute `speed` when provided.
- `instructions`: Debrute `instructions` only for `gpt-4o-mini-tts`.

## Response fields

The successful response body is the generated audio bytes. Debrute records response status, headers, byte length, and resolved MIME type in model-run logs.

## Audio encoding

`mp3`, `opus`, `aac`, `flac`, and `wav` responses are stored as returned. `pcm` is raw 24 kHz, 16-bit signed little-endian PCM and Debrute wraps it in WAV.

## MIME type

Debrute uses the response `Content-Type` header. If the header is missing, Debrute maps `mp3` to `audio/mpeg`, `opus` to `audio/ogg`, `aac` to `audio/aac`, `flac` to `audio/flac`, `wav` to `audio/wav`, and `pcm` to `audio/pcm`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll OpenAI TTS requests.
