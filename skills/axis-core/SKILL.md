---
name: axis-core
description: Use when an external Agent needs AXIS project semantics through axis-cli, including project status, visual Workbench URLs, Flowmap publishing, generated assets, and model-backed generation.
metadata:
  axis.managed: "true"
  axis.package: "axis"
  axis.version: "0.1.0"
---

# AXIS Core

Use `axis-cli` as the AXIS execution interface. AXIS Skills describe how to call the CLI; they are standard Skills, not AXIS APIs.

## Basic Rules

- Read AXIS CLI stdout as `axis/1` Agent Records.
- Treat command path inputs as project-relative unless a command explicitly asks for an absolute project root.
- Use the external Agent's filesystem tools for generic file reads, directory listings, writes, and deletes.
- Do not edit files under `~/.agents/skills` directly.
- Use the external Agent's Skills system to discover and read Skills.
- Surface structured CLI errors to the user when a command returns `axis/1 error`.

## Common Commands

```sh
axis runtime status
axis runtime doctor
axis project init /path/to/project
axis project status /path/to/project
axis project validate /path/to/project
axis workbench url /path/to/project
axis flowmap publish /path/to/project --from .axis/flowmaps/image-production.draft.yaml
axis generated-asset lookup /path/to/project --path generated/example.png
axis llm request --input-json '{"prompt":"Summarize this project."}'
axis models image list
axis models image describe gpt-image-2
axis generate image /path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}'
axis generate image-batch /path/to/project --manifest image-requests.json --log image-results.jsonl --summary image-summary.json
axis models video list
axis models video describe doubao-seedance-2-0-260128
axis generate video /path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"content":[{"type":"text","text":"Short video brief"}]}}'
axis commands
```

`generate image-batch --manifest` reads a canonical JSON object with a `requests` array.

## Visual Workbench

When the user wants to view AXIS visually, run:

```sh
axis workbench url /path/to/project
```

Read `project_url` from stdout. Open that URL with the current agent environment's own GUI/browser capability. AXIS CLI only returns URLs and ports; it does not open browsers.

Agent GUI examples:

```text
Qoder: /browser Open <project_url>
Antigravity: /browser Open <project_url>
Cline: Use the browser to check <project_url>
Codex app:
  await (await browser.capabilities.get("visibility")).set(true)
  await tab.goto(projectUrl)
```

If the agent cannot control a browser, report `project_url` to the user.

## Flowmaps

Flowmap YAML controls which files appear as Canvas nodes and which Canvases display that Flowmap. File structure defines hierarchy and structure edges.

Edit the draft file:

```text
.axis/flowmaps/<flowmap-id>.draft.yaml
```

Publish it:

```sh
axis flowmap publish /path/to/project --from .axis/flowmaps/<flowmap-id>.draft.yaml
```

The Flowmap id is the YAML filename. AXIS uses the project directory with the same name as the Flowmap id as the root directory for include matching:

```text
.axis/flowmaps/<flowmap-id>.draft.yaml
<flowmap-id>/
```

Use `include` to choose files under `<flowmap-id>/`. Matched files appear on Canvas with their ancestor directories. Use `canvases` to explicitly mount the Flowmap to one or more Canvases. An empty `canvases` list is valid and means the Flowmap is not mounted.

Minimal draft:

```yaml
schemaVersion: 1
canvases:
  - production-map
include:
  - "**/*.png"
```

Use `layout.groups` when a final or near-final output directory contains direct child files that should be compared side by side. The group only affects automatic Canvas layout for files already matched by `include`; it does not add files.

```yaml
schemaVersion: 1
canvases:
  - production-map
include:
  - outputs/**/*
layout:
  groups:
    - directory: outputs/gpt-image-2/2000x2000/high
      include:
        - "*.png"
    - directory: outputs/gemini-3.1-flash/4k
      include:
        - "*.png"
```

Add a horizontal group when files are direct siblings and comparable variants from the same prompt, model, size, quality, batch, render pass, or export format. Do not add one for source folders, scripts, logs, request files, deeply nested mixed-content directories, or folders where vertical tree reading is clearer.

Do not edit `.axis/flowmaps/<flowmap-id>.yaml` directly.
Do not use CLI commands to add, remove, inspect, or modify Canvas nodes or edges.
Maintain the Flowmap draft while creating file-producing scripts, prompts, llm requests, image requests, or video requests.
When output paths are known before generation starts, write them under `<flowmap-id>/`, add matching relative paths or globs to `include`, and publish before running generation.

## Canvas Feedback

Canvas file-asset feedback is stored as current state in:

```text
.axis/reviews/canvas-feedback.json
```

Missing file means there is no Canvas feedback. Entries are keyed by project-relative path. The `marks` array contains only selected marks; unselected marks are absent. The first feedback mark set is `like`, `dislike`, `check`, `cross`, `pending`, `important`, and `needs_revision`.

No dedicated Canvas feedback CLI exists. Read `.axis/reviews/canvas-feedback.json` with the external Agent's filesystem tools when appropriate.

If feedback contains contradictory or abnormal combinations, ask the user for confirmation before batch processing, deleting, regenerating, or otherwise applying broad changes.
