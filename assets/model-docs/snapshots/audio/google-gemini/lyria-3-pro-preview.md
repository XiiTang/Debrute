---
models:
  - google-lyria-3-pro-preview
source_urls:
  - https://ai.google.dev/gemini-api/docs/music-generation
  - https://ai.google.dev/api/interactions-api
captured_at: 2026-07-21
cleanup:
  - removed navigation, unrelated models, SDK boilerplate, and alternate Interactions capabilities
---

# Google Lyria 3 Pro Preview

## Endpoint and authentication

Debrute sends `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with `x-goog-api-key: <key>` and `Content-Type: application/json`.

## Agent request fields

- `prompt` is required.
- `image` is an optional ordered array of at most ten Project-relative image
  paths, public HTTP(S) URLs, or `data:image` URIs.
- `format` is optional and selects `mp3` or `wav`.

Debrute builds typed text and image input blocks, fixes `model` to
`lyria-3-pro-preview`, and fixes `store` to `false`. An omitted `format` remains
absent.

## Response

Debrute reads exact `steps[type="model_output"]` content, decodes every audio
block, and retains model-output text. Generated audio bytes are stored without
container conversion.

This Model uses one completed Interactions response.
