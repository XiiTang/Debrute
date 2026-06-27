---
name: debrute-video-director
description: Use for any task related to video generation or video editing in a Debrute project through the debrute command.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.2
---

# Debrute Video Director

Use for any task related to video generation or video editing.

Use `debrute` as the Debrute execution interface. Debrute Skills describe how to call the CLI; they are standard Skills, not Debrute APIs.

## Basic Rules

- Do not assume a model, argument shape, or default output path from memory.
- Run `debrute models video list` to compare configured video models by Debrute-native parameters and constraints.
- Use only models returned by `debrute models video list`.
- Before generation, run `debrute models video describe <model-id>` once for the selected model.
- Inspect the returned official documentation URLs, repository snapshot path, `description_markdown`, Debrute examples, and `arguments_schema`.
- Use `prompt`, `intent`, and `references`; do not assemble official Seedance `content` arrays.
- Do not include model API keys in generation requests; Debrute reads configured keys locally.
- Use the Debrute example command returned by `models video describe`; do not rely on source API curl or SDK snippets.
- Project-local image and audio references can be normalized by Debrute when the selected model supports them.
- Project-local video references require Debrute upload-server support unless the source is already `http(s)` or `asset://`.
- Submit the request with `debrute generate video /path/to/project --input-json '<json>'`.
- --timeout-ms defaults to 600000ms for video requests and covers task submission, polling, response reads, and artifact download.
- When project artifacts should be created, use output arguments supported by the selected model so generated files are written inside the project.
- Update the Canvas Map when planning video output paths. Add exact file, folder, or glob entries under `paths` in `.debrute/canvas-maps/<canvas-id>.yaml`; folder rules must end with `/`.
- Use `layout.rows` when generated video siblings should compare horizontally by direct parent directory.
- Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
- Surface structured CLI errors to the user when a command fails.

## Workflow

1. Read or derive the user's video generation or video editing brief.
2. Inspect project files or source media assets only when they are needed for the video task.
3. Run `debrute models video list` and compare configured models by Debrute-native parameters and constraints.
4. Choose a candidate from the returned models.
5. Before generation, run `debrute models video describe <model-id>` once for the selected model.
6. Build the request payload from `description_markdown`, the Debrute example, and `arguments_schema`.
7. Use `prompt`, `intent`, and `references`; do not assemble official Seedance `content` arrays.
8. When output paths or output globs are planned, update `.debrute/canvas-maps/<canvas-id>.yaml` so the generated files appear on that Canvas.
9. Push the Canvas Map with `debrute canvas-map push /path/to/project <canvas-id>`.
10. Run `debrute generate video /path/to/project --input-json '<json>'`.
11. Report artifact paths, generated asset metadata, and any structured errors.

## Error Handling

- If `models video list` returns no models, say Debrute returned no configured video models and do not invent one.
- If the selected model cannot be used, run `models video list` again and choose from the returned models or ask the user how to proceed.
- If a project-local video reference returns `video_reference_upload_unavailable`, report that the source must be `http(s)` or `asset://` until Debrute upload-server support is configured.
- If the CLI returns configuration, authentication, model request, validation, filesystem, or generated asset errors, preserve the structured error code, message, model id, and relevant logs.
- If request arguments do not match the selected model, fetch the model description again and rebuild the request from `description_markdown`, the Debrute example, and `arguments_schema`.
