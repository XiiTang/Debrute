---
models:
  - fal-ai/flux/dev/image-to-image
source_urls:
  - https://fal.ai/models/fal-ai/flux/dev/image-to-image/api
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed page chrome and footer links
  - removed client installation, SDK imports, and raw source API command snippets
---

# fal-ai/flux/dev/image-to-image

fal documents `fal-ai/flux/dev/image-to-image` as the image-to-image version of FLUX.1 [dev]. The endpoint is described as enabling rapid transformation of existing images, high-quality style transfers, and image modifications with core FLUX capabilities.

## Files

Input file fields accept hosted URLs or Base64 data URIs. Hosted URLs must be publicly accessible. Large Base64 data URIs can affect request performance.

## Input schema

Official input fields used by Debrute:

- `image_url`: required single string image reference. The Agent may provide a
  Project-relative image path, public HTTP(S) URL, or `data:image` URI; Runtime
  resolves it to exactly one provider string. Arrays, objects, and `null` are
  not alternate input shapes.

  A public URL needs no filename extension. Runtime validates its HTTP(S)
  target and public-network safety but does not prefetch it or infer media type
  from the URL path; fal validates the referenced content.
- `strength`: optional numeric strength of the initial image. Higher strength
  values are better for this model, and the provider default is `0.95`.
  Debrute leaves omission absent and does not accept `null` as an alternate
  Agent shape.
- `num_inference_steps`: optional integer number of inference steps, with
  provider default `40`. Debrute leaves omission absent and does not accept
  `null` as an alternate Agent shape.
- `prompt`: required string prompt to generate an image from.
- `seed`: optional integer. The same seed and same prompt with the same model
  version output the same image every time. Omission lets fal choose a random
  seed; strings and `null` are not accepted as alternate Agent shapes.
- `guidance_scale`: optional numeric CFG scale for how closely the model follows
  the prompt, with provider default `3.5`. Debrute leaves omission absent and
  does not accept `null` as an alternate Agent shape.
- `num_images`: number of generated images, with provider default `1`. Debrute
  does not duplicate that matching provider default in the canonical request.
  Omission remains absent; an explicit count remains explicit and reaches fal
  for current range validation.
- `enable_safety_checker`: optional boolean, with provider default `true`.
  Debrute leaves omission absent, preserves an explicit `false`, and does not
  accept `null` as an alternate Agent shape.
- `output_format`: generated image format; possible values are `jpeg` and
  `png`, with provider default `jpeg`. Debrute does not duplicate that matching
  provider default in the canonical request. Omission remains absent; explicit
  `jpeg` or `png` remains explicit.
- `acceleration`: optional generation-speed string, with provider default
  `none`. Currently documented values are `none`, `regular`, and `high`;
  Debrute leaves omission absent, lets fal validate current values, and does not
  accept `null` as an alternate Agent shape.

## Output schema

The output includes generated image records, timing information, the seed used, NSFW concept flags, and the prompt used for generation. Image records include `url`, `width`, `height`, and `content_type`.

Debrute requires a non-empty `images` array and a non-empty string `url` in
every returned image record. Runtime downloads every URL before committing the
Model Operation. It does not skip malformed records, search alternate response
fields, or commit a partial set when any record or download fails.

Neither `num_images` nor `output_format` has a Debrute default for this model.
Their provider defaults already produce the intended normal one-image JPEG
result, so omission remains visible as omission in the canonical request.

Debrute does not expose fal's `sync_mode` transport switch. The normal endpoint
response supplies HTTP image URLs, which Runtime downloads into the Project.
Debrute neither requests nor decodes the alternate data-URI response shape.

Debrute also does not expose `image_size` for this image-to-image endpoint. It
is not an official input field for this exact model; the unrelated `ImageSize`
type shown among fal's generated auxiliary types does not make it a request
argument.
