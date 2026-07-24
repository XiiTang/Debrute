---
models:
  - doubao-seedance-2-0-mini-260615
source_urls:
  - https://www.volcengine.com/docs/82379/2291680
  - https://www.volcengine.com/docs/82379/2298881
  - https://www.volcengine.com/docs/82379/1520757
  - https://www.volcengine.com/docs/82379/1521309
  - https://www.volcengine.com/docs/82379/1159178
captured_at: 2026-07-23
source_type: official_docs
cleanup:
  - removed navigation, unrelated models, SDK boilerplate, and alternate task APIs
  - retained the current Mini model id, task lifecycle, media roles, and output fields
---

# Doubao Seedance 2.0 Mini Video Generation

This manual describes only Debrute Model
`doubao-seedance-2-0-mini-260615`, whose exact remote model id is the same
value. Mini is the lowest-cost Seedance 2.0 tier and supports `480p` and
`720p` output.

## Endpoint and lifecycle

Debrute creates one asynchronous task with:

```text
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
```

It polls only:

```text
GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{task_id}
```

A successful task supplies `content.video_url`. When `return_last_frame` is
true, the response may also supply `content.last_frame_url`. Debrute downloads
the primary MP4 and, when present, the optional last-frame image before the
generation result is committed.

## Debrute request contract

Debrute does not expose the provider `content` array. Agents provide a required
`prompt`, a required materialized `intent`, and optional ordered `references`.
The adapter has no fallback intent.

Each reference is a closed object with only:

- `source`: required string containing a Project path, data URI, public HTTP(S)
  URL, or Ark `asset://` URL.
- `media_type`: optional `image`, `video`, or `audio`. When omitted, Debrute
  infers it from a supported data URI or file extension.

Any other reference child field is rejected before task submission. Supported
Project image and audio references are encoded inline. Public HTTP(S) and Ark
`asset://` references remain URLs. A Project-local or inline video cannot be
made model-reachable by this adapter and fails with
`video_reference_upload_unavailable` before task submission.

## Intent and official media roles

The current remote contract documents these ordinary intent/reference
combinations:

- `generate` with no references is text-to-video.
- `generate` with one image uses `first_frame`.
- `generate` with two images uses `first_frame` and `last_frame` in order.
- `reference` uses `reference_image`, `reference_video`, and
  `reference_audio` according to each reference media type.
- `audio_driven` uses one audio reference and at most one image or video; the
  same current `reference_*` roles are used.
- `extend` requires video reference input and uses `reference_video` together
  with the prompt.
- `edit` requires reference input and uses the corresponding current
  `reference_*` roles together with the prompt.

Runtime performs only the structural mapping it owns: for `generate`, the first
image becomes `first_frame` and later images become `last_frame`; other
reference media and the other supported Debrute intent values use the
corresponding `reference_*` role. Runtime rejects an unrecognized Debrute
intent because it cannot transform it without guessing; the remote endpoint
remains authoritative for non-empty content, reference cardinality, media
combinations, and other current business rules. The Mini contract does not emit
legacy `segment`, `source_video`,
`driver_audio`, or `mask` roles.

## Exposed provider fields

In addition to Debrute's `prompt`, `intent`, and `references`, this Model
exposes:

- `generate_audio`
- `tools`
- `return_last_frame`
- `resolution`
- `ratio`
- `duration`
- `watermark`

Mini supports `480p` and `720p`, the documented ratios `16:9`, `4:3`, `1:1`,
`3:4`, `9:16`, `21:9`, and `adaptive`, and duration values from 4 through 15
seconds or `-1` for model-selected duration.

The adapter removes only Debrute-owned routing fields, constructs `content`,
sets the exact remote `model`, and passes through other top-level provider
fields it receives. It does not add a local business-rule rejection for a
`web_search` tool combined with references; the provider remains authoritative
for that combination.

## Output

The completed `content.video_url` becomes the `PrimaryVideo` artifact. When
requested and returned, `content.last_frame_url` becomes the optional
`LastFrame` artifact.
