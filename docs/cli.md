# CLI

The CLI is Agent-facing and writes structured Agent Records on stdout. There is no JSON output mode; JSON is used only as an input encoding for request payloads.

## Common Commands

```sh
debrute --version
pnpm exec tsx apps/debrute-cli/src/index.ts runtime status
pnpm exec tsx apps/debrute-cli/src/index.ts runtime doctor
pnpm exec tsx apps/debrute-cli/src/index.ts skills status
pnpm exec tsx apps/debrute-cli/src/index.ts project init path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts project validate path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts workbench start
pnpm exec tsx apps/debrute-cli/src/index.ts canvas-map push path/to/project canvas-1
pnpm exec tsx apps/debrute-cli/src/index.ts canvas create path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts canvas rename path/to/project canvas-2 故事板
pnpm exec tsx apps/debrute-cli/src/index.ts canvas reorder path/to/project canvas-2 canvas-1
pnpm exec tsx apps/debrute-cli/src/index.ts canvas delete path/to/project canvas-2
pnpm exec tsx apps/debrute-cli/src/index.ts canvas repair-index path/to/project
pnpm exec tsx apps/debrute-cli/src/index.ts generated-asset lookup path/to/project --path generated/example.png
pnpm exec tsx apps/debrute-cli/src/index.ts models image list
pnpm exec tsx apps/debrute-cli/src/index.ts models image describe gpt-image-2
pnpm exec tsx apps/debrute-cli/src/index.ts generate image path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}' --timeout-ms 600000
pnpm exec tsx apps/debrute-cli/src/index.ts generate image-batch path/to/project --manifest image-requests.json --concurrency 8 --retries 0 --timeout-ms 900000 --log image-results.jsonl --summary image-summary.json
pnpm exec tsx apps/debrute-cli/src/index.ts models video list
pnpm exec tsx apps/debrute-cli/src/index.ts models video describe doubao-seedance-2-0-260128
pnpm exec tsx apps/debrute-cli/src/index.ts generate video path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"Short video brief","intent":"generate"}}' --timeout-ms 600000
pnpm exec tsx apps/debrute-cli/src/index.ts commands
```

## Image Generation

Use `generate image-batch` for multiple planned image requests; do not loop over `generate image` for planned batches.

`--manifest` expects:

```json
{ "requests": [] }
```

Each item is shaped like a `generate image` input. Batch item outcomes are written to `--log`; stdout emits sparse progress records and the final aggregate record.

Use `models image list` to compare configured image models by original model parameters and constraints. Before image generation, run `models image describe <model-id>` once for the selected model. Model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Single image `--timeout-ms` defaults to 600000ms. Image batch `--timeout-ms` defaults to 900000ms per item attempt.

Use `--overwrite-existing` to regenerate batch outputs that would otherwise be skipped.

Debrute resolves project files, data URLs, and safe public `http(s)` URLs for image inputs. Model-specific file format, size, dimension, alpha, and mask constraints are left to the upstream model.

## Video Generation

Use `models video list` to compare configured video models by Debrute-native parameters and constraints. Before video generation, run `models video describe <model-id>` once for the selected model. Video model descriptions return official documentation URLs, a repository snapshot path, official-documentation-backed `description_markdown`, Debrute examples, and the machine-readable `arguments_schema`.

Video `--timeout-ms` defaults to 600000ms and covers task submission, polling, response reads, and artifact download.

Video generation uses `prompt`, `intent`, and `references`; Debrute constructs Seedance `content` internally.

Project-local image and audio references can be normalized by Debrute when the selected model supports them. Project-local video references require Debrute upload-server support unless the source is already `http(s)` or `asset://`.

Do not include model API keys in generation requests; Debrute reads configured keys locally. Use the original model parameter names shown by `models image list` and confirmed by `models image describe`.

Model request failures keep the stable CLI error code and include the Debrute model id, message, and structured logs when available.

## Minimal Canvas Map

```yaml
paths:
  - outputs/gpt/
  - prompts/cover.md
```

See [Product model](./product-model.md) for Canvas Map semantics.
