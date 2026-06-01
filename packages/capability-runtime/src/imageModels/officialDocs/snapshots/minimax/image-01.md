---
provider: minimax
models:
  - image-01
source_urls:
  - https://platform.minimax.io/docs/api-reference/image-generation-t2i
  - https://platform.minimax.io/docs/api-reference/image-generation-i2i
  - https://platform.minimax.io/docs/guides/image-generation
captured_at: 2026-05-31
source_type: official_docs
cleanup:
  - removed page chrome and duplicated documentation index text
  - removed raw provider command snippets
---

# MiniMax image-01

MiniMax documents Image Generation as supporting generation from text or references, with custom aspect ratios and resolutions. `image-01` is described as a high-quality image generation model that produces fine-grained details and supports both text-to-image and image-to-image generation with subject references for people.

## Endpoint

The documented image generation endpoint is `POST https://api.minimax.io/v1/image_generation`.

## Text-to-image

The text-to-image API generates images from text input. Official request fields used by AXIS:

- `model`: `image-01`.
- `prompt`: required text description, maximum 1500 characters.
- `aspect_ratio`: output ratio. Default is `1:1`.
- `width` and `height`: pixel dimensions for `image-01`; both must be set together, range `[512, 2048]`, divisible by 8. When both `width`/`height` and `aspect_ratio` are present, `aspect_ratio` has priority.
- `response_format`: `url` or `base64`; URL output expires in 24 hours.
- `seed`: integer seed. Same seed and parameters can reproduce images; when omitted, a random seed is generated for each image.
- `n`: number of images, range `[1, 9]`, default `1`.
- `prompt_optimizer`: boolean automatic prompt optimization.

Documented aspect ratio options:

- `1:1` -> `1024x1024`
- `16:9` -> `1280x720`
- `4:3` -> `1152x864`
- `3:2` -> `1248x832`
- `2:3` -> `832x1248`
- `3:4` -> `864x1152`
- `9:16` -> `720x1280`
- `21:9` -> `1344x576`

## Image-to-image

The image-to-image API generates images from image input. It uses the same endpoint and includes `subject_reference`.

Official image-to-image request fields used by AXIS:

- `model`: `image-01` or `image-01-live` in the provider API; AXIS exposes `image-01`.
- `prompt`: required text description, maximum 1500 characters.
- `subject_reference`: object array for image-to-image generation.
- `aspect_ratio`, `width`, `height`, `response_format`, `seed`, `n`, and `prompt_optimizer` as in text-to-image.

Subject references use objects with fields such as `type: "character"` and `image_file` pointing to the reference image.

## Response

Successful responses include a trace `id`, a `data` object with generated image URLs or Base64 data depending on `response_format`, `metadata` with success and failure counts, and `base_resp` status information.
