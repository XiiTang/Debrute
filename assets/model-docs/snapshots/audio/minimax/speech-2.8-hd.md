---
models:
  - minimax-speech-2-8-hd
source_urls:
  - https://platform.minimax.io/docs/api-reference/speech-t2a-http
  - https://platform.minimax.io/docs/guides/models-intro
captured_at: 2026-07-21
cleanup:
  - removed navigation, console chrome, unrelated models, and streaming or asynchronous endpoints
---

# MiniMax Speech 2.8 HD

## Endpoint and authentication

Debrute sends `POST https://api.minimax.io/v1/t2a_v2` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `voice_setting` is required and contains exact `voice_id` plus optional
  `speed`, `vol`, `pitch`, `text_normalization`, and `latex_read` fields.
- `audio_setting` is optional and may contain exact `sample_rate`, `bitrate`,
  `format`, `channel`, and `force_cbr` fields.
- `emotion`, `language_boost`, `pronunciation_dict`, and `voice_modify` are
  optional exact fields.
- `subtitle_enable` and `subtitle_type` are optional.
- `output_format` is optional and accepts the provider response forms `hex` or
  `url`.

Debrute fixes `model` to `speech-2.8-hd` and sends the synchronous HTTP request.
Omitted optional values remain absent.

## Response

For `output_format: "hex"`, Debrute requires and decodes the exact hex audio
field. For `output_format: "url"`, it requires and downloads the exact URL. An
omitted `output_format` follows MiniMax's current hex response behavior.

Remote `base_resp.status_code`, `status_msg`, and trace identity are retained
when MiniMax rejects the request. Returned raw encodings remain raw.
