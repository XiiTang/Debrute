---
models:
  - wan2.7-image
source_urls:
  - https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference
captured_at: 2026-05-31
source_type: official_docs
cleanup:
  - removed page chrome and support widgets
  - removed raw source API command snippets
---

# Wan 2.7 image generation and editing

Aliyun Model Studio documents Wan 2.7 image models under the image generation and editing API. `wan2.7-image` is described as the faster Wan 2.7 image model. The same model family supports text-to-image, text-to-group-image, image-to-group-image, image editing, and multi-image reference generation.

## Invocation endpoints

The synchronous API returns results in one request:

- Beijing: `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- Singapore: `POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

Beijing and Singapore use independent API keys and request URLs.

## Request body

Official request body fields used by Debrute:

- `model`: `wan2.7-image` or `wan2.7-image-pro`.
- `input.messages`: an array of request messages. The current API supports a single round of conversation.
- `role`: fixed as `user`.
- `content`: message content array.
- `text`: prompt text. Chinese and English are supported. Prompt length is up to 5000 characters; excess content may be truncated.
- `image`: input image URL or Base64 data URL.
- `parameters`: optional model parameters.

Input image limits:

- Formats: JPEG, JPG, PNG without alpha channel, BMP, and WEBP.
- Width and height must each be in `[240, 8000]` pixels.
- Aspect ratio must be in `[1:8, 8:1]`.
- File size must not exceed 20MB.
- The request can pass 0 to 9 images.
- Multiple images are represented by multiple `image` objects in `content` order.
- Image values can be public HTTP or HTTPS URLs, or `data:{MIME_type};base64,{base64_data}` strings.

## Parameters

Documented parameters relevant to Debrute:

- `bbox_list`: optional bounding boxes for interactive editing. The list length must match the number of input images; pass `[]` for an image without boxes. A box is `[x1, y1, x2, y2]` in absolute pixels, and one image supports up to two boxes.
- `enable_sequential`: controls group image output. `false` is default; `true` enables group output.
- `size`: output resolution. For `wan2.7-image`, supported named sizes are `1K` and `2K`; explicit pixel dimensions are allowed when total pixels are in `[768*768, 2048*2048]` and aspect ratio is in `[1:8, 8:1]`.
- `n`: when group mode is disabled, number of images in `[1, 4]`; when group mode is enabled, maximum generated image count in `[1, 12]`.
- `thinking_mode`: boolean, default `true`; applies when group mode is disabled and there is no image input.
- `watermark`: boolean; `false` omits the watermark and `true` adds an "AI generated" mark.
- `seed`: integer in `[0, 2147483647]`; same seed can make generated content relatively stable, but exact repeatability is not guaranteed.

## Response

A successful response includes `output.choices`, each with an assistant message whose `content` array contains generated `image` entries. Task data such as generated image URLs is retained for 24 hours and should be saved promptly.
