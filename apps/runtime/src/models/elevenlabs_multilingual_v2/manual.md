# elevenlabs-multilingual-v2

## Official sources

- https://elevenlabs.io/docs/overview/models
- https://elevenlabs.io/docs/api-reference/text-to-speech/convert

Captured: 2026-08-09

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

This exact model supports 29 languages and accepts at most 10,000 characters
per request. It is intended for stable long-form, single-voice speech.
`language_code` is not supported by `eleven_multilingual_v2` and is not an
understood argument for this Model. Available output encodings can depend on
the ElevenLabs subscription tier.

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

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "elevenlabs-multilingual-v2",
  "arguments": {
    "text": "A concise multilingual narration line.",
    "voice_id": "JBFqnCBsd6RMkjVDRZzb",
    "output_format": "mp3_44100_128"
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
