---
models:
  - doubao-seedance-2-0-fast-260128
source_urls:
  - https://www.volcengine.com/docs/82379/2291680
  - https://www.volcengine.com/docs/82379/1520757
  - https://www.volcengine.com/docs/82379/1521309
  - https://www.volcengine.com/docs/82379/1159178
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed navigation, unrelated models, SDK boilerplate, and alternate task APIs
---

# Doubao Seedance 2.0 Fast Video Generation

This manual describes only Debrute Model
`doubao-seedance-2-0-fast-260128`, whose exact remote model id is the same
value. Use it for faster iterations at up to 720p.

## Endpoint and lifecycle

Debrute creates one asynchronous task with
`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`
and polls only
`GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}`.
A successful task supplies `content.video_url` and may supply
`content.last_frame_url` when requested.

## Agent request fields

- `prompt` is required.
- `intent` and `references` select text generation, frame guidance, general
  reference, audio-driven generation, or extension.
- `ratio`, `resolution`, `duration`, `frames`, `seed`, `camera_fixed`,
  `watermark`, `generate_audio`, `return_last_frame`, `edit_scope`,
  `extend_direction`, `tools`, `callback_url`, `safety_identifier`, and
  `execution_expires_after` are optional exact fields.

This Model supports `480p` and `720p`. It materializes `watermark: false`; an
explicit `true` remains explicit. If the remote endpoint rejects `false`,
Debrute returns that error without changing the value or retrying.

## Media mapping

Debrute constructs the exact typed `content` array from the prompt and ordered
references. Publicly reachable URLs and Ark `asset://` values remain URLs.
Supported Project image and audio values may become data URIs. A Project-local
video without a model-reachable URL fails before task creation.

## Response

Debrute downloads the completed video and optional last frame, detects their
media types from bytes, and commits the complete result.
