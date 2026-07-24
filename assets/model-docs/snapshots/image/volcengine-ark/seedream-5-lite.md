---
models:
  - doubao-seedream-5-0-lite-260128
source_urls:
  - https://www.volcengine.com/docs/82379/1541523
  - https://www.volcengine.com/docs/82379/1824692
captured_at: 2026-07-21
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
- `image`: optional string array for input images. Each Agent value is a
  Project-relative image path, public HTTP(S) URL, or `data:image` URL. One
  reference still uses a one-element array. Runtime preserves an explicit empty
  array for provider validation rather than rejecting it or rewriting it as
  omission; every present element is resolved and sent in order.
- `size`: output size such as `2K`, `4K`, or explicit dimensions supported by the service.
- `output_format`: Seedream 5.0 Lite supports `png` and `jpeg`. Debrute
  materializes `png` as the normal lossless Project artifact format. The
  currently readable official contract does not state a stable omission
  default for this new field, so the value fixes a Project artifact property
  rather than copying an unambiguous provider default. Explicit `jpeg` remains
  available when the Agent prefers a smaller lossy file.
- `response_format`: `url` or `b64_json`; URL results are valid for 24 hours
  after image generation. Debrute materializes `url` for this model because
  Seedream can return high-resolution multi-image groups whose Base64 JSON can
  exceed Runtime's bounded model-JSON response. The official field is optional
  but its current reference does not state an explicit stable default, so this
  fixes Debrute's response transport rather than merely copying an unambiguous
  provider default. Runtime immediately downloads every URL into the Project,
  so the expiring URL is not the generated asset.
  Explicit `b64_json` remains supported: Runtime decodes the returned bytes,
  detects their real image MIME, and saves the same Project artifact shape. It
  never changes the requested format or retries after one format fails.
- `watermark`: boolean; `true` adds an AI-generated watermark and `false` omits it.
- `sequential_image_generation`: `disabled` for single image or `auto` for grouped image generation.
- `sequential_image_generation_options.max_images`: maximum number of images in group generation.
- `optimize_prompt_options.mode`: prompt optimization mode; `standard` is supported and `fast` is not supported for Seedream 5.0 Lite according to the API reference.

The optional `optimize_prompt_options` Agent object contains only a string
`mode` field. It has no Debrute default, does not accept `null`, and does not
accept arbitrary provider fields. The Agent manual recommends `standard`; a
different string reaches the remote endpoint for current model-business
validation rather than being rejected by a duplicated local enum.

The same structural rule applies to group configuration:
`sequential_image_generation` is an optional string without a default, and
`sequential_image_generation_options` is an optional object whose only exposed
field is integer `max_images`. Neither accepts `null` or arbitrary child fields.
Runtime leaves cross-field applicability and current value ranges to the
remote endpoint.

Seedream does not have a top-level `n` argument. Debrute exposes only the
official single/group controls above. It does not translate an `n` alias into
`max_images` or retain an obsolete parameter rejection layer; `n` is simply an
unknown field for this exact Debrute Model.

Debrute does not expose the provider's `stream` switch for this model. A Model
Operation publishes complete Project artifacts rather than partial remote
response events, so a stream flag would add no Agent capability. Runtime uses
one bounded non-streaming JSON response and does not maintain an SSE parser or
stream-to-buffer transition layer.

Debrute does not expose the provider's single-string image shorthand. The
array-only Agent shape covers both one and many references without a scalar-or-
array union or adapter fallback.

## Official example semantics

The official examples show the same endpoint for:

- text-to-image with `prompt`, `size`, `output_format`, `response_format`, and `watermark`
- image-to-image by adding an `image` value
- multi-image fusion by passing an `image` array and `sequential_image_generation: "disabled"`
- group generation by using `sequential_image_generation: "auto"` and `max_images`

Responses contain generated image records with either a URL or Base64 payload,
plus size and usage information. The Debrute `response_format` default for
`doubao-seedream-5-0-lite-260128` is `url`; this is a model-specific choice and
does not change the MiniMax `base64` default. Its `output_format` default is
`png`, and its `watermark` default is `false`. These three values are the
model's complete Debrute default set. Runtime identifies the real returned
image MIME from its bytes rather than blindly labeling the artifact from the
requested format.
