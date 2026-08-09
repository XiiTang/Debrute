---
name: debrute-audio-director
description: Use for any task related to TTS, music generation, or sound effect generation through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.4
---

# Debrute Audio Director

Use `debrute` for the peer Model Kinds TTS, music, and sound-effect. `audio` is
only their settings and implementation group.

## Rules

- Pick the use case first. Run the matching `debrute models tts|music|sfx list`
  and use each returned `summary` to eliminate configured Models that cannot
  meet the brief's hard requirements. Run `describe` only for the selected
  candidate.
- Build `arguments` only from the returned `manual_markdown` and
  `arguments_schema`; never include API keys.
- Submit Single through strict JSONL or direct `--model`, `--arguments`, and
  `--output` options; never combine the two sources. Batch is JSONL-only:
  `debrute request batch --input <requests.jsonl>`.
- Each request is `{"model":"...","arguments":{...},"output":{"directory":"generated","name":"name"}}`.
  Both output fields are required. Output naming is not a Model argument;
  Runtime derives the actual extension.
- Audio Model requests default to `10m`. `--timeout` accepts positive `s`, `m`, or
  `h`; there is no automatic retry.
- The CLI waits by default. `--no-wait` returns an Operation id for later
  inspect, wait, or cancel; disconnecting does not cancel accepted work.
- Batch supports every audio Model Kind, defaults to concurrency `1`, and can
  exit 0 with failed Items because Batch success means all Items settled.
- Use `--replace` only when actual commit-time replacement is intended.
- An output inside an open Project becomes an ordinary Project Tree entry and
  therefore belongs to the Canvas automatically. Report Artifact paths and
  structured errors.

## Workflow

1. Select TTS, music, or sound-effect and inspect required local inputs.
2. List, select, and describe a configured Model for that Kind.
3. Write schema-valid JSONL Model Requests.
4. Submit one Single or Batch Operation and report every settled result.
