# Product Model

This page defines Debrute's Project, Canvas, Capability, and storage boundaries.
Canonical vocabulary is indexed in the [Context Map](../CONTEXT-MAP.md).

## Project

A Project is one existing local directory identified by its canonical absolute
root. The directory is the source of truth for its files.

Runtime owns one Project Session and one shared Project Tree per live canonical
root. Explorer and Canvas are independent projections of that tree. The tree
loads the root immediately and other directories on demand. Dotfiles,
Git-ignored entries, and `.debrute/` remain visible. Version-control internals,
fixed operating-system debris, symbolic links, and non-regular entries are
excluded. Partial or failed reads never prove deletion.

The only Debrute-owned Project state is Feedback:

```text
.debrute/feedback/feedback.json
.debrute/feedback/artifacts/**
```

Feedback targets ordinary Project files outside `.debrute`.

## Canvas

Canvas is a visual file manager for one Project. Every Project Tree entry
belongs to every Canvas. Folder Disclosure controls which descendants are
visible independently on each Canvas; Explorer expansion remains independent.

Canvas state is one Runtime-global document per canonical root:

```text
~/.debrute/state/roots/<rootKey>/canvas.json
```

`rootKey` is the lowercase SHA-256 of the canonical-root UTF-8 bytes. The
document repeats `canonicalRoot` so Runtime can reject a mismatched bucket. It
contains `activeCanvasId` and an ordered `canvases` array; each Canvas contains
its ID, Name, Folder Disclosure, sparse node-local state, and bottom-to-top
`occlusionOrder`. It does not persist Project membership, hierarchy, node kind,
Automatic Layout, Selection, camera, or drag drafts.

Explorer file double-click and Reveal in Canvas disclose the active Canvas's
ancestors, center the target, focus Canvas, select it, and apply the ordinary
selection raise rule. Canvas folder click toggles disclosure on pointer-up when
movement stays within the activation threshold; dragging performs Manual
Layout.

Known Rename or Move operations prefix-rewrite sparse Canvas paths, accepted
Feedback paths, and text and Feedback Working Copies. Confirmed deletion prunes
them; overwrite prunes the destination before rewriting the source. Watcher
uncertainty, shallow projections, and directory read failures never authorize
cleanup. A secondary-state persistence failure does not roll back the completed
filesystem mutation; the same Project revision contains one Error diagnostic
until the next successful related path mutation.

Invalid, unreadable, or root-mismatched Canvas state remains unchanged but does
not block the Project. Explorer, editor, and terminal remain available while
the whole Canvas workspace is unavailable with one exact code and message. The
user may explicitly reset it to one default `Main` Canvas without a second
confirmation or backup. Reset failure leaves Canvas unavailable.

See [Canvas architecture](./canvas.md) for the complete contract.

## Capabilities

Capabilities are structured Runtime-backed operations: Project semantics,
image, video, TTS, music, and sound-effect Model Requests, and generated-file
provenance lookup. There is no generic text-LLM capability or provider-level
model abstraction.

Every Model Request supplies an `output` object with `directory` and `name`.
The directory and declared local paths inside model `arguments` may be absolute
or relative to the CLI working directory; Runtime canonicalizes them at
Operation admission. A Model Request never opens or binds a Project. Artifact
Pointers record the actual absolute output path. For each actual extension,
one output uses `name.ext` and multiple outputs use `name_1.ext`,
`name_2.ext`, and so on.

## Integrations And Professional Tools

Integrations are optional Runtime-detected local capabilities managed through
Settings. Photoshop transfer is a separate live-session protocol. Both consume
canonical Project roots and Project Paths; neither defines Project identity.
See [Integrations](./integrations.md) and [Photoshop](./photoshop.md).

## Skills

Official Skills and the stable `debrute` entrypoint are materialized from the
selected Product version under `~/.agents/skills`. External Agents use their own
filesystem tools for generic file access and the CLI for Runtime-backed
capabilities.

## Storage Boundaries

```text
<project>/.debrute/feedback/feedback.json
<project>/.debrute/feedback/artifacts/**

~/.debrute/config/global_settings.json
~/.debrute/config/secrets.json
~/.debrute/state/roots/<rootKey>/canvas.json
~/.debrute/state/roots/<rootKey>/working-copies.json
~/.debrute/cache/roots/<rootKey>/canvas/**
~/.debrute/model-artifacts/<hash>.json
```

Renderer code does not read or write these files directly. Runtime is the
privileged persistence, Project Path, Model Request, and global-state boundary.
Workbench API project-scoped paths use an opaque temporary `bindingId`; the
binding is connection authority, not identity or persistence. Reload creates a
new binding while canonical-root state remains available.
