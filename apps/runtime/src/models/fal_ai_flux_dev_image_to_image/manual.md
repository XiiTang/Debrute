# fal-ai/flux/dev/image-to-image

## Official sources

- https://fal.ai/models/fal-ai/flux/dev/image-to-image/api

Captured: 2026-08-09

fal documents `fal-ai/flux/dev/image-to-image` as the image-to-image version of FLUX.1 [dev]. The endpoint is described as enabling rapid transformation of existing images, high-quality style transfers, and image modifications with core FLUX capabilities.

## Files

Input file fields accept hosted URLs or Base64 data URIs. Hosted URLs must be publicly accessible. Large Base64 data URIs can affect request performance.

## Input schema

`definition.json` describes the currently documented fal input shapes so an
Agent can screen and construct requests. It is not a local JSON Schema
rejection boundary. Except for resolving a string `image_url` into one provider
reference, this exact executor sends the complete `arguments` object to fal;
fal owns required-field, JSON-type, enum, range, `null`, and other request-shape
validation.

Documented input fields:

- `image_url`: required single string image reference. The Agent may provide an
  absolute or CLI-working-directory-relative local image path, public HTTP(S)
  URL, or `data:image` URI; Runtime resolves it to exactly one provider string.
  If the supplied value is not a string, the executor leaves it unchanged for
  fal to validate.

  A public URL needs no filename extension. Runtime validates its HTTP(S)
  target and public-network safety but does not prefetch it or infer media type
  from the URL path; fal validates the referenced content.
- `strength`: optional numeric strength of the initial image. Higher strength
  values are better for this model, and the provider default is `0.95`.
  Debrute leaves omission absent.
- `num_inference_steps`: optional integer number of inference steps, with
  provider default `40`. Debrute leaves omission absent.
- `prompt`: required string prompt to generate an image from.
- `seed`: optional integer. The same seed and same prompt with the same model
  version output the same image every time. Omission lets fal choose a random
  seed.
- `guidance_scale`: optional numeric CFG scale for how closely the model follows
  the prompt, with provider default `3.5`. Debrute leaves omission absent.
- `num_images`: number of generated images, with provider default `1`. Debrute
  does not duplicate that matching provider default in the canonical request.
  Omission remains absent; an explicit count remains explicit and reaches fal
  for current range validation.
- `enable_safety_checker`: optional boolean, with provider default `true`.
  Debrute leaves omission absent and preserves an explicit `false`.
- `output_format`: generated image format; possible values are `jpeg` and
  `png`, with provider default `jpeg`. Debrute does not duplicate that matching
  provider default in the canonical request. Omission remains absent; explicit
  `jpeg` or `png` remains explicit.
- `acceleration`: optional generation-speed string, with provider default
  `none`. Currently documented values are `none`, `regular`, and `high`;
  Debrute leaves omission absent and lets fal validate current values.
- `sync_mode`: optional boolean. When fal returns an image `data:` URI in this
  mode, the exact executor decodes it directly instead of issuing an HTTP
  download.

## Output schema

The output includes generated image records, timing information, the seed used, NSFW concept flags, and the prompt used for generation. Image records include `url`, `width`, `height`, and `content_type`.

Debrute requires a non-empty `images` array and a non-empty string `url` in
every returned image record. Runtime downloads every URL before committing the
Model Operation. It does not skip malformed records, search alternate response
fields, or commit a partial set when any record or download fails.

Neither `num_images` nor `output_format` has a Debrute default for this model.
Their provider defaults already produce the intended normal one-image JPEG
result, so omission remains visible as omission in the canonical request.

The normal response supplies HTTP image URLs, which Runtime downloads into the
accepted output directory. `sync_mode: true` may instead supply Base64 data
URIs; Runtime validates their image MIME and decodes them under the same
model-output size bound.

`definition.json` does not advertise `image_size` for this image-to-image
endpoint because it is not an official input field for this exact model; the
unrelated `ImageSize` type shown among fal's generated auxiliary types does not
make it a documented request argument. The executor does not maintain a local
field allowlist, so any explicitly supplied unknown field is still forwarded
and fal decides whether to accept it.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "fal-ai/flux/dev/image-to-image",
  "arguments": {
    "prompt": "Restyle this product photo as a glossy studio render",
    "image_url": "assets/product.png"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
