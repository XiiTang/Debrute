---
models:
  - dashscope-qwen3-tts-flash
source_urls:
  - https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
  - https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide
captured_at: 2026-07-21
cleanup:
  - removed navigation, console chrome, unrelated models, and realtime endpoints
---

# DashScope Qwen3 TTS Flash

## Endpoint and authentication

Debrute sends `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
with `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes `input.text`.
- `voice` is required and becomes `input.voice`.
- `language_type` is optional and becomes `input.language_type`.

Debrute fixes `model` to `qwen3-tts-flash`. Omitted optional values remain
absent.

## Response

Debrute requires `output.audio.url`, downloads that completed audio file, and
detects the stored artifact type from its bytes.

This Model uses the non-streaming response and has no task-polling phase.
