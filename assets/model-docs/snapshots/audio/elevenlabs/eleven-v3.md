---
models:
  - elevenlabs-v3-tts
source_urls:
  - https://elevenlabs.io/docs/overview/models
  - https://elevenlabs.io/docs/api-reference/text-to-speech/convert
  - https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
captured_at: 2026-07-21
cleanup:
  - removed navigation, playground UI, unrelated models, and SDK boilerplate
---

# ElevenLabs v3 TTS

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
with `xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `voice_id` is required and becomes the URL path value.
- `output_format` is optional and becomes the exact query value.
- `voice_settings` is optional. This Model exposes its evidenced `stability`
  and `speed` child fields.
- `seed` is optional.

Debrute fixes body `model_id` to `eleven_v3`. When `output_format` is omitted,
the query parameter remains absent and ElevenLabs currently selects
`mp3_44100_128`. Debrute does not materialize that remote default.

Current Create Speech output-format values include MP3, Opus, raw PCM, mu-law,
A-law, and WAV encodings. The current 44.1 kHz WAV value is `wav_44100`.

## Response

A successful request returns the complete audio body. Debrute stores container
and raw encodings without converting them into a different format.

This Model uses the synchronous Create Speech response.
