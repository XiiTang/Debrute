---
name: debrute-core
description: Use when an external Agent needs Debrute project semantics through the debrute command, including project status, visual Workbench access, Model Artifacts, and Model Requests.
metadata:
  debrute.managed: "true"
  debrute.package: "debrute"
  debrute.version: 0.0.4
---

# Debrute Core

Use `debrute` as the Debrute execution interface. Debrute Skills describe how to call the CLI; they are standard Skills, not Debrute APIs.

## Basic Rules

- Read Debrute CLI stdout as unversioned `debrute` Agent Records.
- Treat Project Path values as project-relative. Root arguments may be absolute
  or relative to the CLI working directory. The CLI resolves relative roots
  against that directory; Runtime canonicalizes them only during Project
  admission.
- Use the external Agent's filesystem tools for generic file reads, directory listings, writes, and deletes.
- Do not edit files under `~/.agents/skills` directly.
- Use the external Agent's Skills system to discover and read Skills.
- Surface structured CLI errors to the user when a command returns `debrute error`.

## Common Commands

```sh
debrute runtime status
debrute project status /path/to/project
debrute project validate /path/to/project
debrute workbench url ./
debrute workbench start ./ --frontend desktop
debrute model-artifact lookup --path generated/example.png
debrute models image list
debrute models image describe gpt-image-2
debrute request single --input image-request.jsonl --timeout 10m
debrute request batch --input image-requests.jsonl --concurrency 3
debrute models video list
debrute models video describe doubao-seedance-2-0-260128
debrute request single --input video-request.jsonl --timeout 30m
debrute models tts list
debrute models tts describe openai-tts-1
debrute request single --input tts-request.jsonl
debrute models music list
debrute models music describe elevenlabs-music
debrute request single --input music-request.jsonl
debrute models sfx list
debrute models sfx describe elevenlabs-sound-effects
debrute request single --input sound-effect-request.jsonl
debrute operation list --state active
debrute operation wait <operation-id>
debrute operation cancel <operation-id>
debrute commands
```

Single accepts either strict JSONL or direct
`--model <id> --arguments <JSON-object> --output <JSON-object>` options. Do not
combine `--input` with any direct request option. Batch is JSONL-only. Each
record is
`{"model":"...","arguments":{...},"output":{"directory":"generated","name":"name"}}`.
Both output fields are required. `directory` and Model-declared local paths in
`arguments` may be absolute or relative to the CLI working directory. Model
Requests have no Project positional and never open a Project. Runtime derives
actual extensions; matching extensions get independent `_1`, `_2`, and later
suffixes only when more than one such Artifact exists. Use `request batch` for
any peer Model Kind instead of looping over Single commands.
Redirect the Agent Record stdout stream when a retained file copy is needed;
for detached work, use the returned Operation id with `operation wait`.

## Visual Workbench

Use the Workbench when visual inspection helps.

For browser use, obtain the exact current Workbench URL for the Project and open
it in the browser requested by the user. If none is specified, prefer the
current Agent harness's built-in browser. Reuse a confirmed current Debrute
origin when available; otherwise run:

```sh
debrute workbench url [<project>]
```

For Desktop use:

```sh
debrute workbench start [<project>] --frontend desktop
```

`--frontend browser` remains available when direct activation of the system
default browser is requested.

## Canvas and Project files

Every regular Project file and directory appears on the Canvas. The Project
folder hierarchy defines Canvas hierarchy and structure edges. A user controls
the currently visible descendants by expanding or collapsing folders on that
Canvas; Explorer expansion is independent.

Use ordinary filesystem tools or Runtime-backed Model Request commands to create
Project files. New outputs beneath an open Project become ordinary Project Tree
entries automatically and start with default Canvas state. Canvas state is one
Runtime-global document per Canonical Root under
`~/.debrute/state/roots/<rootKey>/canvas.json`; do not edit it directly.

## Canvas Feedback

Canvas feedback is stored as current state in:

```text
.debrute/feedback/feedback.json
```

Missing file means there is no Canvas feedback. Entries are keyed by exact
Project Paths; the Project root uses `""`. Files, directories, and root may each
have independent entries, but `.debrute/**` cannot be a Feedback target.
Directory feedback does not apply to descendants. Delete removes Feedback for
that path subtree. Rename and Move rewrite the source path or directory prefix;
overwrite prunes the destination before rewriting the source. The `marks` array
contains only selected marks; unselected marks are absent. The mark set is
`like`, `dislike`, `check`, `cross`, `pending`, `important`, and
`needs_revision`.

Entries use one unified `items` array for node comments, image spatial items, and video moment items. Node comments are valid for every Project Path target; node-scoped spatial items require image files, and moment-scoped items require video files:

```json
{
  "projectRelativePath": "assets/page.png",
  "marks": ["needs_revision"],
  "nextMomentLabel": 2,
  "nextSpatialLabel": 3,
  "items": [
    {
      "id": "item-node-comment",
      "kind": "comment",
      "scope": "node",
      "comment": "overall note",
      "createdAt": "2026-06-21T12:00:00.000Z",
      "updatedAt": "2026-06-21T12:00:00.000Z"
    },
    {
      "id": "item-pin-1",
      "kind": "pin",
      "scope": "node",
      "label": 1,
      "geometry": { "type": "point", "x": 0.42, "y": 0.31 },
      "comment": "face is blurry",
      "createdAt": "2026-06-21T12:00:00.000Z",
      "updatedAt": "2026-06-21T12:00:00.000Z"
    },
    {
      "id": "item-rect-2",
      "kind": "region",
      "scope": "node",
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
.debrute/feedback/artifacts/<projectRelativePath>.annotated.png
```

For a video moment item, the rendered annotated image is:

```text
.debrute/feedback/artifacts/<projectRelativePath>.moment-<M#>.annotated.png
```

The rendered image shows only numbered pins and rectangle outlines. Match each visible number to the `label` on spatial `items`. Comment text is in JSON and is intentionally not rendered into the image. Moment labels are `M#`; moment frames provide timestamp context but do not burn the moment label into the image.

No dedicated Canvas feedback CLI exists. Read
`.debrute/feedback/feedback.json` and rendered annotated images with the
external Agent's filesystem tools when appropriate.

Do not edit files under `.debrute/feedback/artifacts/`. Do not generate or
refresh rendered annotated images yourself. If feedback contains contradictory
or abnormal combinations, ask the user for confirmation before batch
processing, deleting, regenerating, or otherwise applying broad changes.
