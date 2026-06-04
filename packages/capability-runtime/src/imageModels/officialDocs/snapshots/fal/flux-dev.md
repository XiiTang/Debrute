---
models:
  - fal-ai/flux/dev
source_urls:
  - https://fal.ai/models/fal-ai/flux/dev/api
captured_at: 2026-05-31
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

Official input fields used by AXIS:

- `prompt`: required string prompt to generate an image from.
- `image_size`: generated image size. Default is `landscape_4_3`.
- `num_inference_steps`: integer number of inference steps. Default is `28`.
- `seed`: integer. The same seed and same prompt with the same model version output the same image every time.
- `guidance_scale`: CFG scale for how closely the model follows the prompt. Default is `3.5`.
- `sync_mode`: boolean. If true, media is returned as a data URI and output data is not available in request history.
- `num_images`: number of generated images. Default is `1`.
- `enable_safety_checker`: boolean, default `true`.
- `output_format`: generated image format, default `jpeg`; possible values are `jpeg` and `png`.
- `acceleration`: generation speed. Possible values are `none`, `regular`, and `high`; default is `none`.

`image_size` enum values:

- `square_hd`
- `square`
- `portrait_4_3`
- `portrait_16_9`
- `landscape_4_3`
- `landscape_16_9`

For custom image sizes, fal accepts an object with `width` and `height`.

## Output schema

The output includes:

- `images`: generated image file information
- `timings`
- `seed`: the input seed or the randomly generated seed used
- `has_nsfw_concepts`
- `prompt`: the prompt used for generation

Image records include `url`, `width`, `height`, and `content_type`.
