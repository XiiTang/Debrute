---
models:
  - fal-stable-audio-3-small-sfx
source_urls:
  - https://fal.ai/models/fal-ai/stable-audio-3/small/sfx/text-to-audio/api
  - https://fal.ai/docs/documentation/model-apis/inference/queue
captured_at: 2026-07-21
cleanup:
  - removed navigation, marketplace chrome, base checkpoints, and alternate transport examples
---

# fal Stable Audio 3 Small SFX

## Endpoint and authentication

Debrute submits to
`https://queue.fal.run/fal-ai/stable-audio-3/small/sfx/text-to-audio` with
`Authorization: Key <key>`, `Content-Type: application/json`, and
`X-Fal-No-Retry: 1`.

## Agent request fields

- `prompt` is required.
- `negative_prompt`, `duration`, `num_inference_steps`, `guidance_scale`, and
  `seed` are optional.
- `enable_prompt_expansion` and `enable_safety_checker` are optional.
- `output_format` and `bitrate` are optional.

Omitted optional values remain absent.

## Response and lifecycle

Debrute submits once, reads the documented queue status, and fetches the result
once after completion. The result `audio` is a File object; Debrute requires its
`url`, downloads the bytes, and detects the artifact media type from those
bytes. Other File metadata is optional.
