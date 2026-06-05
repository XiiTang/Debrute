---
models:
  - doubao-seedream-5-0-lite-260128
source_urls:
  - https://www.volcengine.com/docs/82379/1541523
  - https://www.volcengine.com/docs/82379/1824692
captured_at: 2026-05-31
source_type: official_docs
cleanup:
  - removed page chrome and debugging UI text
  - removed SDK setup and raw source API command snippets
---

# Doubao Seedream 5.0 Lite

Volcengine Ark documents Seedream 5.0 Lite through the image generation API. The API endpoint is `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`.

The official API reference describes one image generation endpoint for Seedream models. `doubao-seedream-5.0-lite`, Seedream 4.5, and Seedream 4.0 support single-image and multi-image input.

## Capabilities

When `sequential_image_generation` is `disabled`, the API generates one image. This supports:

- text-to-image: text prompt only
- single-image to image: one reference image plus text prompt
- multi-image to image: multiple reference images plus text prompt

When `sequential_image_generation` is `auto`, the API generates an associated group of images. The reference describes:

- text-to-image group generation, up to 15 images
- single-image to image group generation, up to 14 generated images
- multi-image to image group generation, with 2 to 14 reference images and reference plus output image count no more than 15

## Request fields

Official request fields used by Debrute:

- `model`: the Ark model id, including `doubao-seedream-5-0-260128` and the Lite id `doubao-seedream-5-0-lite-260128`.
- `prompt`: text instruction for generation or editing.
- `image`: optional string or string array for input images.
- `size`: output size such as `2K`, `4K`, or explicit dimensions supported by the service.
- `output_format`: Seedream 5.0 Lite supports `png` and `jpeg`.
- `response_format`: `url` or `b64_json`; URL results are valid for 24 hours after image generation.
- `watermark`: boolean; `true` adds an AI-generated watermark and `false` omits it.
- `sequential_image_generation`: `disabled` for single image or `auto` for grouped image generation.
- `sequential_image_generation_options.max_images`: maximum number of images in group generation.
- `stream`: enables streaming output for supported flows.
- `optimize_prompt_options.mode`: prompt optimization mode; `standard` is supported and `fast` is not supported for Seedream 5.0 Lite according to the API reference.

## Official example semantics

The official examples show the same endpoint for:

- text-to-image with `prompt`, `size`, `output_format`, `response_format`, and `watermark`
- image-to-image by adding an `image` value
- multi-image fusion by passing an `image` array and `sequential_image_generation: "disabled"`
- group generation by using `sequential_image_generation: "auto"` and `max_images`

Responses contain generated image records with either a URL or Base64 payload, plus size and usage information.
