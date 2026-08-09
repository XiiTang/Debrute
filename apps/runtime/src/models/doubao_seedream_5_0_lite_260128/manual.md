# doubao-seedream-5-0-lite-260128

## Official sources

- https://www.volcengine.com/docs/82379/1541523
- https://www.volcengine.com/docs/82379/1824692

Captured: 2026-08-09

Volcengine Ark documents Seedream 5.0 Lite through the image generation API. The API endpoint is `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`.

The official API reference describes one image generation endpoint for Seedream models. `doubao-seedream-5.0-lite`, Seedream 4.5, and Seedream 4.0 support single-image and multi-image input.

## Generation modes and count limits

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
- `image`: optional string array for input images. Each Agent value is an
  absolute or CLI-working-directory-relative local image path, public HTTP(S)
  URL, or `data:image` URL. One
  reference still uses a one-element array. Runtime preserves an explicit empty
  array for provider validation rather than rejecting it or rewriting it as
  omission; every present element is resolved and sent in order.
- `size`: output size such as `2K`, `4K`, or explicit dimensions supported by the service.
- `output_format`: Seedream 5.0 Lite supports `png` and `jpeg`. Debrute
  materializes `png` as the normal lossless Model Artifact format. The
  currently readable official contract does not state a stable omission
  default for this new field, so the value fixes a Model Artifact property
  rather than copying an unambiguous provider default. Explicit `jpeg` remains
  available when the Agent prefers a smaller lossy file.
- `response_format`: `url` or `b64_json`; URL results are valid for 24 hours
  after image generation. Debrute materializes `url` for this model because
  Seedream can return high-resolution multi-image groups whose Base64 JSON can
  exceed Runtime's bounded model-JSON response. The official field is optional
  but its current reference does not state an explicit stable default, so this
  fixes Debrute's response transport rather than merely copying an unambiguous
  provider default. Runtime immediately downloads every URL into the accepted
  output directory, so the expiring URL is not the Model Artifact.
  Explicit `b64_json` remains supported: Runtime decodes the returned bytes,
  detects their real image MIME, and saves the same Model Artifact shape. It
  never changes the requested format or retries after one format fails.
- `watermark`: boolean; `true` adds an AI-generated watermark and `false` omits it.
- `sequential_image_generation`: `disabled` for single image or `auto` for grouped image generation.
- `sequential_image_generation_options.max_images`: maximum number of images in group generation.
- `optimize_prompt_options.mode`: prompt optimization mode; `standard` is supported and `fast` is not supported for Seedream 5.0 Lite according to the API reference.

The understood `optimize_prompt_options` child is the string `mode` field. It
has no Debrute default. Other structurally safe child fields pass through
unchanged; their presence is not evidence that Debrute has verified them.

The same structural rule applies to group configuration:
`sequential_image_generation` is an optional string without a default, and
`sequential_image_generation_options` is an optional object whose understood
field is integer `max_images` in the range 1 through 15. Other structurally
safe child fields pass through unchanged. Runtime leaves cross-field
applicability to the remote endpoint.

Seedream does not have a top-level `n` argument. Debrute does not translate an
`n` alias into `max_images`; an unlisted field is forwarded unchanged and the
remote endpoint remains authoritative.

Runtime uses one bounded non-streaming JSON response and does not maintain an
SSE parser or stream-to-buffer transition layer. A structurally safe `stream`
field can pass through, but the exact executor cannot correctly process the
streaming response shape; pass-through is not streaming support.

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
is materialized by Debrute rather than inherited from the remote endpoint. Its
`output_format` default is `png`, and its `watermark` default is `false`. These
three values are the model's complete Debrute default set. Runtime identifies
the real returned image MIME from its bytes rather than blindly labeling the
artifact from the requested format.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seedream-5-0-lite-260128",
  "arguments": {
    "prompt": "A bilingual product poster with clean Chinese and English headline text"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
