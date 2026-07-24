---
name: debrute-image-director
description: Use for any task related to image generation or image editing in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.3
---

# Debrute Image Director

Use for any task related to image generation or image editing.

Use `debrute` as the Debrute execution interface. Debrute Skills describe how to call the CLI; they are standard Skills, not Debrute APIs.

## Basic Rules

- Do not assume a model, argument shape, or default output path from memory.
- Run `debrute models image list` to compare configured image models by original model parameters and constraints.
- Use only models returned by `debrute models image list`.
- Before generation, run `debrute models image describe <model-id>` once for the selected model.
- Inspect the returned official documentation URLs, repository snapshot path, `description_markdown`, Debrute examples, and `arguments_schema`.
- Use original model parameter names shown by `models image list` and confirmed by `models image describe`.
- Do not include model API keys in generation requests; Debrute reads configured keys locally.
- Use the Debrute example command returned by `models image describe`; do not rely on source API curl or SDK snippets.
- Image-capable model fields accept only the image input forms described by `models image describe`; follow each field's array/single-value shape and model-specific object shape exactly.
- Choose the model and request arguments from the returned `description_markdown` and `arguments_schema`.
- Submit the request with `debrute generate image /path/to/project --input-json '<json>'`.
- For multiple planned image requests, submit one process with `debrute generate image-batch /path/to/project --manifest <manifest.json> --log <results.jsonl> --summary <summary.json>` or `debrute generate image-batch /path/to/project --input-jsonl <requests.jsonl> --log <results.jsonl> --summary <summary.json>`.
- --timeout-ms defaults to 600000ms for single image requests.
- --timeout-ms defaults to 900000ms per item for image batches.
- Batch commands skip existing non-empty `output_path` files by default; pass `--overwrite-existing` when outputs should be regenerated.
- Debrute resolves project files, data URLs, and safe public `http(s)` URLs for image inputs; model-specific file format, size, dimension, alpha, and mask constraints are left to the upstream model.
- Batch progress is sparse: start, crossed 10 percent completion boundaries, and final summary.
- Do not loop over `debrute generate image` for a planned set of image requests. Batch result JSONL contains one final item outcome per line.
- When project artifacts should be created, use output arguments supported by the selected model so generated files are written inside the project.
- Update the Canvas Map when planning image output paths. Add literal file/folder entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`, and wildcard matching must use explicit `glob:` entries.
- Use `layout.rows` when generated image siblings should compare horizontally by direct parent directory.
- Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
- Surface structured CLI errors to the user when a command fails.

## Workflow

1. Read or derive the user's image generation or image editing brief.
2. Inspect project files or source image assets only when they are needed for the image task.
3. Run `debrute models image list` and compare configured models by original model parameters and constraints.
4. Choose a candidate from the returned models.
5. Before generation, run `debrute models image describe <model-id>` once for the selected model.
6. Build the request payload from the original parameter names confirmed by `description_markdown`, Debrute example, and `arguments_schema`.
7. When literal image output paths or explicit `glob:` rules are planned, update `.debrute/canvas-maps/<canvas-id>.yaml` so the generated files appear on that Canvas.
8. Keep related outputs in the same filesystem directory structure so hierarchy and edges come from files and folders.
9. Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
10. Run `debrute generate image /path/to/project --input-json '<json>'` for one planned request, or `debrute generate image-batch /path/to/project --manifest <manifest.json> --log <results.jsonl> --summary <summary.json>` for multiple planned requests.
11. Report artifact paths, generated asset metadata, and any structured errors.

## Error Handling

- If `models image list` returns no models, say Debrute returned no image models and do not invent one.
- If the selected model cannot be used, run `models image list` again and choose from the returned models or ask the user how to proceed.
- If the CLI returns configuration, authentication, model request, validation, filesystem, or generated asset errors, preserve the structured error code, message, model id, and relevant logs.
- If a batch returns `failed` greater than 0 or exits non-zero, read the JSONL log and report failed item errors with their index, model, and output path when present.
- If request arguments do not match the selected model, fetch the model description again and rebuild the request from `description_markdown`, the Debrute example, and `arguments_schema`.
