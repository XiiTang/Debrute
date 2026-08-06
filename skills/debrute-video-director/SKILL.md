---
name: debrute-video-director
description: Use for any task related to video generation or video editing through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.4
---

# Debrute Video Director

Use `debrute` as the execution interface for video generation and editing.

## Rules

- Run `debrute models video list`, choose only a returned configured Model, then
  run `debrute models video describe <model-id>` once.
- Build Model `arguments` from the returned Debrute schema and documentation.
  For Seedance adapters use the documented `prompt`, `intent`, and `references`;
  do not assemble provider `content` arrays or include API keys.
- Submit Single through strict JSONL or direct `--model`, `--arguments`, and
  `--output` options; never combine the two sources. Use JSONL-only
  `request batch --input <requests.jsonl>` for multiple requests.
- Required `output` is separate from `arguments` and contains `directory` plus
  ordinary basename `name`. The directory may be absolute or relative to the
  CLI working directory. Runtime derives actual extensions.
- Video Model requests default to `30m`; `--timeout` accepts only positive `s`, `m`,
  or `h` durations and covers active submission, polling, reads, and downloads.
- The CLI waits by default. `--no-wait` returns an Operation id and does not
  cancel work when the CLI exits.
- Put local paths only in the exact fields named by the selected Model's
  description. CLI passes strings without media classification; the Model
  adapter owns supported path conversion. A local video reference still needs
  that Model's upload support unless it is already a supported native or remote
  reference.
- Use `--replace` only when replacing the file present at commit is intended.
- An output inside an open Project becomes an ordinary Project Tree entry and
  therefore belongs to every Canvas automatically. Report Artifact records and
  structured errors.

## Workflow

1. Inspect the brief and only required local source media.
2. List, select, and describe a configured video Model.
3. Write one or more schema-valid JSONL Model Requests.
4. Submit one Single or Batch Operation and report its settled results.
