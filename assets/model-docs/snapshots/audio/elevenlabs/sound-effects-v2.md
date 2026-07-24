---
models:
  - elevenlabs-sound-effects
source_urls:
  - https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
captured_at: 2026-07-21
cleanup:
  - removed navigation, playground UI, unrelated models, and SDK boilerplate
---

# ElevenLabs Sound Effects v2

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/sound-generation` with
`xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `duration_seconds`, `loop`, `prompt_influence`, and `output_format` are
  optional exact fields.

Debrute fixes body `model_id` to `eleven_text_to_sound_v2`. Omitted optional
values remain absent.

## Response

A successful request returns the complete generated audio body, which Debrute
stores without container conversion.

This Model uses one synchronous response.
