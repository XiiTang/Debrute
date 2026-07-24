---
name: debrute-image-director
description: Use for any task related to image generation or image editing in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.3
---

# Debrute Image Director

Use `debrute` as the execution interface for image generation and editing.

## Rules

- Run `debrute models image list`, choose only a returned configured Model, and
  run `debrute models image describe <model-id>` once before constructing input.
- Build `arguments` only from the returned `description_markdown`, Debrute
  example, and `arguments_schema`. Do not copy source API SDK examples or put an
  API key in a request.
- Write one strict JSONL Model Request per line. Use
  `debrute request single /path/to/project --input <request.jsonl>` for one and
  `debrute request batch /path/to/project --input <requests.jsonl>` for a planned
  set. Do not loop over Single commands for a Batch.
- A request is `{"model":"...","arguments":{...},"output":{"directory":"generated","filename":"cover"}}`.
  `output` is outside Model arguments and its filename has no extension.
- The CLI waits by default. Use `--no-wait` only when the caller intends to use
  `operation inspect`, `operation wait`, or `operation cancel` with the returned id.
- Image Model Runs default to `10m`; override with a positive `--timeout Ns|Nm|Nh`.
  There is no automatic retry.
- Batch `--concurrency` defaults to `1`. Sparse stdout records report each
  settled Item; redirect that stream when a retained file copy is needed.
- Without `--replace`, an occupied actual output target fails the Item. With it,
  replacement happens only during output commit.
- Debrute resolves supported Project paths, data URLs, and safe public HTTP(S)
  inputs. Preserve each Model's documented shape and media constraints.
- Update and push the Canvas Map before generation when planned output paths
  should appear on a Canvas. Folder rules end in `/`; wildcard rules use `glob:`.
- Surface final Artifact paths and every structured error. A Batch can exit 0
  while individual Item progress records report failures.

## Workflow

1. Read the brief and inspect only needed Project inputs.
2. List Models, select one, and describe it.
3. Create one or more JSONL records from the authoritative schema.
4. Update and push the Canvas Map when needed.
5. Run `request single` or one `request batch`.
6. Report Artifact records and failed Batch Items without inventing missing data.
