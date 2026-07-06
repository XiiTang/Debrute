---
name: debrute-core
description: Use when an external Agent needs Debrute project semantics through the debrute command, including project status, visual Workbench runtime URLs, Canvas Map pushing, generated assets, and model-backed generation.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.2
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
debrute workbench start
debrute canvas-map push /path/to/project canvas-1
debrute generated-asset lookup /path/to/project --path generated/example.png
debrute models image list
debrute models image describe gpt-image-2
debrute generate image /path/to/project --input-json '{"model":"gpt-image-2","arguments":{"prompt":"Cover image","output_path":"generated/cover.png"}}' --timeout-ms 600000
debrute generate image-batch /path/to/project --manifest image-requests.json --timeout-ms 900000 --log image-results.jsonl --summary image-summary.json
debrute models video list
debrute models video describe doubao-seedance-2-0-260128
debrute generate video /path/to/project --input-json '{"model":"doubao-seedance-2-0-260128","arguments":{"prompt":"Short video brief","intent":"generate"}}' --timeout-ms 600000
debrute models tts list
debrute models tts describe openai-gpt-4o-mini-tts
debrute generate tts /path/to/project --input-json '{"model":"openai-gpt-4o-mini-tts","arguments":{"text":"Welcome to Debrute.","voice":"alloy","output_path":"generated/welcome.mp3"}}' --timeout-ms 600000
debrute models music list
debrute models music describe elevenlabs-music
debrute generate music /path/to/project --input-json '{"model":"elevenlabs-music","arguments":{"prompt":"Warm ambient electronic music for a product demo.","output_path":"generated/demo-music.mp3"}}' --timeout-ms 600000
debrute models sfx list
debrute models sfx describe elevenlabs-sound-effects
debrute generate sfx /path/to/project --input-json '{"model":"elevenlabs-sound-effects","arguments":{"prompt":"Short glass chime.","output_path":"generated/chime.wav"}}' --timeout-ms 600000
debrute commands
```

`generate image-batch --manifest` reads a canonical JSON object with a `requests` array.

## Visual Workbench

Use the Workbench when visual inspection helps: Canvas layout, image previews, generated assets, or project file structure.

Start or discover the local Workbench runtime:

```sh
debrute workbench start
```

Read `web_url` from stdout. Interactive users open projects from the Workbench `Open Project` picker. Agents and automation build the project URL from the absolute local project path:

```text
project_url=<web_url>/open?path=<encodeURIComponent(absProjectPath)>
```

Open that URL with the current agent environment's own GUI/browser capability. Debrute CLI returns the runtime base URL and ports; it does not open browsers or projects.

Examples:

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
  - glob: outputs/gpt/*.png
  - prompts/cover.md
layout:
  rows:
    - outputs/**/high/*.png
```

String rules under `paths` are literal project paths. Folder rules must end with `/`, for example `outputs/gpt/`. Use object rules such as `glob: outputs/**/*.png` only when wildcard matching is intended. A folder node appears automatically when matching files exist below that folder. Exact file rules and glob rules match files. Missing future files are allowed and do not produce diagnostics.

Rows never add files to the Canvas. Each `layout.rows` glob matches included files, then splits matches into one horizontal row per direct parent directory.

Do not use CLI commands to add, remove, inspect, or modify Canvas nodes or edges.
Maintain the Canvas Map while creating file-producing scripts, prompts, image requests, or video requests.
When output paths are known before generation starts, add matching literal file/folder entries or explicit `glob:` entries under `paths` and push before running generation.

## Canvas Feedback

Canvas feedback is stored as current state in:

```text
.debrute/reviews/canvas-feedback.json
```

Missing file means there is no Canvas feedback. Entries are keyed by project-relative path. The `marks` array contains only selected marks; unselected marks are absent. The mark set is `like`, `dislike`, `check`, `cross`, `pending`, `important`, and `needs_revision`.

Entries use one unified `items` array for file-level comments, image spatial items, and video moment items:

```json
{
  "projectRelativePath": "assets/page.png",
  "marks": ["needs_revision"],
  "nextMomentLabel": 2,
  "nextSpatialLabel": 3,
  "items": [
    {
      "id": "item-file-comment",
      "kind": "comment",
      "scope": "file",
      "comment": "overall note",
      "createdAt": "2026-06-21T12:00:00.000Z",
      "updatedAt": "2026-06-21T12:00:00.000Z"
    },
    {
      "id": "item-pin-1",
      "kind": "pin",
      "scope": "file",
      "label": 1,
      "geometry": { "type": "point", "x": 0.42, "y": 0.31 },
      "comment": "face is blurry",
      "createdAt": "2026-06-21T12:00:00.000Z",
      "updatedAt": "2026-06-21T12:00:00.000Z"
    },
    {
      "id": "item-rect-2",
      "kind": "region",
      "scope": "file",
      "label": 2,
      "geometry": { "type": "rect", "x": 0.1, "y": 0.55, "width": 0.32, "height": 0.18 },
      "comment": "make this background brighter",
      "createdAt": "2026-06-21T12:00:00.000Z",
      "updatedAt": "2026-06-21T12:00:00.000Z"
    }
  ],
  "updatedAt": "2026-06-21T12:00:00.000Z"
}
```

Spatial feedback geometry is normalized to media content, not Canvas screen position. Rectangle geometry uses a normalized bounding box. Use the rendered annotated image to understand the visual location. For an image at project-relative path:

```text
<projectRelativePath>
```

the rendered annotated image is:

```text
.debrute/reviews/rendered-feedback/<projectRelativePath>.annotated.png
```

For a video moment item, the rendered annotated image is:

```text
.debrute/reviews/rendered-feedback/<projectRelativePath>.moment-<M#>.annotated.png
```

The rendered image shows only numbered pins and rectangle outlines. Match each visible number to the `label` on spatial `items`. Comment text is in JSON and is intentionally not rendered into the image. Moment labels are `M#`; moment frames provide timestamp context but do not burn the moment label into the image.

No dedicated Canvas feedback CLI exists. Read `.debrute/reviews/canvas-feedback.json` and rendered annotated images with the external Agent's filesystem tools when appropriate.

Do not edit files under `.debrute/reviews/rendered-feedback/`. Do not generate or refresh rendered annotated images yourself. If feedback contains contradictory or abnormal combinations, ask the user for confirmation before batch processing, deleting, regenerating, or otherwise applying broad changes.
