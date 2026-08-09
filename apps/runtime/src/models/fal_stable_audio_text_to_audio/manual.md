# fal-stable-audio-text-to-audio

## Official sources

- https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api
- https://fal.ai/docs/documentation/model-apis/inference/queue

Captured: 2026-08-09

## Endpoint and authentication

Debrute submits to `https://queue.fal.run/fal-ai/stable-audio-25/text-to-audio`
with `Authorization: Key <key>`, `Content-Type: application/json`, and
`X-Fal-No-Retry: 1`.

## Agent request fields

The remote Stable Audio 2.5 model can generate music or sound effects. Its
Debrute `Music` kind is a first-stage product classification, not a restriction
on the provider model's output content.

- `prompt` is required.
- `seconds_total`, `num_inference_steps`, `guidance_scale`, and `seed` are
  optional exact fields.
- `sync_mode` is optional. A returned Base64 audio `data:` URI is decoded
  directly by this exact executor.

Omitted optional values remain absent.

## Response and lifecycle

Debrute submits once, reads the documented queue status, and fetches the result
once after completion. The result `audio` is a File object; Debrute requires its
`url`, downloads an HTTP(S) value or decodes a Base64 audio data URI, and
detects the artifact media type from those bytes. Other File metadata is
optional.

## Debrute request

The default active music Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "fal-stable-audio-text-to-audio",
  "arguments": {
    "prompt": "Ambient downtempo music with soft pads.",
    "seconds_total": 20
  },
  "output": {
    "directory": "generated",
    "name": "stable-audio"
  }
}
```
