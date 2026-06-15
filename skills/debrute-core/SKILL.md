---
name: debrute-core
description: Use when an external Agent needs Debrute project semantics through the debrute command, including project status, visual Workbench URLs, Canvas Map pushing, generated assets, and model-backed generation.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: "0.0.1"
---

# Debrute Core

Use `debrute` as the Debrute execution interface. Debrute Skills describe how to call the CLI; they are standard Skills, not Debrute APIs.

## Basic Rules

- Read Debrute CLI stdout as `debrute/1` Agent Records.
- Treat command path inputs as project-relative unless a command explicitly asks for an absolute project root.
- Use the external Agent's filesystem tools for generic file reads, directory listings, writes, and deletes.
- Do not edit files under `~/.agents/skills` directly.
- Use the external Agent's Skills system to discover and read Skills.
- Surface structured CLI errors to the user when a command returns `debrute/1 error`.

## Common Commands

```sh
debrute runtime status
debrute runtime doctor
debrute project init /path/to/project
debrute project status /path/to/project
debrute project validate /path/to/project
debrute workbench url /path/to/project
debrute canvas-map push /path/to/project canvas-1
debrute generated-asset lookup /path/to/project --path generated/example.png
debrute llm request --input-json '{"prompt":"Summarize this project."}'
debrute models image list
debrute models image describe gpt-image-2
debrute generate image /path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}' --timeout-ms 600000
debrute generate image-batch /path/to/project --manifest image-requests.json --timeout-ms 900000 --log image-results.jsonl --summary image-summary.json
debrute models video list
debrute models video describe doubao-seedance-2-0-260128
debrute generate video /path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"Short video brief","intent":"generate"}}' --timeout-ms 600000
debrute commands
```

`generate image-batch --manifest` reads a canonical JSON object with a `requests` array.

## Visual Workbench

When the user wants to view Debrute visually, run:

```sh
debrute workbench url /path/to/project
```

Read `project_url` from stdout. Open that URL with the current agent environment's own GUI/browser capability. Debrute CLI only returns URLs and ports; it does not open browsers.

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

## Canvas Maps

Canvas Map YAML controls which project files and folders appear on one Canvas. File structure defines hierarchy and structure edges.

Edit the Canvas Map whose filename matches the Canvas id:

```text
.debrute/canvas-maps/<canvas-id>.yaml
```

Push it:

```sh
debrute canvas-map push /path/to/project <canvas-id>
```

The YAML file is a top-level object. `paths` is the complete positive membership rule list. `layout.rows` is optional and controls horizontal rows for files already included by `paths`.

```yaml
paths:
  - outputs/gpt/
  - outputs/gpt/*.png
  - prompts/cover.md
layout:
  rows:
    - outputs/**/high/*.png
```

Folder rules under `paths` must end with `/`, for example `outputs/gpt/`. A folder node appears automatically when matching files exist below that folder. Exact file rules and glob rules match files. Missing future files are allowed and do not produce diagnostics.

Rows never add files to the Canvas. Each `layout.rows` glob matches included files, then splits matches into one horizontal row per direct parent directory.

Do not use CLI commands to add, remove, inspect, or modify Canvas nodes or edges.
Maintain the Canvas Map while creating file-producing scripts, prompts, llm requests, image requests, or video requests.
When output paths are known before generation starts, add matching file, folder, or glob entries under `paths` and push before running generation.

## Canvas Feedback

Canvas file-asset feedback is stored as current state in:

```text
.debrute/reviews/canvas-feedback.json
```

Missing file means there is no Canvas feedback. Entries are keyed by project-relative path. The `marks` array contains only selected marks; unselected marks are absent. The first feedback mark set is `like`, `dislike`, `check`, `cross`, `pending`, `important`, and `needs_revision`.

No dedicated Canvas feedback CLI exists. Read `.debrute/reviews/canvas-feedback.json` with the external Agent's filesystem tools when appropriate.

If feedback contains contradictory or abnormal combinations, ask the user for confirmation before batch processing, deleting, regenerating, or otherwise applying broad changes.
