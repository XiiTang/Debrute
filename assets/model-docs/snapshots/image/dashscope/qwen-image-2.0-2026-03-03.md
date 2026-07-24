---
models:
  - qwen-image-2.0-2026-03-03
source_urls:
  - https://help.aliyun.com/en/model-studio/qwen-image-api
  - https://help.aliyun.com/en/model-studio/qwen-image-edit-guide
  - https://help.aliyun.com/zh/model-studio/image-model/
captured_at: 2026-07-23
source_type: official_docs
cleanup:
  - removed navigation, console chrome, SDK setup, and unrelated image models
  - removed asynchronous examples that do not apply to Qwen Image 2.0
---

# Qwen Image 2.0 2026-03-03

Alibaba Cloud Model Studio documents `qwen-image-2.0-2026-03-03` as the fixed
snapshot for the accelerated Qwen Image 2.0 line. It combines text-to-image and
image editing in one model while balancing image quality and response speed.
Debrute uses the dated snapshot so its upstream model selection is explicit.

## Endpoint and authentication

The model uses the synchronous multimodal-generation endpoint:

- Beijing workspace: `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- Singapore workspace: `POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

Debrute's default Base URL is the Beijing DashScope route
`https://dashscope.aliyuncs.com/api/v1`. A Configured Model can select an
official workspace-specific or other regional route through its existing
per-Model Base URL override. Beijing and Singapore API keys and endpoints
cannot be mixed.

Runtime sends `Authorization: Bearer <key>` and `Content-Type:
application/json`. Qwen Image 2.0 supports synchronous calls; this Debrute
Model does not create or poll a remote task.

## Agent request fields

- `prompt` is required. Runtime emits one `{ "text": prompt }` content item.
  The official API allows only one text item and currently documents up to
  1,300 tokens for the Qwen Image 2.0 series.
- `image` is an optional ordered string array. Its absence means
  text-to-image. One to three values mean image editing or reference generation,
  with the intent expressed by `prompt`. Runtime resolves each Project-relative
  image path, public HTTP(S) URL, or image data URL and emits one
  `{ "image": value }` content item in the same order, before the text item.
  The provider assigns Image 1, Image 2, and Image 3 from this order.
- `negative_prompt` is an optional string describing content to avoid. The
  official service currently documents a 500-character limit.
- `size` is an optional `width*height` string. The Qwen Image 2.0 series accepts
  freely selected dimensions whose total pixel count is between `512*512` and
  `2048*2048`. Text-to-image currently defaults to `2048*2048`; editing uses a
  size based on the input image, or the last input image when several are sent.
- `n` is the optional output count in the provider range 1 through 6. The
  provider default is 1.
- `prompt_extend` is an optional boolean that controls positive-prompt
  rewriting. The provider currently defaults it to `true`.
- `watermark` is an optional boolean that controls the bottom-right
  Qwen-Image watermark. Debrute materializes `false` so the accepted request is
  explicitly watermark-free.
- `seed` is an optional integer in `[0, 2147483647]`. Equal seeds can produce
  similar output but do not guarantee exact repeatability.

Input images may be public HTTP(S) URLs or Base64 image data URLs. The official
editing guide accepts JPG, JPEG, PNG, BMP, TIFF, WEBP, and the first frame of a
GIF, with a maximum of 10 MB per image. Current size, count, prompt-length, and
cross-field business limits are validated by the remote endpoint rather than
duplicated in Runtime.

Debrute materializes no default other than `watermark: false`. Omitted `size`,
`n`, `prompt_extend`, `negative_prompt`, and `seed` remain absent, preserving
the provider's mode-sensitive behavior. Structurally safe unlisted top-level
arguments follow the current Debrute contract and are forwarded in
`parameters`; the listed fields are the supported Agent-facing surface.

## Wire request

Runtime sends exactly one user message. Image items retain Agent order and the
text instruction follows them:

```json
{
  "model": "qwen-image-2.0-2026-03-03",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [
          {"image": "data:image/png;base64,..."},
          {"text": "Edit Image 1 into a product poster"}
        ]
      }
    ]
  },
  "parameters": {
    "watermark": false
  }
}
```

## Response and Project artifacts

A successful response contains
`output.choices[].message.content[].image`. Each `image` value is a PNG result
URL that expires after 24 hours. Runtime traverses choices and their content in
provider order, immediately downloads every URL, and stores every result as a
`PrimaryImage` Project artifact. Existing artifact indexes preserve this order.

Runtime requires a non-empty choices array, non-empty content for each choice,
and a non-empty image URL for every content item. It does not retain an
expiring provider URL as the generated asset.
