---
models:
  - grok-imagine
source_urls:
  - https://www.vydra.ai/docs/models/grok-imagine
  - https://docs.x.ai/developers/model-capabilities/images/generation?campaign=imagine-ads-generation
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed page chrome and unrelated model links
  - removed raw source API command snippets and SDK imports
---

# Grok Imagine via Vydra

Vydra documents `grok-imagine` as image and video generation powered by xAI's official Grok Imagine API. Debrute uses Vydra's API source for this model. Vydra states that image generation returns instantly with a result URL, while video jobs are asynchronous and require polling.

## Vydra endpoint

The source API endpoint is `POST /api/v1/models/grok-imagine` under Vydra's API base URL.

For image generation, Vydra documents the `text-to-image` sub-model:

- Credit cost: 8 credits.
- Behavior: generate images from text.
- Upstream model: `grok-imagine-image`.
- Processing: synchronous image result.

## Request body

Official Vydra request fields used by Debrute:

- `prompt`: required text description for generation, maximum 5000 characters.
- `model`: sub-model. Vydra documents `text-to-video` as default and `text-to-image` for image generation.
- `image_url`: optional for text-to-image and required for image-to-video.
- `aspect_ratio`: output aspect ratio. Documented values include `16:9`, `9:16`, `4:3`, `3:4`, `1:1`, `3:2`, and `2:3`.
- `duration`: video-only duration in seconds.

Successful synchronous image generation responses include a completed status,
credits charged, `imageUrl`, and `resultUrls`. Debrute consumes the documented
top-level `imageUrl` directly; image generation does not enter the video job
polling path.

## xAI image generation notes

xAI documents image generation from text prompts with Grok Imagine models. The xAI API supports batch generation of multiple images and control over aspect ratio and resolution.

Relevant xAI documented parameters include:

- `model`, such as `grok-imagine-image-quality` in the xAI API.
- `prompt`: text description.
- `n`: number of generated images.
- `aspect_ratio`: output ratio. Documented ratios include `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, and `auto`.

For Debrute `grok-imagine`, the exposed control surface is the documented Vydra
text-to-image shape with `prompt` and optional `aspect_ratio`. Debrute does not
expose xAI-upstream parameters that Vydra does not document for this endpoint.
