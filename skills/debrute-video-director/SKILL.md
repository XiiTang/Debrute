---
name: debrute-video-director
description: Use for any task related to video generation or video editing in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.3
---

# Debrute Video Director

Use `debrute` as the execution interface for video generation and editing.

## Rules

- Run `debrute models video list`, choose only a returned configured Model, then
  run `debrute models video describe <model-id>` once.
- Build Model `arguments` from the returned Debrute schema and documentation.
  For Seedance adapters use the documented `prompt`, `intent`, and `references`;
  do not assemble provider `content` arrays or include API keys.
- Submit strict JSONL with
  `debrute request single /path/to/project --input video-request.jsonl` or use
  `request batch` for multiple video requests.
- Optional `output` is separate from `arguments`; specify a Project-relative
  directory and extension-free filename. Runtime derives the actual extension.
- Video Model Runs default to `30m`; `--timeout` accepts only positive `s`, `m`,
  or `h` durations and covers active submission, polling, reads, and downloads.
- The CLI waits by default. `--no-wait` returns an Operation id and does not
  cancel work when the CLI exits.
- Project-local image and audio references are normalized only when supported.
  Project-local video references still require upload support unless already
  represented by a supported remote or asset URL.
- Use `--replace` only when replacing the file present at commit is intended.
- Update and push the Canvas Map before generation when planned outputs should
  appear on a Canvas, and report Artifact records and structured errors.

## Workflow

1. Inspect the brief and only required source media.
2. List, select, and describe a configured video Model.
3. Write one or more schema-valid JSONL Model Requests.
4. Update and push the Canvas Map when needed.
5. Submit one Single or Batch Operation and report its settled results.
