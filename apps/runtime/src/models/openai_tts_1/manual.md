# openai-tts-1

## Official sources

- https://developers.openai.com/api/docs/guides/text-to-speech

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.openai.com/v1/audio/speech` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes OpenAI `input`.
- `voice` is required. It is either a built-in voice string or the exact custom
  voice object `{ "id": "..." }`.
- `format` is optional and becomes `response_format`.
- `speed` is optional and ranges from 0.25 through 4.

`text` is limited to 4096 characters. Supported formats are MP3, Opus, AAC,
FLAC, WAV, and raw PCM. OpenAI accepts only the ordinary `audio` stream format
for `tts-1`; SSE and `instructions` are not supported by this model.

Debrute fixes request `model` to `tts-1`. When `format` is omitted, Debrute
leaves `response_format` absent; OpenAI currently selects MP3. That is the
remote endpoint's default, not a materialized Debrute argument.

## Response

A successful request returns the complete generated audio body. Debrute stores
MP3, Opus, AAC, FLAC, WAV, and raw PCM bytes without container conversion. In
particular, `pcm` remains a raw PCM artifact.

This Model uses one synchronous response and has no Debrute task-polling phase.
The completed audio body is compatible with Debrute's response path; there is
no SSE event state machine.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "openai-tts-1",
  "arguments": {
    "text": "Welcome to Debrute.",
    "voice": "alloy",
    "format": "mp3"
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
