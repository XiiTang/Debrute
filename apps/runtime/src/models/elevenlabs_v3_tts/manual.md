# elevenlabs-v3-tts

## Official sources

- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert
- https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
- https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
with `xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `voice_id` is required and becomes the URL path value.
- `output_format` is optional and becomes the exact query value.
- `language_code` is an optional ISO 639-1 language code used by the endpoint
  for language enforcement and text normalization.
- `voice_settings` is optional. For Eleven v3, the evidenced request setting
  exposed here is `stability`; speed is instead controlled through text and
  v3 audio tags, not a v3 speed setting.
- `pronunciation_dictionary_locators` is optional and accepts up to three
  ordered `{ "pronunciation_dictionary_id": "...", "version_id": "..." }`
  objects.
- `seed` is optional and ranges from 0 through 4294967295. ElevenLabs treats it
  as a best-effort determinism control, not a guarantee.
- `previous_text` and `next_text` optionally provide surrounding text for
  continuity across separately generated clips.
- `previous_request_ids` and `next_request_ids` optionally provide up to three
  adjacent Create Speech request IDs. When both forms are supplied for one
  side, the corresponding request IDs take precedence over its text.
- `apply_text_normalization` accepts `auto`, `on`, or `off`.
- `apply_language_text_normalization` optionally enables language-specific
  normalization; the official endpoint currently documents it for Japanese
  and warns that it can substantially increase latency.
- `use_pvc_as_ivc` is the endpoint's deprecated PVC-to-IVC workaround. It is
  still forwarded when deliberately supplied, but should not be selected for
  new usage without a current need.

Eleven v3 supports 70+ languages, up to 5,000 input characters, and expressive
audio tags in the text. This exact executor calls single-voice Create Speech.
ElevenLabs' multi-speaker Text to Dialogue capability is a separate endpoint
with a different request and response contract; Debrute does not process that
Dialogue lifecycle through this Model.

Debrute fixes body `model_id` to `eleven_v3`. When `output_format` is omitted,
the query parameter remains absent and ElevenLabs currently selects
`mp3_44100_128`. Debrute does not materialize that remote default.

Current Create Speech output-format values include MP3, Opus, raw PCM, mu-law,
A-law, and WAV encodings. The current 44.1 kHz WAV value is `wav_44100`.

## Response

A successful request returns the complete audio body. Debrute stores container
and raw encodings without converting them into a different format.

This Model uses the synchronous Create Speech response.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "elevenlabs-v3-tts",
  "arguments": {
    "text": "A cinematic narration line.",
    "voice_id": "JBFqnCBsd6RMkjVDRZzb",
    "output_format": "mp3_44100_128"
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
