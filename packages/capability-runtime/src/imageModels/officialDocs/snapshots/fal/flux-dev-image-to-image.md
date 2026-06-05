---
models:
  - fal-ai/flux/dev/image-to-image
source_urls:
  - https://fal.ai/models/fal-ai/flux/dev/image-to-image/api
captured_at: 2026-05-31
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

- `image_url`: required string URL of the image used as the generation source.
- `strength`: float strength of the initial image. Higher strength values are better for this model. Default is `0.95`.
- `num_inference_steps`: integer number of inference steps. Default is `40`.
- `prompt`: required string prompt to generate an image from.
- `seed`: integer. The same seed and same prompt with the same model version output the same image every time.
- `guidance_scale`: CFG scale for how closely the model follows the prompt. Default is `3.5`.
- `sync_mode`: boolean. If true, media is returned as a data URI and output data is not available in request history.
- `num_images`: number of generated images. Default is `1`.
- `enable_safety_checker`: boolean, default `true`.
- `output_format`: generated image format, default `jpeg`; possible values are `jpeg` and `png`.
- `acceleration`: generation speed. Possible values are `none`, `regular`, and `high`; default is `none`.

## Output schema

The output includes generated image records, timing information, the seed used, NSFW concept flags, and the prompt used for generation. Image records include `url`, `width`, `height`, and `content_type`.
