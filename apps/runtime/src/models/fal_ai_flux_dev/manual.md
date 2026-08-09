# fal-ai/flux/dev

## Official sources

- https://fal.ai/models/fal-ai/flux/dev/api

Captured: 2026-08-09

fal documents `fal-ai/flux/dev` as FLUX.1 [dev] text-to-image. The model is described as a 12 billion parameter flow transformer that generates high-quality images from text and is suitable for personal and commercial use.

## Files

Some fal model attributes accept file URLs. fal documents hosted URLs and Base64 data URIs as accepted file input forms. Hosted URLs must be publicly accessible. Large Base64 data URIs can affect request performance.

## Input schema

`definition.json` describes the currently documented fal input shapes so an
Agent can screen and construct requests. It is not a local JSON Schema
rejection boundary. This exact executor sends the complete `arguments` object
to fal unchanged; fal owns required-field, JSON-type, enum, range, `null`, and
custom-object validation.

Documented input fields:

- `prompt`: required string prompt to generate an image from.
- `image_size`: generated image size, with provider default `landscape_4_3`.
  Debrute does not duplicate this creative geometry choice in the canonical
  request. Omission remains absent; an explicit preset or custom size remains
  explicit.
- `num_inference_steps`: optional integer number of inference steps, with
  provider default `28`. Debrute leaves omission absent.
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

`image_size` enum values:

- `square_hd`
- `square`
- `portrait_4_3`
- `portrait_16_9`
- `landscape_4_3`
- `landscape_16_9`

For custom image sizes, fal documents an object with integer `width` and
integer `height` fields. The executor forwards that object exactly as supplied;
fal validates its field names, JSON types, pairing, and current dimension
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

The normal response supplies HTTP image URLs, which Runtime downloads into the
accepted output directory. `sync_mode: true` may instead supply Base64 data
URIs; Runtime validates their image MIME and decodes them under the same
model-output size bound.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "fal-ai/flux/dev",
  "arguments": {
    "prompt": "A cinematic product render on a black acrylic surface"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
