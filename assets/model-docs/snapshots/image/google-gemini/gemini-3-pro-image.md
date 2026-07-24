---
models:
  - gemini-3-pro-image
source_urls:
  - https://ai.google.dev/gemini-api/docs/image-generation
  - https://ai.google.dev/api/interactions-api
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed navigation, preview models, SDK boilerplate, and legacy generateContent examples
---

# Gemini 3 Pro Image

## Endpoint and authentication

Debrute sends one `POST` to
`https://generativelanguage.googleapis.com/v1beta/interactions` with
`x-goog-api-key: <key>` and `Content-Type: application/json`. It fixes `model`
to `gemini-3-pro-image`, `store` to `false`, and requests image output.

## Agent request fields

- `prompt` is required and becomes one typed text input block.
- `image` is an optional ordered string array. Each item is a Project-relative
  image path, public HTTP(S) URL, or `data:image` URI and becomes one typed
  image input block.
- `aspect_ratio`, `image_size`, and `delivery` are optional strings.

Current image sizes include `1K`, `2K`, and `4K`. Debrute materializes only
`delivery: "uri"`; an explicit `inline` remains explicit. Geometry is not
defaulted, and Google owns current enum, range, and cross-field validation.

## Response

Debrute reads every image block from exact `model_output` steps. URI delivery
requires a non-empty URI and downloads it; inline delivery requires non-empty
Base64 data. The complete image set is decoded, media-detected from bytes, and
committed atomically.
