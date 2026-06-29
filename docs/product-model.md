# Product Model

This page describes Debrute's project, Canvas, capability, integration, Skill, and storage boundaries.

## Project

A project is the local file workspace plus `.debrute/` metadata, generated assets, and health diagnostics.

The local folder remains the source of truth for project files. Debrute stores its own metadata under `.debrute/` and uses daemon/App Server boundaries for privileged operations.

## Canvas Map

Canvas Map YAML controls which project files and folders appear on one Canvas, plus optional automatic comparison rows.

A Canvas Map lives at:

```text
.debrute/canvas-maps/<canvas-id>.yaml
```

The Canvas with the same id is the map's target. The file is a top-level YAML object:

```yaml
paths:
  - outputs/gpt/
  - outputs/**/*.png
  - prompts/cover.md
layout:
  rows:
    - outputs/**/high/*.png
```

`paths` is the complete positive membership rule list. A trailing slash recursively includes files under that folder, a glob includes matching files, and an exact file rule includes one file.

`layout.rows` is optional. Each row glob affects files already included by `paths`, splitting matches into horizontal rows by direct parent directory.

## Canvas

Canvas is the visual workspace for projected Canvas Map nodes.

Canvas ids are stable internal keys. They are filesystem-safe slugs used as the file stem for Canvas JSON, Canvas Map YAML, registry ordering, active Canvas state, and preview cache identity.

Canvas names are editable display labels stored inside Canvas JSON. Names can use Unicode text and are not used in filesystem paths, URLs, registry ids, Canvas Map ids, or preview cache keys.

Canvas JSON under `.debrute/canvases/<canvas-id>.json` stores the Canvas id, display name, node layout, z-order, annotations, and preferences. File and folder hierarchy is derived from the project filesystem.

Push copies the current Canvas Map membership into Canvas JSON, while Canvas display always derives default structure from filesystem paths.

## Capabilities

Capabilities are discrete operations that the daemon-backed Web workbench or the `debrute` command can invoke: project semantics, image generation, video generation, and generated asset metadata lookup.

External Agents use their own filesystem tools for generic file access.

## Integrations

Integrations are optional local capabilities that the daemon detects and the Web Settings surface renders as command previews.

The first supported integrations are FFmpeg, ImageMagick, MediaInfo, ExifTool, and the `remove-ai-watermarks` CLI.

Integrations are not required for Debrute startup and are not exposed through the `debrute` command. Third-party tools are optional local dependencies; Debrute does not bundle or redistribute them, and users are responsible for complying with each tool's license.

## Skills

Skills are standard packages installed under `~/.agents/skills`.

The Desktop product payload includes the official `skills/debrute-*` bundle. Runtime materializes those official Skills from the current product payload during startup, alongside the managed `debrute` CLI.

## Storage Boundaries

Project metadata and canvas state live under `.debrute/`.

Generated asset metadata, generation model settings, and generation model secrets live in Debrute-owned runtime storage.

Renderer code does not read or write project files, generated asset metadata, model secret files, or Skills directories directly. Project and settings operations use the daemon/App Server boundary, while official Skills materialization is owned by the runtime.

The CLI and Skills product posture is command-first: Debrute provides commands, structured output, safety guidance, and Skills for external Agents while not being the Agent itself.

`debrute workbench start` starts or reuses the local Workbench runtime and returns base URLs and ports without opening a browser. Interactive users open projects through the Workbench `Open Project` picker. Agents open projects by constructing:

```text
<web_url>/open?path=<encodeURIComponent(absProjectPath)>
```

Project, Canvas Map, and generation commands are runtime-backed. The CLI starts or reuses the local runtime for those operations so project state, settings, generated asset metadata, managed CLI diagnostics, and official Skills status stay behind the daemon boundary.
