# doubao-seed-tts-2-0

## Official sources

- https://www.volcengine.com/docs/82379/2516286
- https://www.volcengine.com/docs/6561/1598757
- https://www.volcengine.com/docs/6561/2228192?lang=zh

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
with `X-Api-Key: <key>`, `X-Api-Resource-Id: seed-tts-2.0`, a UUID
`X-Api-Request-Id`, and `Content-Type: application/json`.

## Agent request fields

- `text` is required and becomes `req_params.text`.
- `speaker` is required and becomes `req_params.speaker`.
- `audio_params` is optional and may contain exact `format`, `sample_rate`,
  `bit_rate`, `emotion`, `emotion_scale`, `speech_rate`, and `loudness_rate`
  fields.

For this chunked Model, exposed audio formats are `mp3`, `ogg_opus`, and raw
`pcm`. Omitted optional values remain absent.

The official Seed TTS 2.0 and V3 parameter pages are dynamic and updated
independently. Speaker, language, and text-length availability must therefore
be checked against the current voice page for the configured account and
region; this manual does not infer a stable closed enum from an older snapshot.

## Response

Debrute continuously deserializes the HTTP body as JSON objects. A frame with
`code: 0` may carry Base64 audio or progress; `code: 20000000` completes the
request. Decoded audio chunks are concatenated in response order. Raw PCM
remains raw PCM.

A different frame code is a remote business error. Debrute retains its message
and the response `X-Tt-Logid`.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seed-tts-2-0",
  "arguments": {
    "text": "Welcome to Debrute.",
    "speaker": "zh_female_vv_uranus_bigtts"
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
