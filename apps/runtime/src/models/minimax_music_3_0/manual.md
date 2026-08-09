# minimax-music-3-0

## Official sources

- https://platform.minimax.io/docs/api-reference/music-generation

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends `POST https://api.minimax.io/v1/music_generation` with
`Authorization: Bearer <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is composition guidance, at most 2000 characters. It is required for
  instrumental generation and optional for non-instrumental generation.
- `lyrics` is 1–3500 characters when supplied. Non-instrumental generation
  requires it unless `lyrics_optimizer: true` is allowed to generate lyrics
  from the prompt; instrumental generation does not require lyrics.
- `is_instrumental` is optional.
- `lyrics_optimizer` is optional.
- `audio_setting` is optional and uses the exact MiniMax `sample_rate`,
  `bitrate`, and `format` fields; documented formats are MP3, WAV, and PCM.
- `output_format` is optional and accepts `hex` or `url`.

Debrute fixes `model` to `music-3.0`. Omitted optional values remain absent.

## Response

For `output_format: "hex"`, Debrute requires and decodes the exact hex audio
field. For `output_format: "url"`, it requires and downloads the exact URL. An
omitted `output_format` follows MiniMax's current hex response behavior.

Remote `base_resp.status_code`, `status_msg`, and trace identity are retained
when MiniMax rejects the request.

MiniMax documents `stream: true`, with hex as the only supported streamed
output form. This exact Debrute executor handles only one completed JSON body;
it has no chunk state machine. Forwarding an unlisted `stream` field therefore
does not make streamed generation supported. A non-streaming URL expires after
24 hours and is downloaded immediately.

## Debrute request

The default active music Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "minimax-music-3-0",
  "arguments": {
    "prompt": "Upbeat technology demo music.",
    "is_instrumental": true
  },
  "output": {
    "directory": "generated",
    "name": "music"
  }
}
```
