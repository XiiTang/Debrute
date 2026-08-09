# fal-stable-audio-3-small-sfx

## Official sources

- https://fal.ai/models/fal-ai/stable-audio-3/small/sfx/text-to-audio/api
- https://fal.ai/docs/documentation/model-apis/inference/queue

Captured: 2026-08-09

## Endpoint and authentication

Debrute submits to
`https://queue.fal.run/fal-ai/stable-audio-3/small/sfx/text-to-audio` with
`Authorization: Key <key>`, `Content-Type: application/json`, and
`X-Fal-No-Retry: 1`.

## Agent request fields

- `prompt` is required.
- `negative_prompt`, `duration`, `num_inference_steps`, `guidance_scale`, and
  `seed` are optional.
- `enable_prompt_expansion` and `enable_safety_checker` are optional.
- `output_format` is optional and accepts `mp3`, `wav`, `flac`, `ogg`, `opus`,
  `m4a`, or `aac`.
- `bitrate` is an optional string such as `192k`; it is not an integer.
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

The default active sound-effect Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "fal-stable-audio-3-small-sfx",
  "arguments": {
    "prompt": "A distant sci-fi door opening with a soft hydraulic hiss.",
    "duration": 4
  },
  "output": {
    "directory": "generated",
    "name": "sound-effect"
  }
}
```
