# gemini-3-pro-image

## Official sources

- https://ai.google.dev/gemini-api/docs/image-generation
- https://ai.google.dev/api/interactions-api

Captured: 2026-08-09

## Endpoint and authentication

Debrute sends one `POST` to
`https://generativelanguage.googleapis.com/v1beta/interactions` with
`x-goog-api-key: <key>` and `Content-Type: application/json`. It fixes `model`
to `gemini-3-pro-image`, `store` to `false`, and requests image output.

## Agent request fields

- `prompt` is required and becomes one typed text input block.
- `image` is an optional ordered string array. Each item is an absolute or
  CLI-working-directory-relative local image path, public HTTP(S) URL, or
  `data:image` URI and becomes one typed image input block. The official total
  limit is 14 references, with up to 6 high-fidelity object references, 5
  people references, and 3 style references.
- `aspect_ratio`, `image_size`, and `delivery` are optional strings.

Current image sizes include `1K`, `2K`, and `4K`. Debrute materializes only
`delivery: "uri"`; an explicit `inline` remains explicit. Geometry is not
defaulted, and Google owns current enum, range, and cross-field validation.

## Official surface and current executor boundary

Google documents interleaved text-and-image model output and SynthID for this
model. The exact Debrute executor collects every image block but does not retain
interleaved output text as a generated Artifact. Structurally safe unlisted
top-level Interactions fields can be forwarded, but pass-through alone does not
establish correct multi-turn or tool-response handling.

## Response

Debrute reads every image block from exact `model_output` steps. URI delivery
requires a non-empty URI and downloads it; inline delivery requires non-empty
Base64 data. The complete image set is decoded, media-detected from bytes, and
committed atomically. Non-image output blocks are not retained as Model
Artifacts.

## Debrute request

The default active image Model request timeout is 10 minutes. Save the following one-line JSON object as UTF-8 JSONL, then submit it with `debrute request single --input request.jsonl`; use `--timeout <Ns|Nm|Nh>` when an override is needed. The JSONL record is self-contained: `output.directory` may be absolute or relative to the directory where `debrute` is invoked.

```json
{
  "model": "gemini-3-pro-image",
  "arguments": {
    "prompt": "A high-detail architectural interior concept with natural light"
  },
  "output": {
    "directory": "generated",
    "name": "image"
  }
}
```
