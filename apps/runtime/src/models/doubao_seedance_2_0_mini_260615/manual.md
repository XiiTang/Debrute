# doubao-seedance-2-0-mini-260615

## Official sources

- https://www.volcengine.com/docs/82379/2291680
- https://www.volcengine.com/docs/82379/2298881
- https://www.volcengine.com/docs/82379/1520757
- https://www.volcengine.com/docs/82379/1521309
- https://www.volcengine.com/docs/82379/1159178

Captured: 2026-08-09

The exact remote model id is `doubao-seedance-2-0-mini-260615`. This endpoint
supports `480p` and `720p` output, not `1080p`.

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

- `source`: required string containing an absolute or
  CLI-working-directory-relative local path, data URI, public HTTP(S) URL, or
  Ark `asset://` URL.
- `media_type`: optional `image`, `video`, or `audio`. When omitted, Debrute
  infers it from a supported data URI or file extension.

Any other reference child field is rejected before task submission. Supported
Local image and audio references are encoded inline. Public HTTP(S) and Ark
`asset://` references remain URLs. A local or inline video cannot be
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
combinations, and other current business rules.

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

## Debrute request

The default active video Model request timeout is 30 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seedance-2-0-mini-260615",
  "arguments": {
    "prompt": "A low-cost product teaser with synchronized ambient audio",
    "resolution": "720p",
    "ratio": "16:9",
    "duration": 5,
    "generate_audio": true
  },
  "output": {
    "directory": "generated",
    "name": "video"
  }
}
```
