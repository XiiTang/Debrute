# grok-imagine

## Official sources

- https://www.vydra.ai/docs/models/grok-imagine
- https://docs.x.ai/developers/model-capabilities/images/generation?campaign=imagine-ads-generation

Captured: 2026-08-09

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

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "grok-imagine",
  "arguments": {
    "prompt": "A fast concept sketch of a futuristic city gateway",
    "aspect_ratio": "16:9"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
