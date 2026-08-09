# gpt-image-2

## Official sources

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/models/gpt-image-2

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends one request to `POST https://api.openai.com/v1/images/generations`
or `POST https://api.openai.com/v1/images/edits` with
`Authorization: Bearer <key>`. The edit endpoint is selected when `image` or
`mask` is present.

## Agent request fields

- `prompt` is required.
- `image` is an optional array of absolute or CLI-working-directory-relative
  local image paths, public HTTP(S) URLs, or `data:image` URIs.
- `mask` is one optional image reference in the same string form.
- `size`, `quality`, `background`, `output_format`, `moderation`, and `user`
  are optional strings.
- `output_compression` and `n` are optional integers.

Currently documented `background` behavior includes `auto` and `opaque`.
This Model does not accept `background: "transparent"`. Every explicit `size`
must satisfy all of these rules:

- width and height are both multiples of 16 pixels;
- the longer edge is at most 3840 pixels;
- the longer-to-shorter-edge ratio is at most 3:1;
- total pixels are from 655,360 through 8,294,400, inclusive.

`quality` is `auto`, `low`, `medium`, or `high`; `output_format` is `png`,
`jpeg`, or `webp`; and `output_compression` is an integer from 0 through 100
for JPEG or WebP output. All input images are processed at high fidelity, so
OpenAI forbids `input_fidelity` for this Model rather than exposing a lower
mode. Debrute materializes no default for this Model; OpenAI owns current input
cardinality and all remaining cross-field validation.

Public-URL-only edits use the documented JSON request. An edit containing a
local image or data URI uses multipart. Debrute selects one transport before
submission and does not retry through the other.

## Response

Every item in the non-empty `data` array must contain non-empty `b64_json`.
Debrute decodes every item, detects its image media type from the bytes, and
commits the complete result atomically.

The official Image API can stream partial images for `gpt-image-2`. This exact
Debrute executor only handles one completed JSON response and has no partial-
image event state machine. Forwarding `stream` or `partial_images` would not
make that response lifecycle supported.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "gpt-image-2",
  "arguments": {
    "prompt": "A clean hero image for a productivity app landing page with readable headline text"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
