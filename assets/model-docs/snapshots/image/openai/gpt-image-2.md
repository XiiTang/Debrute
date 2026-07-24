---
models:
  - gpt-image-2
source_urls:
  - https://developers.openai.com/api/docs/guides/image-generation
  - https://developers.openai.com/api/docs/models/gpt-image-2
captured_at: 2026-07-21
source_type: official_docs
cleanup:
  - removed navigation, unrelated models, SDK boilerplate, and alternate APIs
---

# OpenAI GPT Image 2

## Endpoint and authentication

Debrute sends one request to `POST https://api.openai.com/v1/images/generations`
or `POST https://api.openai.com/v1/images/edits` with
`Authorization: Bearer <key>`. The edit endpoint is selected when `image` or
`mask` is present.

## Agent request fields

- `prompt` is required.
- `image` is an optional array of Project-relative image paths, public HTTP(S)
  URLs, or `data:image` URIs.
- `mask` is one optional image reference in the same string form.
- `size`, `quality`, `background`, `output_format`, `moderation`, and `user`
  are optional strings.
- `output_compression` and `n` are optional integers.

Currently documented `background` behavior includes `auto` and `opaque`.
Flexible dimensions must satisfy OpenAI's current edge, aspect-ratio, and pixel
limits. Debrute materializes no default for this Model; OpenAI owns current
enum, range, cardinality, and cross-field validation.

Public-URL-only edits use the documented JSON request. An edit containing a
Project image or data URI uses multipart. Debrute selects one transport before
submission and does not retry through the other.

## Response

Every item in the non-empty `data` array must contain non-empty `b64_json`.
Debrute decodes every item, detects its image media type from the bytes, and
commits the complete result atomically.
