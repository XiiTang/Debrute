---
models:
  - minimax-music-3-0
source_urls:
  - https://platform.minimax.io/docs/api-reference/music-generation
captured_at: 2026-07-21
cleanup:
  - removed navigation, console chrome, previous-generation models, and streaming examples
---

# MiniMax Music 3.0

## Endpoint and authentication

Debrute sends `POST https://api.minimax.io/v1/music_generation` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is optional composition guidance.
- `lyrics` is optional.
- `is_instrumental` is optional.
- `lyrics_optimizer` is optional.
- `audio_setting` is optional and uses the exact MiniMax nested audio fields.
- `output_format` is optional and accepts `hex` or `url`.

Debrute fixes `model` to `music-3.0`. Omitted optional values remain absent.

## Response

For `output_format: "hex"`, Debrute requires and decodes the exact hex audio
field. For `output_format: "url"`, it requires and downloads the exact URL. An
omitted `output_format` follows MiniMax's current hex response behavior.

Remote `base_resp.status_code`, `status_msg`, and trace identity are retained
when MiniMax rejects the request.
