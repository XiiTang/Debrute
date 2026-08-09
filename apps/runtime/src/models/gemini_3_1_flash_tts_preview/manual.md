# gemini-3-1-flash-tts-preview

## Official sources

- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/api/interactions-api

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes the Interactions text input.
- `speech_config` is required. A single-speaker entry has exact shape
  `{ "voice": "...", "language": "..." }`; a two-speaker request uses up to
  two `{ "speaker": "...", "voice": "...", "language": "..." }` entries
  whose speaker names occur in the text. `language` is optional on each
  `speech_config[]` item. It is not a top-level argument and is not written to
  `generation_config.language`.

The preview model currently documents 30 voices, one or two speakers, a 32k
context, and raw 24 kHz mono PCM output.

Debrute fixes `model` to `gemini-3.1-flash-tts-preview`, `store` to `false`,
and `response_format.type` to `audio`.

## Response

Debrute reads audio content from every exact
`steps[type="model_output"].content[type="audio"]` block and decodes its Base64
`data`. The returned raw PCM bytes remain a raw PCM artifact; Debrute does not
wrap them in WAV.

Google documents streaming speech output, but this exact executor uses one
completed Interactions response and has no SSE state machine. Forwarding an
unlisted streaming field would not make the streamed response supported.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "gemini-3-1-flash-tts-preview",
  "arguments": {
    "text": "Say warmly: Welcome to Debrute.",
    "speech_config": [
      {
        "voice": "Kore",
        "language": "en-US"
      }
    ]
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
