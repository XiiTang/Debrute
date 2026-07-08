---
name: debrute-audio-director
description: Use for any task related to TTS, music generation, or sound effect generation in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.3
---

# Debrute Audio Director

Use for any task related to TTS, music generation, or sound effect generation.

Use `debrute` as the Debrute execution interface. Debrute Skills describe how to call the CLI; they are standard Skills, not Debrute APIs.

## Basic Rules

- Do not assume a model, argument shape, or default output path from memory.
- Pick exactly one audio use case before listing models: TTS, music, or sound effects.
- For TTS, run `debrute models tts list`, use only models returned by that command, and run `debrute models tts describe <model-id>` once before generation.
- For music, run `debrute models music list`, use only models returned by that command, and run `debrute models music describe <model-id>` once before generation.
- For sound effects, run `debrute models sfx list`, use only models returned by that command, and run `debrute models sfx describe <model-id>` once before generation.
- Inspect the returned official documentation URLs, repository snapshot path, `description_markdown`, Debrute examples, and `arguments_schema`.
- Use original model parameter names shown by the matching list command and confirmed by the matching describe command.
- Do not include model API keys in generation requests; Debrute reads configured keys locally.
- Use the Debrute example command returned by the describe command; do not rely on source API curl or SDK snippets.
- Submit TTS requests with `debrute generate tts /path/to/project --input-json '<json>'`.
- Submit music requests with `debrute generate music /path/to/project --input-json '<json>'`.
- Submit sound effect requests with `debrute generate sfx /path/to/project --input-json '<json>'`.
- --timeout-ms defaults to 600000ms for audio requests and covers task submission, polling when the official API is task-based, response reads, artifact download, and artifact write.
- When project artifacts should be created, use output arguments supported by the selected model so generated files are written inside the project.
- Update the Canvas Map when planning audio output paths. Add literal file/folder entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`, and wildcard matching must use explicit `glob:` entries.
- Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
- Surface structured CLI errors to the user when a command fails.

## Workflow

1. Read or derive the user's TTS, music, or sound effect brief.
2. Inspect project files or source media assets only when they are needed for the audio task.
3. Select the matching audio CLI surface: `tts`, `music`, or `sfx`.
4. Run the matching `debrute models ... list` command and compare configured models by original model parameters and constraints.
5. Choose a candidate from the returned models.
6. Before generation, run the matching `debrute models ... describe <model-id>` command once for the selected model.
7. Build the request payload from the original parameter names confirmed by `description_markdown`, Debrute example, and `arguments_schema`.
8. When literal output paths or explicit `glob:` rules are planned, update `.debrute/canvas-maps/<canvas-id>.yaml` so the generated files appear on that Canvas.
9. Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
10. Run `debrute generate tts`, `debrute generate music`, or `debrute generate sfx` with the request JSON.
11. Report artifact paths, generated asset metadata, and any structured errors.

## Error Handling

- If the matching `models ... list` command returns no models, say Debrute returned no configured audio models for that use case and do not invent one.
- If the selected model cannot be used, run the matching list command again and choose from the returned models or ask the user how to proceed.
- If the CLI returns configuration, authentication, model request, validation, filesystem, or generated asset errors, preserve the structured error code, message, model id, and relevant logs.
- If request arguments do not match the selected model, fetch the model description again and rebuild the request from `description_markdown`, the Debrute example, and `arguments_schema`.
