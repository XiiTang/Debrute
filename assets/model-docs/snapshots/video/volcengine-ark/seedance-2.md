---
models:
  - doubao-seedance-2-0-260128
source_urls:
  - https://www.volcengine.com/docs/82379/2291680
  - https://www.volcengine.com/docs/82379/1520757
  - https://www.volcengine.com/docs/82379/1521309
  - https://www.volcengine.com/docs/82379/1159178
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed navigation and footer text
  - removed duplicated page chrome
  - kept Seedance 2.0 model ids, task endpoints, input forms, and output fields
---

# Doubao Seedance 2.0 Video Generation

This manual describes only Debrute Model `doubao-seedance-2-0-260128`, whose
exact remote model id is the same value. Use it when quality and 1080p output
matter.

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

Debrute does not expose the official `content` array in its CLI. Debrute Agents provide `prompt`, `intent`, and `references`; Debrute constructs Seedance `content` internally.

## Core Parameters

Seedance 2.0 request parameters include ratio, resolution, duration, frame controls, seed, fixed-camera control, watermark control, generated audio, callback URL, safety identifier, and task-expiration controls. Debrute exposes these as Debrute video arguments where the selected model supports them.

The supported ratios include `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, and `adaptive`.

This Model supports `480p`, `720p`, and `1080p`.

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

Project-local video files require a Debrute upload service that returns a Seedance-reachable URL. Without that service, Debrute returns `video_reference_upload_unavailable` before creating a Seedance task.
