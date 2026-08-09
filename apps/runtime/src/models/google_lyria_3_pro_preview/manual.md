# google-lyria-3-pro-preview

## Official sources

- https://ai.google.dev/gemini-api/docs/music-generation
- https://ai.google.dev/api/interactions-api

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is required.
- `image` is an optional ordered array of at most ten absolute or
  CLI-working-directory-relative local image paths, public HTTP(S) URLs, or
  `data:image` URIs.
- `format` is optional and selects `mp3` or `wav`.

Debrute builds typed text and image input blocks, fixes `model` to
`lyria-3-pro-preview`, and fixes `store` to `false`. An omitted `format` remains
absent.

The official output is 44.1 kHz stereo MP3 or WAV with SynthID. Pro generations
are about several minutes long and are guided by prompt content and timestamps;
there is no numeric `duration` argument. This is a single-turn generation
model.

## Response

Debrute reads exact `steps[type="model_output"]` content, decodes every audio
block, and retains model-output text. Generated audio bytes are stored without
container conversion.

This Model uses one completed Interactions response.

## Debrute request

The default active music Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "google-lyria-3-pro-preview",
  "arguments": {
    "prompt": "Cinematic orchestral underscore with hopeful momentum.",
    "format": "wav"
  },
  "output": {
    "directory": "generated",
    "name": "music"
  }
}
```
