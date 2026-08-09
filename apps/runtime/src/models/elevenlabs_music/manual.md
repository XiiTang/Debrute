# elevenlabs-music

## Official sources

- https://elevenlabs.io/docs/api-reference/music/compose
- https://elevenlabs.io/docs/eleven-api/guides/how-to/music/composition-plans

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.elevenlabs.io/v1/music` with
`xi-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is an optional text composition request.
- `composition_plan` is an optional ordered plan. Its `chunks` contain either
  generation chunks with `text`, `duration_ms`, `positive_styles`, optional
  `negative_styles`, `context_adherence`, `conditioning_ref`, and
  `condition_strength`; or audio-reference chunks with `song_id` and `range`.
- `music_length_ms` is optional for prompt-based generation.
- `seed`, `force_instrumental`, `store_for_inpainting`, and `sign_with_c2pa`
  are optional exact fields.
- `finetune_id` optionally selects an ElevenLabs music fine-tune.
- `output_format` is optional and becomes the exact query value.

Prompt-based and composition-plan input are alternatives. Prompt-based
generation accepts `music_length_ms` from 3,000 through 600,000 (3 seconds to
10 minutes). `seed` cannot be combined with `prompt`. C2PA signing applies to
MP3 output, and `force_instrumental` requests music without vocals.

Debrute fixes body `model_id` to `music_v2`. ElevenLabs validates the permitted
prompt/plan and conditional-field combinations.

When `output_format` is omitted, Debrute leaves it absent. The endpoint's
current v2 automatic result is `mp3_48000_192`; Debrute does not materialize
that remote default.

## Response

A successful request returns the complete audio body. Debrute stores it without
container conversion and retains the response `song-id` when present.

This Model uses the ordinary synchronous Compose response.

## Debrute request

The default active music Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "elevenlabs-music",
  "arguments": {
    "prompt": "Warm ambient electronic music for a product demo.",
    "music_length_ms": 30000
  },
  "output": {
    "directory": "generated",
    "name": "demo-music"
  }
}
```
