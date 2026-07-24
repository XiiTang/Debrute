---
models:
  - fal-stable-audio-text-to-audio
source_urls:
  - https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api
  - https://fal.ai/docs/documentation/model-apis/inference/queue
captured_at: 2026-07-21
cleanup:
  - removed navigation, marketplace chrome, unrelated models, and alternate transport examples
---

# fal Stable Audio 2.5

## Endpoint and authentication

Debrute submits to `https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio`
with `Authorization: Key <key>`, `Content-Type: application/json`, and
`X-Fal-No-Retry: 1`.

## Agent request fields

- `prompt` is required.
- `seconds_total`, `num_inference_steps`, `guidance_scale`, and `seed` are
  optional exact fields.

Omitted optional values remain absent.

## Response and lifecycle

Debrute submits once, reads the documented queue status, and fetches the result
once after completion. The result `audio` is a File object; Debrute requires its
`url`, downloads the bytes, and detects the artifact media type from those
bytes. Other File metadata is optional.
