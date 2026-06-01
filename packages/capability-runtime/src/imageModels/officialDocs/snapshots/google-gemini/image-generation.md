---
provider: google-gemini
models:
  - gemini-3-pro-image-preview
  - gemini-3.1-flash-image
  - gemini-3.1-flash-image-preview
source_urls:
  - https://ai.google.dev/gemini-api/docs/image-generation
  - https://deepmind.google/models/model-cards/gemini-3-1-flash-image/
captured_at: 2026-05-31
source_type: official_docs
cleanup:
  - removed page chrome and duplicate table of contents
  - removed SDK setup and raw provider command snippets
---

# Gemini image generation

Google documents Gemini image generation through the Gemini API. Gemini image models generate image responses from text prompts and can use images as context for editing, composition, reference, and multi-turn workflows.

## Model card notes for Gemini 3.1 Flash Image

Google DeepMind's Gemini 3.1 Flash Image model card describes it as a member of the Gemini model series and a natively multimodal reasoning model. It can comprehend text, images, audio, and video; image and text output can be generated in the response.

Documented model card inputs and outputs:

- Inputs: text strings and images, with a token context window up to `1M`.
- Outputs: image output and text output.
- Intended usage: professional image creation and editing, clear text in posters and diagrams, long-context real-world knowledge, localized text rendering, and studio-quality control.

The model card also notes limitations such as hallucinations, occasional slowness or timeouts, quality issues for small or long text rendering, imperfect character consistency, partial instruction following in masked or doodle-based editing, and occasional spatial localization confusion.

## Image editing and references

Google's image generation guide shows Gemini image workflows that use input images for:

- stylization of an existing image while preserving composition
- combining multiple images into one composite scene
- preserving high-fidelity details such as faces or logos during an edit
- turning sketches into polished outputs
- iterative character views using previously generated images as references

Best results depend on detailed prompts, explicit context and intent, iterative refinement, step-by-step instructions for complex scenes, positive descriptions instead of negative prompts, and photographic or cinematic camera language.

## Optional response configuration

The Gemini API can configure response modalities so the model returns image-only output rather than text plus image. The image guide documents image output configuration in the request `config`.

The model defaults to matching output image size to the input image, or otherwise generating `1:1` squares. Output aspect ratio is configured through image response format fields. For `gemini-3.1-flash-image` and `gemini-3-pro-image`, the image response format can include:

- `aspect_ratio`, such as `16:9`
- `image_size`, such as `1K` or `2K`

## Limits and watermarks

Google documents these limits and notes for Gemini image generation:

- Image generation does not support audio inputs.
- Video inputs are only supported for Gemini 3.1 Flash Image.
- The model may not always follow an explicitly requested number of image outputs.
- `gemini-3-pro-image` supports 5 images with high fidelity and up to 14 images in total.
- `gemini-3.1-flash-image` supports character resemblance of up to 4 characters and fidelity of up to 10 objects in a single workflow.
- Generated images include a SynthID watermark.
