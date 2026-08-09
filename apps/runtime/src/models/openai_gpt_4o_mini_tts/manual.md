# openai-gpt-4o-mini-tts

## Official sources

- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- https://developers.openai.com/api/docs/models/all
- https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create

Captured: 2026-08-09

OpenAI's current all-models directory marks `gpt-4o-mini-tts` as
**Deprecated**. Debrute keeps this deprecated exact Model only for deliberate
selection; an Agent should not choose it as an ordinary current default.

## Endpoint and authentication

Debrute sends `POST https://api.openai.com/v1/audio/speech` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes OpenAI `input`.
- `voice` is required. It is either a built-in voice string or the exact custom
  voice object `{ "id": "..." }`.
- `format` is optional and becomes `response_format`.
- `stream_format` is optional. Debrute supports the official `audio` value,
  which returns the completed audio body. The official `sse` value is not
  supported by this exact executor.
- `speed` is optional and ranges from 0.25 through 4.
- `instructions` is optional style control for this Model and is limited to
  4096 characters.

`text` is limited to 4096 characters. Supported completed-audio formats are
MP3, Opus, AAC, FLAC, WAV, and raw PCM. OpenAI accepts both
`stream_format: "audio"` and `stream_format: "sse"` for this model, but only
the completed `audio` response is part of this Debrute exact Model contract.

Debrute fixes request `model` to `gpt-4o-mini-tts`. When `format` is omitted,
Debrute leaves `response_format` absent; OpenAI currently selects MP3. That is
the remote endpoint's default, not a materialized Debrute argument.

## Response

A successful request returns the complete generated audio body. Debrute stores
MP3, Opus, AAC, FLAC, WAV, and raw PCM bytes without container conversion. In
particular, `pcm` remains a raw PCM artifact.

This Model uses one synchronous response and has no Debrute task-polling phase.
The exact executor does not implement the SSE event lifecycle. Do not request
`stream_format: "sse"`: an unknown-field pass-through would otherwise forward
it and the executor would receive an event stream where it expects audio bytes.
Ordinary completed audio remains supported.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "openai-gpt-4o-mini-tts",
  "arguments": {
    "text": "Welcome to Debrute.",
    "voice": "alloy",
    "format": "mp3"
  },
  "output": {
    "directory": "generated",
    "name": "voiceover"
  }
}
```
