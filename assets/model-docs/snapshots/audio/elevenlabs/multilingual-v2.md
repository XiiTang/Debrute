---
models:
  - elevenlabs-multilingual-v2
source_urls:
  - https://elevenlabs.io/docs/overview/models
  - https://elevenlabs.io/docs/api-reference/text-to-speech/convert
captured_at: 2026-07-21
cleanup:
  - removed navigation, playground UI, unrelated models, and SDK boilerplate
---

# ElevenLabs Multilingual v2 TTS

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
with `xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `voice_id` is required and becomes the URL path value.
- `output_format` is optional and becomes the exact query value.
- `voice_settings` is optional and may contain `stability`,
  `similarity_boost`, `style`, `speed`, and `use_speaker_boost`.
- `pronunciation_dictionary_locators` is an optional array of exact
  `{ "pronunciation_dictionary_id": "...", "version_id": "..." }` objects.
- `seed`, `previous_text`, `next_text`, `previous_request_ids`, and
  `next_request_ids` are optional continuity controls.
- `apply_text_normalization` and `apply_language_text_normalization` are
  optional endpoint controls.

Debrute fixes body `model_id` to `eleven_multilingual_v2`. When
`output_format` is omitted, the query parameter remains absent and ElevenLabs
currently selects `mp3_44100_128`. Debrute does not materialize that remote
default.

Current Create Speech output-format values include MP3, Opus, raw PCM, mu-law,
A-law, and WAV encodings. The current 44.1 kHz WAV value is `wav_44100`.

## Response

A successful request returns the complete audio body. Debrute stores container
and raw encodings without converting them into a different format.

This Model uses the synchronous Create Speech response.
