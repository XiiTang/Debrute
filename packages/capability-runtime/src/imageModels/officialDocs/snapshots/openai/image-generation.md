---
provider: openai
models:
  - gpt-image-1
  - gpt-image-2
source_urls:
  - https://developers.openai.com/api/docs/guides/image-generation
  - https://developers.openai.com/api/docs/models/gpt-image-1
  - https://developers.openai.com/api/docs/models/gpt-image-2
captured_at: 2026-05-31
source_type: official_docs
cleanup:
  - removed page chrome and footer text
  - removed SDK setup and raw provider command snippets
---

# OpenAI GPT Image models

OpenAI documents GPT Image as the image generation and editing family for text-to-image, image input, and image output workflows.

## Choosing the API

The Image API is the direct fit when an application needs to generate or edit a single image from one prompt. The Responses API is positioned for conversational, editable image experiences with GPT Image. Both APIs expose output controls such as `quality`, `size`, `format`, and compression. Transparent background support depends on the selected model.

## GPT Image 2

`gpt-image-2` is documented as OpenAI's state-of-the-art image generation model for fast, high-quality image generation and editing. It supports text and image input, image output, flexible sizes, and high-fidelity image inputs.

Documented endpoint support includes:

- Image generation: `v1/images/generations`
- Image edit: `v1/images/edits`
- Responses: `v1/responses`

`gpt-image-2` always processes image inputs at high fidelity. Image input tokens can therefore be higher for edit requests that include reference images.

Output controls for `gpt-image-2`:

- `size`: image dimensions, including `auto`.
- `quality`: `low`, `medium`, `high`, or `auto`.
- `output_format`: `png`, `jpeg`, or `webp`.
- `output_compression`: JPEG or WebP compression level from `0` to `100`.
- `background`: `opaque` or `auto`; transparent backgrounds are not supported by `gpt-image-2`.

Popular `gpt-image-2` sizes include `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, and `auto`.

Documented `gpt-image-2` size constraints:

- Maximum edge length must be no more than `3840px`.
- Both edges must be multiples of `16px`.
- Long edge to short edge ratio must not exceed `3:1`.
- Total pixels must be at least `655360` and no more than `8294400`.

## GPT Image 1

`gpt-image-1` is documented as a natively multimodal image model. It accepts both text and image inputs and produces image outputs. OpenAI describes it as the previous GPT Image generation model.

Documented endpoint support includes:

- Image generation: `v1/images/generations`
- Image edit: `v1/images/edits`
- Responses: `v1/responses`

`gpt-image-1` uses text input, image input, and image output. Common documented generation sizes are `1024x1024`, `1024x1536`, and `1536x1024`, with quality tiers `low`, `medium`, and `high`.

## Edits and image references

For edit requests, image inputs are reference images used with the prompt to produce the edited output. Masks are used when the edit should apply only to selected areas. When reference images are supplied, the request is an edit flow rather than a pure text-to-image generation.

Mask requirements for image edits:

- The mask must be the same format and size as the image being edited.
- The uploaded mask file must be less than 50MB.
- The mask image must contain an alpha channel.

## Limitations and moderation

OpenAI notes that GPT Image models can still struggle with exact text placement, recurring-character or brand consistency, and precise layout-sensitive composition. Prompts and generated images are filtered according to OpenAI policy. For GPT Image models, `moderation` can control strictness where the model supports that parameter.
