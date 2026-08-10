---
name: debrute-image-director
description: Use for any task related to image generation or image editing through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.4
---

# Debrute Image Director

Use `debrute` as the execution interface for image generation and editing.

## Rules

- Resolve `debrute` normally. If the current Agent process predates Product
  installation and cannot find it, use only the managed entrypoint:
  `$HOME/.debrute/bin/debrute` on macOS,
  `& "$env:USERPROFILE\.debrute\bin\debrute.cmd"` in Windows PowerShell, or
  `"%USERPROFILE%\.debrute\bin\debrute.cmd"` in Windows `cmd.exe`.
- Run `debrute models image list` and use each returned `summary` to eliminate
  configured Models that cannot meet the brief's hard requirements. Run
  `debrute models image describe <model-id>` only for the selected candidate.
- Build `arguments` only from the returned `manual_markdown` and
  `arguments_schema`. Do not copy source API SDK examples or put an API key in a
  request.
- Single may use one strict JSONL record or direct `--model`, `--arguments`, and
  `--output` options. Never combine `--input` with a direct request option. Use
  `debrute request batch --input <requests.jsonl>` for a planned set; Batch is
  JSONL-only. Do not loop over Single commands for a Batch.
- A request is `{"model":"...","arguments":{...},"output":{"directory":"generated","name":"cover"}}`.
  Both output fields are required. `name` is an ordinary basename without an
  extension supplied by the caller.
- The CLI waits by default. Use `--no-wait` only when the caller intends to use
  `operation inspect`, `operation wait`, or `operation cancel` with the returned id.
- Image Model requests default to `10m`; override with a positive `--timeout Ns|Nm|Nh`.
  There is no automatic retry.
- Batch `--concurrency` defaults to `1`. Sparse stdout records report each
  settled Item; redirect that stream when a retained file copy is needed.
- Without `--replace`, an occupied actual output target fails the Item. With it,
  replacement happens only during output commit.
- Put input paths in the exact `arguments` fields named by `models image
  describe`. Paths may be absolute or relative to the CLI working directory.
  CLI does not classify or upload media; the selected Model executor owns the
  conversion. Preserve documented data URLs, native references, public HTTP(S)
  values, shapes, and media constraints.
- An output inside an open Project becomes an ordinary Project Tree entry and
  therefore belongs to the Canvas automatically. Do not maintain Canvas
  membership.
- Surface final Artifact paths and every structured error. A Batch can exit 0
  while individual Item progress records report failures.

## Workflow

1. Read the brief and inspect only needed local inputs.
2. List Models, select one, and describe it.
3. Create one or more JSONL records from the authoritative schema.
4. Run `request single` or one `request batch`.
5. Report Artifact records and failed Batch Items without inventing missing data.
