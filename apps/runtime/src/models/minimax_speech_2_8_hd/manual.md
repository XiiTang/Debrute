# minimax-speech-2-8-hd

## Official sources

- https://platform.minimax.io/docs/api-reference/speech-t2a-http
- https://platform.minimax.io/docs/guides/models-intro

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.minimax.io/v1/t2a_v2` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `text` is required.
- `voice_setting` is required and contains exact `voice_id` plus optional
  `speed`, `vol`, `pitch`, `text_normalization`, and `latex_read` fields.
- `audio_setting` is optional and may contain exact `sample_rate`, `bitrate`,
  `format`, `channel`, and `force_cbr` fields.
- `emotion`, `language_boost`, `pronunciation_dict`, and `voice_modify` are
  optional exact fields.
- `subtitle_enable` and `subtitle_type` are optional.
- `output_format` is optional and accepts the provider response forms `hex` or
  `url`.

`text` must contain fewer than 10,000 characters. `speech-2.8-hd` supports 40
languages, 300+ system or cloned voices, and the documented inline interjection
tags such as `(laughs)`, `(coughs)`, and `(sighs)`. Current audio formats are
MP3, PCM, FLAC, WAV, raw or WAV-wrapped G.711 μ-law (`pcmu_raw` /
`pcmu_wav`), and Ogg/Opus. WAV is available only for non-streaming responses.

Debrute fixes `model` to `speech-2.8-hd` and sends the synchronous HTTP request.
Omitted optional values remain absent.

## Response

For `output_format: "hex"`, Debrute requires and decodes the exact hex audio
field. For `output_format: "url"`, it requires and downloads the exact URL. An
omitted `output_format` follows MiniMax's current hex response behavior.

Remote `base_resp.status_code`, `status_msg`, and trace identity are retained
when MiniMax rejects the request. Returned raw encodings remain raw.

MiniMax documents `stream` and `stream_options`, but this exact Debrute executor
handles only one completed JSON body and has no streaming chunk state machine.
Forwarding those unlisted fields does not make streaming supported. A returned
URL is valid for 24 hours and is downloaded immediately.

## Debrute request

The default active tts Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "minimax-speech-2-8-hd",
  "arguments": {
    "text": "Welcome to Debrute.",
    "voice_setting": {
      "voice_id": "male-qn-qingse"
    }
  },
  "output": {
    "directory": "generated",
    "name": "speech"
  }
}
```
