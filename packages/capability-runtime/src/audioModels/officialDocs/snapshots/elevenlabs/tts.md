---
models:
  - elevenlabs-v3-tts
  - elevenlabs-multilingual-v2
source_urls:
  - https://elevenlabs.io/docs/api-reference/text-to-speech/convert
captured_at: 2026-07-06
cleanup:
  - removed navigation, SDK install chrome, playground UI, and unrelated endpoint lists
---

# Official ElevenLabs TTS Contract

## Endpoint

Debrute sends `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format={output_format}`.

## Authentication

Debrute sends `xi-api-key: <key>` and `Content-Type: application/json`.

## Request fields

- `voice_id`: Debrute `voice_id` in the URL path.
- `output_format`: derived from Debrute `format`; `mp3` maps to `mp3_44100_128` and `wav` maps to `wav_44100_16`.
- `text`: Debrute `text`.
- `model_id`: `eleven_v3` or `eleven_multilingual_v2`.
- `voice_settings.stability`: Debrute `stability` when provided.
- `voice_settings.similarity_boost`: Debrute `similarity_boost` when provided.
- `voice_settings.style`: Debrute `style` when provided.
- `voice_settings.speed`: Debrute `speed` when provided.
- `voice_settings.use_speaker_boost`: Debrute `use_speaker_boost` when provided.

## Response fields

The successful response body is the generated audio bytes. Debrute records response status, headers, byte length, and resolved MIME type in model-run logs.

## Audio encoding

Debrute stores the returned audio bytes directly.

## MIME type

Debrute uses the response `Content-Type` header. If the header is missing, Debrute maps Debrute `format` `wav` to `audio/wav` and every other supported value to `audio/mpeg`.

## Task lifecycle

This endpoint is synchronous. Debrute does not poll ElevenLabs TTS requests.
