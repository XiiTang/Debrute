# doubao-seedance-2-0-fast-260128

## Official sources

- https://www.volcengine.com/docs/82379/2291680
- https://www.volcengine.com/docs/82379/1520757
- https://www.volcengine.com/docs/82379/1521309
- https://www.volcengine.com/docs/82379/1159178

Captured: 2026-08-09

The exact remote model id is `doubao-seedance-2-0-fast-260128`.

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

The request boundary materializes the default `intent: "generate"`; the
adapter requires that canonical value and has no fallback intent.

This Model supports `480p` and `720p`; it does not support `1080p`.
`duration` accepts 4 through 15 seconds, or `-1` to let Seedance select the
duration. It materializes `watermark: false`; an explicit `true` remains
explicit. If the remote endpoint rejects `false`, Debrute returns that error
without changing the value or retrying.

## Media mapping

Debrute constructs the exact typed `content` array from the prompt and ordered
references. Publicly reachable URLs and Ark `asset://` values remain URLs.
Supported local image and audio values may become data URIs. A local video
without a model-reachable URL fails before task creation.

Each `references` item is an object with a required `source` and an optional
`media_type`. The supported `media_type` values are `image`, `video`, `audio`,
and `mask`; when omitted, Debrute infers the type from `source`. No other nested
fields are accepted because Debrute transforms each item into typed Seedance
content and cannot forward additional children losslessly.

## Response

Debrute downloads the completed video and optional last frame, detects their
media types from bytes, and commits the complete result.

## Debrute request

The default active video Model request timeout is 30 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seedance-2-0-fast-260128",
  "arguments": {
    "prompt": "A quiet product launch video with slow camera movement and synchronized ambient audio.",
    "intent": "generate",
    "references": [],
    "resolution": "720p",
    "ratio": "16:9",
    "duration": 5,
    "generate_audio": true,
    "watermark": false
  },
  "output": {
    "directory": "generated",
    "name": "video"
  }
}
```
