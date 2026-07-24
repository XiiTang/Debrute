# Canvas Architecture

Canvas is the visual organization and review context for Project files. This
page records its current document, layout, and interaction boundaries. Exact
schemas and algorithms remain source-owned.

## Source, Pushed State, And Projection

One Canvas ID connects three representations:

1. `.debrute/canvas-maps/<canvas-id>.yaml` is source intent for membership and
   optional automatic comparison rows.
2. `.debrute/canvases/<canvas-id>.json` is pushed visual state: name, node
   rectangles, stack order, annotations, and preferences.
3. A Canvas Projection is the runtime view. It combines the JSON document with
   current Project availability and derives direct parent-child structure edges
   and diagnostics.

Canvas Map and Canvas JSON are not interchangeable sources of truth. Map push
reconciles the selected current files into JSON. Interactive Project loading
uses the same push pipeline; read-only project status reports document drift
instead of writing it. `debrute canvas-map push <project> <canvas-id>` provides
the explicit Agent-facing command.

Dragging an existing Project file or directory onto Canvas updates the active
Canvas Map with an exact-file or recursive-directory rule and commits the map
and reconciled Canvas JSON together. The drop point does not become persisted
layout intent.

## Membership And Hierarchy

Canvas Map `paths` contains positive rules only:

- a string file path selects that exact file;
- a string ending in `/` recursively selects files below that directory;
- `{ glob: <pattern> }` explicitly selects matching files.

Rules select files, not durable directory membership. Expansion adds the
Project root and every ancestor directory required to display selected files.
Missing exact files, missing or empty recursive directories, and unmatched
globs are quiet future intent. Unsafe paths, malformed YAML, type mismatches,
negative rules, and ambiguous row ownership are errors.

Expansion uses the Project visible-path policy. Debrute does not hide all of
`.debrute/`: source and pushed Project Documents can be selected like other
visible files. Cache trees, rendered feedback artifacts, lock paths, Git
metadata, and Debrute-managed temporary files are excluded before Canvas Map
expansion.

Hierarchy is derived from normalized project-relative paths. A structure edge
exists only from a present directory node to a present direct child; neither
Canvas Map nor Canvas JSON stores an edge list.

## Registry And Identity

The Canvas registry stores a complete ordered list of Canvas IDs. A valid
registry has exactly one JSON/YAML pair for every ID and no unregistered Canvas
documents. New Projects start with `canvas-1`; creating a Canvas writes an empty
map, empty Canvas document, and new registry order atomically. A Canvas rename
changes only its display name. Reordering requires a complete permutation, and
the final Canvas cannot be deleted. Registry repair keeps valid pairs and
rebuilds their order deterministically.

Registry, map, and Canvas mutations use expected content hashes and structured
Project Document transactions. Conflicting disk edits fail rather than being
silently overwritten.

## Automatic And Manual Layout

Automatic layout is deterministic and independent of Canvas Map `paths` order.
It arranges the Project root and directory hierarchy in depth columns and orders
sibling blocks naturally. Directories remain hierarchy nodes. Files are either
ordinary child blocks or members of explicit horizontal rows.

`layout.rows` contains file globs. A rule affects only files already selected by
`paths`, splits them by direct parent directory, and places each group left to
right. A selected file cannot belong to multiple explicit rows. Remaining
direct-child files form default rows per parent, so one file is controlled by
one row block. Mixed-height row members are vertically centered.

Layout size is resolved before placement. Images and videos use intrinsic
dimensions. Text and audio use fixed sizes. Directory and unknown-file cards
use compact fixed-height sizes whose width is clamped from the display label.
Failure to resolve required media dimensions fails the push; the layout engine
does not invent fallback dimensions.

Moving or resizing a node persists its new rectangle with manual layout mode.
Map reconciliation preserves a surviving manual rectangle and excludes that
node's rectangle from automatic placement and overlap guarantees. Traversal
still reaches automatic descendants of a manual directory, and an explicit row
still reserves each member's theoretical slot even when its durable rectangle
is manual. Reset Layout removes manual mode for selected path rules or all
nodes, then runs the same map reconciliation.

## Stack Order

Every Canvas Node has persisted stack order independent of its hierarchy and
layout mode. Selecting one node brings it to front, compacting the
back-to-front order while preserving the relative order of all other nodes. DOM
order stays deterministic by path while CSS stacking reflects the persisted
order; the Project tree is not a layer panel.

## Workbench Interaction State

`CanvasEditorRuntime` owns the live camera, camera activity state, selection,
pointer drag state, surface measurement, and coordinate conversion. These are
Workbench session state and are not persisted in Canvas JSON.

Wheel input pans by default and Ctrl/Cmd-wheel zooms around the pointer; native
gesture input uses the same camera model. Canvas handles input on its surface
and Canvas floating bars, except controls marked for local scrolling. Textual
or scrollable bodies use focus-gated local wheel handling: they keep wheel
input only while focus is inside them.

Selection can contain Canvas Nodes and diagnostics. Additive modifiers toggle
items. Moving a selected node moves the selected node group from shared origin
geometry; resizing acts on one node, clamps to a minimum size, and applies the
media-aware aspect-ratio rule.

During move and resize, a local layout draft is the visual geometry. Node
shells, connected edges, culling retention, and overlays read that same draft.
On pointer release, Workbench keeps the pending draft until the persisted
projection confirms the same rectangles, preventing a release-time snap-back.
A failed commit drops the pending draft and renders the durable projection.

The minimap is derived from current node bounds, camera, surface size, and
selection. Clicking or dragging its viewport recenters the existing camera
without changing zoom. It is a navigation projection, not persisted Canvas
state.

## Runtime And Rendering Ownership

- `CanvasEditorRuntime` owns camera, coordinates, input, selection, and drag
  state.
- `CanvasRenderCoordinator` combines projection, local layout drafts, selection,
  active nodes, and virtualization into one render snapshot.
- `CanvasStageRuntime` performs cached stage-camera and node-shell DOM writes.
- `CanvasOverlayRuntime` places screen-space overlays from Canvas geometry.
- React composes controls and node content; it does not become the per-pointer
  geometry store.

Rendering performance, image preview loading, resource scheduling, derived
cache identity, and diagnostic tracing are documented in
[`canvas-rendering.md`](./canvas-rendering.md). Text and video preview details
remain owned by their feature-specific source and documentation. Project text
access, CodeMirror editing, Text Viewport persistence, and Canvas raster-preview
handoff are documented in [`text-files.md`](./text-files.md). Image, audio, and
video presentation, Playback Position, player lifecycle, and video previews are
documented in [`canvas-media.md`](./canvas-media.md). Project-scoped review
state, media annotations, video moments, and rendered review artifacts are
documented in [`canvas-feedback.md`](./canvas-feedback.md).

## Executable Authorities

- Documents, reconciliation, projection, layout, and stack order:
  `packages/canvas-core/src/`.
- Canvas Map parsing and expansion: `packages/canvas-map-core/src/`.
- Push, registry, dimensions, and persistence:
  `apps/runtime/src/project/canvas_map.rs`, `canvas.rs`, and `service.rs`.
- Camera, selection, local drafts, minimap, and rendering:
  `apps/web/src/workbench/canvas/`.
- Visible Project paths: `packages/project-core/src/projectPaths.ts`.
- Protocol request and snapshot shapes: `packages/app-protocol/src/`.
