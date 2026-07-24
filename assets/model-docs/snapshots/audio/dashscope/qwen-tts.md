---
models:
  - dashscope-qwen3-tts-flash
source_urls:
  - https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
  - https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide
captured_at: 2026-07-06
cleanup:
  - removed navigation, console chrome, unrelated product pages, and SDK install boilerplate
---

# Official DashScope Qwen-TTS Contract

## Endpoint

Debrute sends `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`.

## Authentication

Debrute sends `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Request fields

- `model`: Debrute upstream model id `qwen3-tts-flash`.
- `input.text`: Debrute `text`.
- `input.voice`: Debrute `voice`, default `Cherry`.
- `input.language_type`: Debrute `language` when provided.

## Response fields

- `output.audio.url`: downloadable synthesized audio file URL.
- `request_id`: request identifier used only for logs.

## Audio encoding

Debrute stores the downloaded URL response bytes.

## MIME type

Debrute stores this selected Qwen3-TTS-Flash path as `audio/wav`.

## Task lifecycle

This Debrute path uses DashScope non-streaming output. Debrute does not poll DashScope TTS requests.
