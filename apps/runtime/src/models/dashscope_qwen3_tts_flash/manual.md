# dashscope-qwen3-tts-flash

## Official sources

- https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
- https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
with `Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes `input.text`.
- `voice` is required and becomes `input.voice`.
- `language_type` is optional and becomes `input.language_type`. Valid values
  are `Auto`, `Chinese`, `English`, `German`, `Italian`, `Portuguese`,
  `Spanish`, `Japanese`, `Korean`, `French`, and `Russian`.

`qwen3-tts-flash` accepts at most 600 input characters. `Auto` is the remote
default and remains omitted unless the Agent selects a language explicitly.

Debrute fixes `model` to `qwen3-tts-flash`. Omitted optional values remain
absent.

## Response

Debrute requires `output.audio.url`, which points to a complete WAV file and is
valid for 24 hours. Runtime downloads it immediately and detects the stored
artifact type from its bytes.

This Model uses the non-streaming response and has no task-polling phase.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "dashscope-qwen3-tts-flash",
  "arguments": {
    "text": "Welcome to Debrute.",
    "voice": "Cherry"
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
