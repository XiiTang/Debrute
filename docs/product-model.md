# Product Model

This page describes Debrute's project, Canvas, capability, integration, Skill, and storage boundaries.
Canonical domain vocabulary and context relationships are indexed in the
[Context Map](../CONTEXT-MAP.md).

## Project

A project is the local file workspace plus `.debrute/` metadata, generated assets, and current Project Diagnostics.

The local folder remains the source of truth for project files. Debrute stores its own metadata under `.debrute/`; Rust Runtime is the privileged persistence and operation boundary.

### Project Documents

Structured Debrute state under `.debrute/` is registered as Project Documents
with one of four roles: source, pushed, metadata, or cache. Source documents
express editable intent; pushed documents are persisted projections; metadata
preserves durable facts; cache documents are rebuildable. The executable
descriptor registry remains the authority for exact paths and allowed writers.

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
  - glob: outputs/**/*.png
  - prompts/cover.md
layout:
  rows:
    - outputs/**/high/*.png
```

`paths` is the complete positive membership rule list. Plain string entries are literal project paths: a trailing slash recursively includes files under that folder, and a file path includes one file. Wildcard matching is explicit with object entries such as `glob: outputs/**/*.png`.

`layout.rows` is optional. Each row glob affects files already included by `paths`, splitting matches into horizontal rows by direct parent directory.

## Canvas

Canvas is the visual workspace for projected Canvas Map nodes.

Canvas ids are stable internal keys. They are filesystem-safe slugs used as the file stem for Canvas JSON, Canvas Map YAML, registry ordering, active Canvas state, and preview cache identity.

Canvas names are editable display labels stored inside Canvas JSON. Names can use Unicode text and are not used in filesystem paths, URLs, registry ids, Canvas Map ids, or preview cache keys.

Canvas JSON under `.debrute/canvases/<canvas-id>.json` stores the Canvas id, display name, node layout, stack order, annotations, and preferences. File and folder hierarchy is derived from the project filesystem. Camera, selection, drag state, and render visibility are transient Workbench state rather than Canvas fields.

Push reconciles the current Canvas Map membership into Canvas JSON, preserving surviving manual layout and stack order while recomputing automatic nodes. Canvas display derives current availability and default structure from Project paths. See [Canvas architecture](./canvas.md) for registry, layout, and interaction boundaries.

## Capabilities

Capabilities are discrete operations that the Runtime-backed Web Workbench or the `debrute` command can invoke: Project semantics, image, video, TTS, music, and sound-effect generation, and generated asset metadata lookup. Debrute does not expose a generic text-LLM capability or a provider-level model abstraction.

External Agents use their own filesystem tools for generic file access.

Model catalogs, Configured Models, execution, structured results, Model Runs,
and generated-file provenance are documented in
[`model-generation.md`](./model-generation.md) and
[`generated-assets.md`](./generated-assets.md).

## Integrations

Integrations are optional local capabilities that Runtime detects and the Web Settings surface manages through Runtime-owned install, update, and uninstall actions.

The first supported integrations are FFmpeg, ImageMagick, MediaInfo, ExifTool, and the `remove-ai-watermarks` CLI.

Integrations are not required for Debrute startup and are not exposed through the `debrute` command. Third-party tools are optional local dependencies; Debrute does not bundle or redistribute them, and users are responsible for complying with each tool's license.

The fixed catalog, platform backends, status model, and runtime-owned operation
boundary are documented in [`integrations.md`](./integrations.md). Adobe Bridge
is a separate link-scoped protocol between open Projects and Photoshop plugin
clients; see [`photoshop-bridge.md`](./photoshop-bridge.md).

## Skills

Skills are standard packages installed under `~/.agents/skills`.

The Desktop Product seed includes the official `skills/debrute-*` bundle. Runtime materializes those official Skills and the stable `debrute` entrypoint from the selected immutable Product version.

## Storage Boundaries

Project metadata and canvas state live under `.debrute/`.

Generated asset metadata is Project-owned structured state under
`.debrute/assets/`. Debrute Model settings and API-key secrets are
runtime-global state under the Debrute home directory.

Renderer code does not read or write Project files, generated asset metadata, model secret files, or Skills directories directly. Project and settings operations use Runtime's role-partitioned transport, while official Skills materialization is owned by Runtime bootstrap.

The CLI and Skills product posture is command-first: Debrute provides commands, structured output, safety guidance, and Skills for external Agents while not being the Agent itself.

These surfaces share one local runtime authority. See
[`runtime-architecture.md`](./runtime-architecture.md) for runtime discovery,
browser authentication, global state, project sessions, terminal ownership, and
whole-product versioning.

`debrute workbench start [<project>] --frontend default|desktop|browser` sends one native Control activation and reports the accepted target as an Agent Record. It does not print or persist an authenticated URL. Interactive users can also open Projects through the Workbench picker.

Project, Canvas Map, and Model Request commands are Runtime-backed. During a
command, the CLI keeps its native Control connection alive so the corresponding
HTTP authorization cannot outlive that command. Project state, settings,
Generated Asset metadata, CLI diagnostics, and official Skills status remain
behind Runtime authority.
