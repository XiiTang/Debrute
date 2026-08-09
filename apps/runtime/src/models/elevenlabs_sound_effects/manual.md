# elevenlabs-sound-effects

## Official sources

- https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/sound-generation` with
`xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `duration_seconds`, `loop`, `prompt_influence`, and `output_format` are
  optional exact fields.

`duration_seconds` ranges from 0.5 through 30 seconds and
`prompt_influence` ranges from 0 through 1. `loop` applies to the fixed v2
model used here. Available output encodings can depend on the ElevenLabs
subscription tier.

Debrute fixes body `model_id` to `eleven_text_to_sound_v2`. Omitted optional
values remain absent.

## Response

A successful request returns the complete generated audio body, which Debrute
stores without container conversion.

This Model uses one synchronous response.

## Debrute request

The default active sound-effect Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "elevenlabs-sound-effects",
  "arguments": {
    "text": "A clean futuristic notification chime.",
    "duration_seconds": 2
  },
  "output": {
    "directory": "generated",
    "name": "chime"
  }
}
```
