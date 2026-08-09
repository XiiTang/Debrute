# doubao-seedream-5-0-pro-260628

## Official sources

- https://www.volcengine.com/docs/82379/2582774
- https://www.volcengine.com/docs/82379/1541523

Captured: 2026-08-09

Volcengine Ark documents Seedream 5.0 Pro through the synchronous image
generation API. The endpoint is
`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`.

## Generation and editing modes

`doubao-seedream-5-0-pro-260628` supports text-to-image and prompt-directed
editing from one or more ordered reference images. The official limit is ten
input images. A prompt can describe an ordinary edit or target precise regions
using normalized `<point>x y</point>` and `<bbox>x1 y1 x2 y2</bbox>` coordinates
in the 0–999 range. A caller can also provide an image annotated with points,
boxes, arrows, freehand marks, or other visual guidance.

The model produces 1K or 2K images in PNG or JPEG. Its official documentation
also describes improved native text generation across fourteen additional
languages.

## Request fields

Official request fields used by Debrute:

- `model`: the exact Ark model id `doubao-seedream-5-0-pro-260628`.
- `prompt`: the text instruction for generation or editing. Region coordinates
  and their intended transformation belong in this instruction.
- `image`: an optional ordered string array. Each Agent value is an absolute or
  CLI-working-directory-relative local image path, safe public HTTP(S) URL, or
  `data:image` URL. A
  single reference uses a one-element array. Runtime resolves every present
  value and preserves its order. An explicit empty array is preserved for the
  remote endpoint to validate.
- `size`: an official 1K or 2K size label, or an explicit supported dimension.
  The provider currently defaults an omitted value to 2K; Debrute leaves this
  field absent unless the Agent chooses an output size.
- `output_format`: `png` or `jpeg`. Debrute materializes `png` as its normal
  lossless Model Artifact format.
- `response_format`: `url` or `b64_json`. Debrute materializes `url`; Runtime
  immediately downloads each result into the accepted output directory because
  an official result URL remains available for only 24 hours. When an Agent
  explicitly selects `b64_json`, Runtime decodes the returned bytes and detects
  their real image MIME before saving the same Model Artifact shape.
- `watermark`: boolean. Debrute materializes `false`, so the ordinary Model
  Artifact has no provider watermark.
- `optimize_prompt_options.mode`: optional prompt-optimization mode. Debrute
  does not materialize a mode; a supplied string reaches the remote endpoint
  for current model-business validation.

The understood `optimize_prompt_options` child is the string `mode` field.
Current child-field support, enum membership, and cross-field constraints
remain authoritative at the remote endpoint.

The Agent-facing image field is always an array. Debrute does not add a scalar
shorthand or a separate generation/edit action: omitting `image` means
text-to-image, while a present array supplies editing or reference-generation
inputs and the prompt states the intended result.

## Input and output constraints

The official input contract accepts image URLs or Base64 values and documents
JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC, and HEIF. Each input image must remain
under 30 MB and 36 megapixels. The service owns these current format, count,
dimension, ratio, and file-size business limits; Runtime owns local-media
classification, safe media resolution, and request-size safety.

For explicit output dimensions, the official contract documents a total-pixel
range beginning around 1280 by 720 and extending through 4,624,220 pixels, with
aspect ratios from 1:16 through 16:1. Debrute forwards a structurally valid
`size` string and preserves the provider's authoritative validation result.

Successful responses contain a non-empty `data` array whose items carry either
`url` or `b64_json` according to the canonical request. Runtime parses only the
selected transport, saves every returned image in provider order, and derives
the file extension from the downloaded or decoded image bytes. It does not
retry with another transport or output format.

## Debrute defaults

The complete Debrute default set for this model is:

- `output_format: "png"`
- `response_format: "url"`
- `watermark: false`

`size` and `optimize_prompt_options.mode` remain absent when the Agent does not
choose them. Unknown structurally safe top-level provider fields follow the
model's direct pass-through contract; the fields documented above are the
understood and recommended Agent surface.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "doubao-seedream-5-0-pro-260628",
  "arguments": {
    "prompt": "Create a bilingual campaign poster with precise small Chinese and English typography"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
