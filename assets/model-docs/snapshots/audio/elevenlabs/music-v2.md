---
models:
  - elevenlabs-music
source_urls:
  - https://elevenlabs.io/docs/api-reference/music/compose
  - https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans
captured_at: 2026-07-21
cleanup:
  - removed navigation, playground UI, v1-only controls, and alternate response endpoints
---

# ElevenLabs Music v2

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/music` with
`xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is an optional text composition request.
- `composition_plan` is an optional ordered plan. Its `chunks` contain either
  generation chunks with `text`, `duration_ms`, `positive_styles`, optional
  `negative_styles`, `context_adherence`, `conditioning_ref`, and
  `condition_strength`; or audio-reference chunks with `song_id` and `range`.
- `music_length_ms` is optional for prompt-based generation.
- `seed`, `force_instrumental`, `store_for_inpainting`, and `sign_with_c2pa`
  are optional exact fields.
- `output_format` is optional and becomes the exact query value.

Debrute fixes body `model_id` to `music_v2`. ElevenLabs validates the permitted
prompt/plan and conditional-field combinations.

When `output_format` is omitted, Debrute leaves it absent. The endpoint's
current v2 automatic result is `mp3_48000_192`; Debrute does not materialize
that remote default.

## Response

A successful request returns the complete audio body. Debrute stores it without
container conversion and retains the response `song-id` when present.

This Model uses the ordinary synchronous Compose response.
