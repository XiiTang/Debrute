---
name: debrute-audio-director
description: Use for any task related to TTS, music generation, or sound effect generation in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.4
---

# Debrute Audio Director

Use `debrute` for the peer Model Kinds TTS, music, and sound-effect. `audio` is
only their settings and implementation group.

## Rules

- Pick the use case first. Run the matching `debrute models tts|music|sfx list`,
  choose only a returned configured Model, and run its `describe` command once.
- Build `arguments` only from the returned Debrute documentation, example, and
  `arguments_schema`; never include API keys.
- Submit strict JSONL through
  `debrute request single /path/to/project --input <request.jsonl>` or one
  `debrute request batch /path/to/project --input <requests.jsonl>`.
- Each record is `{"model":"...","arguments":{...},"output":{"directory":"generated","filename":"name"}}`.
  Output naming is not a Model argument and the filename has no extension.
- Audio Model Runs default to `10m`. `--timeout` accepts positive `s`, `m`, or
  `h`; there is no automatic retry.
- The CLI waits by default. `--no-wait` returns an Operation id for later
  inspect, wait, or cancel; disconnecting does not cancel accepted work.
- Batch supports every audio Model Kind, defaults to concurrency `1`, and can
  exit 0 with failed Items because Batch success means all Items settled.
- Use `--replace` only when actual commit-time replacement is intended.
- Update and push the Canvas Map when planned audio outputs should appear, then
  report Artifact paths and structured errors.

## Workflow

1. Select TTS, music, or sound-effect and inspect required Project inputs.
2. List, select, and describe a configured Model for that Kind.
3. Write schema-valid JSONL Model Requests.
4. Update and push the Canvas Map when needed.
5. Submit one Single or Batch Operation and report every settled result.
