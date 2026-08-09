# doubao-seedance-2-0-260128

## Official sources

- https://www.volcengine.com/docs/82379/2291680
- https://www.volcengine.com/docs/82379/1520757
- https://www.volcengine.com/docs/82379/1521309
- https://www.volcengine.com/docs/82379/1159178

Captured: 2026-08-09

The exact remote model id is `doubao-seedance-2-0-260128`.

## Task API

Seedance video generation creates an asynchronous task with the Ark content-generation endpoint:

```text
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
```

Tasks are queried with:

```text
GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}
```

Successful task responses include generated media under `content.video_url`. When the request asks for the last frame and the model returns it, the response may include `content.last_frame_url`.

## Inputs

Seedance accepts a text prompt and optional media references in the task `content` array. Media references use image, video, and audio URL forms documented by Ark. Publicly reachable URLs and Ark `asset://` references are accepted for video references. Image and audio inputs may use supported data URL forms when documented for the selected mode.

Debrute does not expose the official `content` array in its CLI. Debrute Agents provide `prompt`, `intent`, and `references`; Debrute constructs Seedance `content` internally. The request boundary materializes the default `intent: "generate"`; the adapter requires that canonical value and has no fallback intent.

Each `references` item is an object with a required `source` and an optional
`media_type`. The supported `media_type` values are `image`, `video`, `audio`,
and `mask`; when omitted, Debrute infers the type from `source`. No other nested
fields are accepted because Debrute transforms each item into typed Seedance
content and cannot forward additional children losslessly.

## Core Parameters

Seedance 2.0 request parameters include ratio, resolution, duration, frame controls, seed, fixed-camera control, watermark control, generated audio, callback URL, safety identifier, and task-expiration controls. Debrute exposes these as Debrute video arguments where the selected model supports them.

The supported ratios include `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, and `adaptive`.

This Model supports `480p`, `720p`, and `1080p`.
`duration` accepts 4 through 15 seconds, or `-1` to let Seedance select the
duration.

This Debrute Model materializes `watermark: false`. This states that its normal
generated video artifact is explicitly free of an optional
provider watermark instead of depending on a provider, regional, or regulatory
default. An explicit Agent `watermark: true` remains supported. If the remote
endpoint rejects `false`, Runtime returns its original redacted error; it does
not change the value or retry the paid generation request.

## Debrute mapping

Debrute owns media routing:

- `generate` with no references becomes text-to-video.
- `generate` with one image becomes first-frame generation.
- `generate` with two images becomes first-frame and last-frame generation.
- `reference` infers all-purpose image, video, audio, and mixed reference modes from media types.
- `audio_driven` maps one audio reference to the driver-audio role.
- `extend` maps video references to extension or stitching inputs.

Local video files require a Debrute upload service that returns a
Seedance-reachable URL. Without that service, Debrute returns
`video_reference_upload_unavailable` before creating a Seedance task.

## Debrute request

The default active video Model request timeout is 30 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seedance-2-0-260128",
  "arguments": {
    "prompt": "A quiet product launch video with slow camera movement and synchronized ambient audio.",
    "intent": "generate",
    "references": [],
    "resolution": "1080p",
    "ratio": "16:9",
    "duration": 5,
    "generate_audio": true,
    "watermark": false
  },
  "output": {
    "directory": "generated",
    "name": "video"
  }
}
```
