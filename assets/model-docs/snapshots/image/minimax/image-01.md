---
models:
  - image-01
source_urls:
  - https://platform.minimax.io/docs/api-reference/image-generation-t2i
  - https://platform.minimax.io/docs/api-reference/image-generation-i2i
  - https://platform.minimax.io/docs/guides/image-generation
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed page chrome and duplicated documentation index text
  - removed raw source API command snippets
---

# MiniMax image-01

MiniMax documents Image Generation as supporting generation from text or references, with custom aspect ratios and resolutions. `image-01` is described as a high-quality image generation model that produces fine-grained details and supports both text-to-image and image-to-image generation with subject references for people.

## Endpoint

The documented image generation endpoint is `POST https://api.minimax.io/v1/image_generation`.

## Text-to-image

The text-to-image API generates images from text input. Official request fields used by Debrute:

- `model`: `image-01`.
- `prompt`: required text description, maximum 1500 characters.
- `aspect_ratio`: output ratio. MiniMax currently uses `1:1` when no ratio or
  explicit width/height is supplied. Debrute does not materialize a size or
  aspect-ratio default because either ratio or pixel dimensions may express the
  Agent's requested image geometry.
- `width` and `height`: optional integer pixel dimensions for `image-01`.
  MiniMax currently requires both together, range `[512, 2048]`, and
  divisibility by 8. Debrute validates only each provided field's integer type;
  MiniMax validates pairing and current dimension rules. `null` is not an
  alternate Agent shape. When both `width`/`height` and `aspect_ratio` are
  present, `aspect_ratio` has priority.
- `response_format`: `url` or `base64`; URL output expires in 24 hours.
  Debrute recommends `base64` for the normal Agent request because generated
  bytes can be committed without depending on an expiring media URL. `url`
  remains an explicit supported alternative that an Agent may select in a new
  request if the provider's Base64 mode fails. Runtime does not silently change
  the requested format or automatically retry the paid model request. When the
  argument is omitted, Debrute materializes the documented Debrute default
  `base64` before recording and sending the request.
- `seed`: optional integer seed. Same seed and parameters can reproduce images;
  when omitted, MiniMax generates a random seed for each image. Strings and
  `null` are not alternate Agent shapes.
- `n`: number of images, with provider default `1` and current documented range
  `[1, 9]`. Debrute does not duplicate that matching default: omission remains
  absent, while an explicit integer reaches MiniMax for current range
  validation.
- `prompt_optimizer`: optional boolean automatic prompt optimization, with
  provider default `false`. Debrute leaves omission absent, preserves an
  explicit boolean, and does not accept `null` as an alternate Agent shape.

Documented aspect ratio options:

- `1:1` -> `1024x1024`
- `16:9` -> `1280x720`
- `4:3` -> `1152x864`
- `3:2` -> `1248x832`
- `2:3` -> `832x1248`
- `3:4` -> `864x1152`
- `9:16` -> `720x1280`
- `21:9` -> `1344x576`

The only Debrute `image-01` default is `response_format: base64`, which
deliberately differs from MiniMax's current provider default `url` so the normal
Project artifact does not depend on an expiring URL. Count and geometry remain
absent unless the Agent supplies them.

Debrute does not add a mutual-exclusion rule that MiniMax does not have. If the
Agent sends both `aspect_ratio` and `width`/`height`, the exact request retains
all supplied fields and MiniMax applies its documented `aspect_ratio`
precedence. The Agent manual exposes that precedence rather than rewriting an
allowed provider request into a local error.

MiniMax owns the current business validation of prompt length, numeric ranges,
documented option values, paired dimensions, divisibility, and parameter
combinations. Debrute validates its own request structure, Project media,
public-URL safety, and resource limits, then sends the Agent's exact canonical
arguments. If MiniMax rejects them, Runtime returns MiniMax's status, code, and
original explanatory message in the Model Operation's single Agent-visible
`log` after secret and inline-payload redaction and an error-text size limit,
instead of collapsing the response into a generic business-error message. It
does not expose arbitrary response headers or the complete response body.

## Image-to-image

The image-to-image API generates images from image input. It uses the same endpoint and includes `subject_reference`.

Official image-to-image request fields used by Debrute:

- `model`: `image-01` or `image-01-live` in the source API; Debrute exposes `image-01`.
- `prompt`: required text description, maximum 1500 characters.
- `subject_reference`: object array for image-to-image generation.
- `aspect_ratio`, `width`, `height`, `response_format`, `seed`, `n`, and `prompt_optimizer` as in text-to-image.

MiniMax receives subject references as objects with `type: "character"` and an
`image_file` URL. Debrute does not expose that provider object as a second Agent
input shape. The Agent supplies an array of Project-relative image paths,
public HTTP(S) URLs, or `data:image` URLs. Runtime validates and resolves each
string, then the exact adapter constructs the fixed MiniMax character-reference
object.

The array may be empty. Runtime forwards an explicit empty array rather than
rejecting it or rewriting it as omission; MiniMax owns whether that content is
currently accepted. Every element that exists must still be a string and pass
Debrute's media-resolution and safety boundary.

For example, the Agent request

```json
{"subject_reference":["references/character.png"]}
```

is sent as a MiniMax `subject_reference` object whose `image_file` contains the
resolved media reference. Other object fields, `image_url` aliases, and raw
provider objects are not accepted Agent inputs.

## Response

Successful responses include a trace `id`, a `data` object with generated image
URLs or Base64 data depending on `response_format`, `metadata` with success and
failure counts, and `base_resp` status information. Debrute supports both
documented response shapes and commits either one as the same Project-owned
generated image artifacts.
