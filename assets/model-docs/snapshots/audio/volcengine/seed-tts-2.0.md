---
models:
  - doubao-seed-tts-2-0
source_urls:
  - https://www.volcengine.com/docs/82379/2516286
  - https://www.volcengine.com/docs/6561/1598757
  - https://www.volcengine.com/docs/6561/1257544
captured_at: 2026-07-21
cleanup:
  - removed navigation, console chrome, unrelated speech products, and alternate transports
---

# Volcengine Seed TTS 2.0

## Endpoint and authentication

Debrute sends `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
with `X-Api-Key: <key>`, `X-Api-Resource-Id: seed-tts-2.0`, a UUID
`X-Api-Request-Id`, and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes `req_params.text`.
- `speaker` is required and becomes `req_params.speaker`.
- `audio_params` is optional and may contain exact `format`, `sample_rate`,
  `bit_rate`, `emotion`, `emotion_scale`, `speech_rate`, and `loudness_rate`
  fields.

For this chunked Model, exposed audio formats are `mp3`, `ogg_opus`, and raw
`pcm`. Omitted optional values remain absent.

## Response

Debrute continuously deserializes the HTTP body as JSON objects. A frame with
`code: 0` may carry Base64 audio or progress; `code: 20000000` completes the
request. Decoded audio chunks are concatenated in response order. Raw PCM
remains raw PCM.

A different frame code is a remote business error. Debrute retains its message
and the response `X-Tt-Logid`.
