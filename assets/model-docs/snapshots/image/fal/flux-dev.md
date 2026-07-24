---
models:
  - fal-ai/flux/dev
source_urls:
  - https://fal.ai/models/fal-ai/flux/dev/api
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed page chrome and footer links
  - removed client installation, SDK imports, and raw source API command snippets
---

# fal-ai/flux/dev

fal documents `fal-ai/flux/dev` as FLUX.1 [dev] text-to-image. The model is described as a 12 billion parameter flow transformer that generates high-quality images from text and is suitable for personal and commercial use.

## Files

Some fal model attributes accept file URLs. fal documents hosted URLs and Base64 data URIs as accepted file input forms. Hosted URLs must be publicly accessible. Large Base64 data URIs can affect request performance.

## Input schema

Official input fields used by Debrute:

- `prompt`: required string prompt to generate an image from.
- `image_size`: generated image size, with provider default `landscape_4_3`.
  Debrute does not duplicate this creative geometry choice in the canonical
  request. Omission remains absent; an explicit preset or custom size remains
  explicit.
- `num_inference_steps`: optional integer number of inference steps, with
  provider default `28`. Debrute leaves omission absent and does not accept
  `null` as an alternate Agent shape.
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

`image_size` enum values:

- `square_hd`
- `square`
- `portrait_4_3`
- `portrait_16_9`
- `landscape_4_3`
- `landscape_16_9`

For custom image sizes, fal accepts an object whose supported fields are
integer `width` and integer `height`. Debrute validates the names and JSON types
of fields that are present, while fal validates current pairing and dimension
rules. Debrute does not materialize either field's provider default.

## Output schema

The output includes:

- `images`: generated image file information
- `timings`
- `seed`: the input seed or the randomly generated seed used
- `has_nsfw_concepts`
- `prompt`: the prompt used for generation

Image records include `url`, `width`, `height`, and `content_type`.

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
