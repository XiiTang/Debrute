---
models:
  - doubao-seed-tts-2-0
source_urls:
  - https://www.volcengine.com/docs/82379/2516286
  - https://www.volcengine.com/docs/6561/1329505
captured_at: 2026-07-06
cleanup:
  - removed navigation, console chrome, unrelated speech products, and duplicated examples
---

# Official Volcengine Seed TTS Contract

## Endpoint

Debrute sends `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`.

## Authentication

Debrute sends `X-Api-Key: <key>`, `X-Api-Resource-Id: seed-tts-2.0`, `X-Api-Request-Id: <uuid>`, and `Content-Type: application/json`.

## Request fields

- `user.uid`: fixed to `debrute`.
- `req_params.text`: Debrute `text`.
- `req_params.speaker`: Debrute `voice`, default `BV700_V2_streaming`.
- `req_params.audio_params.format`: Debrute `format`, default `mp3`.
- `req_params.audio_params.sample_rate`: Debrute `sample_rate`, default `24000`.

## Response fields

- Frame `data`: base64-encoded audio bytes.
- Frame `code`: final success code `20000000`.
- Frame `message`: final status text.

## Audio encoding

Debrute parses the HTTP response as a sequence of JSON frames, decodes every non-empty `data` field from base64, and concatenates the decoded bytes.

## MIME type

Debrute maps `mp3` to `audio/mpeg`, `pcm` to `audio/pcm`, and `wav` to `audio/wav`. PCM output is wrapped in WAV with Debrute sample-rate metadata.

## Task lifecycle

This endpoint streams frames in the HTTP response. Debrute does not create or poll a separate Volcengine task.
