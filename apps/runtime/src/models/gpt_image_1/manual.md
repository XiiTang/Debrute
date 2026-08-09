# gpt-image-1

## Official sources

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/models/gpt-image-1

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
- `size`, `quality`, `background`, `input_fidelity`, `output_format`,
  `moderation`, and `user` are optional strings.
- `output_compression` and `n` are optional integers.

`size` is `auto`, `1024x1024`, `1024x1536`, or `1536x1024`; `quality` is
`auto`, `low`, `medium`, or `high`; and `output_format` is `png`, `jpeg`, or
`webp`. `output_compression` is an integer from 0 through 100 and applies to
JPEG or WebP output. `background` is `auto`, `opaque`, or `transparent`, and a
transparent result requires an alpha-capable PNG or WebP output. The supported
`input_fidelity` values are `low` and `high`.

Debrute materializes no default for this Model. OpenAI owns current input-image
cardinality and size validation, plus all remaining cross-field validation.

Public-URL-only edits use the documented JSON request. An edit containing a
local image or data URI uses multipart. Debrute selects one transport before
submission and does not retry through the other.

## Response

Every item in the non-empty `data` array must contain non-empty `b64_json`.
Debrute decodes every item, detects its image media type from the bytes, and
commits the complete result atomically.

OpenAI's Responses API image tool and Image API partial-image streaming are
separate response lifecycles. This exact Debrute executor only handles one
completed Image API response; forwarding unlisted streaming fields does not
make partial-image events supported.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "gpt-image-1",
  "arguments": {
    "prompt": "A clean app icon with readable Debrute lettering"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
