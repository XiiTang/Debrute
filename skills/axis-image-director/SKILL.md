---
name: axis-image-director
description: Use for any task related to image generation or image editing in an AXIS project through axis-cli.
metadata:
  axis.managed: "true"
  axis.package: "axis"
  axis.version: "0.1.0"
---

# AXIS Image Director

Use for any task related to image generation or image editing.

Use `axis-cli` as the AXIS execution interface. AXIS Skills describe how to call the CLI; they are standard Skills, not AXIS APIs.

## Basic Rules

- Do not assume a model, argument shape, or default output path from memory.
- Run `axis-cli models image list` to compare configured image models by original model parameters and constraints.
- Use only models returned by `axis-cli models image list`.
- Before generation, run `axis-cli models image describe <model-id>` once for the selected model.
- Inspect the returned official documentation URLs, repository snapshot path, `description_markdown`, AXIS examples, and `arguments_schema`.
- Use original model parameter names shown by `models image list` and confirmed by `models image describe`.
- Do not include model API keys in generation requests; AXIS reads configured keys locally.
- Use the AXIS example command returned by `models image describe`; do not rely on source API curl or SDK snippets.
- Image-capable model fields accept only the image input forms described by `models image describe`; follow each field's array/single-value shape and model-specific object shape exactly.
- Choose the model and request arguments from the returned `description_markdown` and `arguments_schema`.
- Submit the request with `axis-cli generate image /path/to/project --input-json '<json>'`.
- For multiple planned image requests, submit one process with `axis-cli generate image-batch /path/to/project --manifest <manifest.json> --log <results.jsonl> --summary <summary.json>` or `axis-cli generate image-batch /path/to/project --input-jsonl <requests.jsonl> --log <results.jsonl> --summary <summary.json>`.
- Do not loop over `axis-cli generate image` for a planned set of image requests. Batch result JSONL contains one final item outcome per line.
- When project artifacts should be created, use output arguments supported by the selected model so generated files are written inside the project.
- Update the Flowmap draft when planning image output paths. Write outputs under `<flowmap-id>/` and add matching paths or globs to `include`.
- When a generated output directory contains direct child output files that are comparable variants from the same prompt, model, size, quality, batch, or render pass, add a `layout.groups` entry for that directory so the Canvas lays those files out horizontally.
- Publish the draft with `axis flowmap publish /path/to/project --from .axis/flowmaps/<flowmap-id>.draft.yaml`.
- Surface structured CLI errors to the user when a command fails.

## Workflow

1. Read or derive the user's image generation or image editing brief.
2. Inspect project files or source image assets only when they are needed for the image task.
3. Run `axis-cli models image list` and compare configured models by original model parameters and constraints.
4. Choose a candidate from the returned models.
5. Before generation, run `axis-cli models image describe <model-id>` once for the selected model.
6. Build the request payload from the original parameter names confirmed by `description_markdown`, AXIS example, and `arguments_schema`.
7. When image output paths or output globs are planned, update `.axis/flowmaps/<flowmap-id>.draft.yaml` so the generated files match `include` and will appear on mounted Canvases.
8. Keep related outputs in the same Flowmap directory structure so hierarchy and edges come from files and folders.
9. Add `layout.groups` for direct child output files that should be compared as one horizontal set, such as `outputs/gpt-image-2/2000x2000/high/*.png` or `outputs/gemini-3.1-flash/4k/*.png`.
10. Publish the draft with `axis flowmap publish /path/to/project --from .axis/flowmaps/<flowmap-id>.draft.yaml`.
11. Run `axis-cli generate image /path/to/project --input-json '<json>'` for one planned request, or `axis-cli generate image-batch /path/to/project --manifest <manifest.json> --log <results.jsonl> --summary <summary.json>` for multiple planned requests.
12. Report artifact paths, generated asset metadata, and any structured errors.

## Error Handling

- If `models image list` returns no models, say AXIS returned no image models and do not invent one.
- If the selected model cannot be used, run `models image list` again and choose from the returned models or ask the user how to proceed.
- If the CLI returns configuration, authentication, model request, validation, filesystem, or generated asset errors, preserve the structured error code, message, model id, and relevant logs.
- If a batch returns `failed` greater than 0 or exits non-zero, read the JSONL log and report failed item errors with their index, model, and output path when present.
- If request arguments do not match the selected model, fetch the model description again and rebuild the request from `description_markdown`, the AXIS example, and `arguments_schema`.
