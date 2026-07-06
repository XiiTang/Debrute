---
models:
  - fal-stable-audio-text-to-audio
  - fal-stable-audio-sfx
source_urls:
  - https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio
  - https://fal.ai/models/fal-ai/stable-audio-25/text-to-audio/api
  - https://fal.ai/models/fal-ai/stable-audio-3/medium/base/text-to-audio/api
  - https://fal.ai/docs/documentation/model-apis/inference/queue
captured_at: 2026-07-06
cleanup:
  - removed navigation, login chrome, marketplace cards, and unrelated model pages
---

# Official fal Stable Audio Contract

## Endpoint

Debrute sends `POST https://queue.fal.run/{model}` where `{model}` is `fal-ai/stable-audio-25/text-to-audio` or `fal-ai/stable-audio-3/medium/base/text-to-audio`.

## Authentication

Debrute sends `Authorization: Key <key>` and `Content-Type: application/json`.

## Request fields

For `fal-stable-audio-text-to-audio`:

- `prompt`: Debrute `prompt`.
- `seconds_total`: Debrute `duration_seconds` when provided.
- `seed`: Debrute `seed` when provided.

For `fal-stable-audio-sfx`:

- `prompt`: Debrute `prompt`.
- `duration`: Debrute `duration_seconds` when provided.
- `output_format`: Debrute `format` when provided.
- `seed`: Debrute `seed` when provided.
- `negative_prompt`: Debrute `negative_prompt` when provided.

## Response fields

Submit response:

- `request_id`: fal task id.
- `status_url`: URL Debrute polls for task status.
- `response_url`: URL Debrute reads after successful completion.

Status response:

- `status`: `IN_QUEUE`, `IN_PROGRESS`, or `COMPLETED`.
- `response_url`: result URL when the task is complete.
- `error`: task failure message when `status` is `COMPLETED` and the model failed.

Result response for `fal-stable-audio-text-to-audio`:

- `audio`: downloadable audio URL string.

Result response for `fal-stable-audio-sfx`:

- `audio.url`: downloadable audio URL.
- `audio.content_type`: MIME string required by Debrute.

## Audio encoding

Debrute downloads the result audio URL through the public remote URL policy and stores the downloaded bytes.

## MIME type

Debrute uses `audio.content_type` for `fal-stable-audio-sfx`. Debrute uses `audio/wav` for `fal-stable-audio-text-to-audio`.

## Task lifecycle

Debrute submits a queue task, polls `status_url` until `COMPLETED`, maps `COMPLETED` plus `error` to `audio_task_failed`, maps exhausted polling attempts to `audio_task_timeout`, then fetches `response_url`.
