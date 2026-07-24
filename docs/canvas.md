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

Canvas Map, Canvas JSON, and the Canvas registry each have one closed current
shape. Unknown fields at any persisted nesting level are invalid rather than
ignored. An invalid Canvas JSON remains unchanged on disk, is excluded from the
snapshot, and produces `document_invalid_pushed`; an invalid registry produces
`canvas_registry_invalid`. Loading does not strip fields or rewrite either
document. A later explicit push or registry repair may construct a valid current
document as a new user-requested operation. These Canvas failures do not prevent
Project files from being listed, read, or edited.

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
rebuilds their order deterministically. Complete absence of Canvas registry,
JSON, and map state creates a new default Canvas automatically. Partial Canvas
state is preserved and reported as invalid instead of being guessed, deleted,
or allowed to block access to Project files. An explicit repair keeps every
valid pair and uses the ordinary Push semantics to rebuild missing or invalid
Canvas JSON from each valid Canvas Map. It never derives a Map from Canvas JSON.
Repair prepares every valid Map before it writes anything, then commits all
rebuilt Canvas documents, deletions, and the registry in one transaction. It
deletes orphan JSON, invalid Maps, and any remaining unrecoverable Canvas
metadata; when no valid Map remains, it creates a new default Canvas. Repair
does not create a backup, quarantine, migration, or compatibility copy, and it
never changes ordinary Project files.

Registry, map, and Canvas mutations use expected content hashes and structured
Project Document transactions. Registry repair also validates the captured Map
and Canvas directory membership at commit. Conflicting disk edits fail rather
than being silently overwritten.

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

Interactive Canvas state commits are exact actions, not optional or
best-effort batches. Before a request is sent, Workbench may discard a late
local interaction whose target is no longer present in the current Canvas
Projection. Once a request reaches Runtime, every target must identify one
current Canvas Node of the required kind. Empty collections, duplicate targets,
unknown input fields, missing nodes, wrong node kinds, and invalid numeric
values reject the whole request without persisting any member.

A discarded pre-request interaction is silent because it never became a commit
attempt. A request rejected by Runtime or not written to disk is an observable
commit failure: Workbench removes the corresponding optimistic state, renders
the latest durable projection, and reports the failure once. The owning action
handles and reports that rejection; an outer UI event boundary may consume the
already-handled Promise rejection only to prevent an unhandled-rejection event.
Workbench does not retry, reload, queue recovery work, or replace the failed
mutation with a full-document write.

A manual layout update contains at least one unique current node rectangle. A
Playback Position update targets only current video file nodes, and a Text
Viewport update targets only current text file nodes. A selective Reset Layout
request contains explicit `paths` and `globs` arrays with at least one rule
between them; a full reset uses the separate `all` shape.

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

During move and resize, a Manual Layout Draft is the visual geometry. Node
shells, connected edges, culling retention, and overlays read that same draft.
On pointer release, Workbench submits the draft immediately and keeps presenting
it until the Canvas Projection confirms the same rectangles or a target node
disappears. A submitted draft is presentation state, not Canvas Document state.
A successful mutation outcome closes the Runtime command but does not itself
confirm presentation. Confirmation requires exact rectangle equality in the
already revision-ordered Canvas Projection; `projectRevision` orders authority
but is not a substitute for that geometry check.

Workbench accepts another move or resize while earlier Manual Layout Drafts are
still awaiting confirmation. Presented geometry composes the newest Canvas
Projection, every still-unconfirmed submitted draft in submission order, and
then the active draft; a later draft wins for the same node. A new interaction
starts from that presented geometry rather than from an older Canvas Projection.
Each submission retains its own identity but is sent immediately: this ordering
is not a delayed mutation queue, retry mechanism, or editable history.

When Canvas Projections confirm submissions in stages, Workbench removes only
the confirmed contributions and continues to present every later submitted or
active draft. When one node's rectangle confirms a newer submission, every
older submitted draft for that node is also obsolete and cannot reappear; drafts
for other nodes remain independent. A failed commit removes only its own
submitted draft. Later submissions remain valid because each carries final
absolute rectangles rather than deltas that depend on an earlier commit
succeeding. Workbench renders the latest Canvas Projection plus those remaining
drafts and reports each failure once. Manual Layout Drafts never cross Canvas
identity. Workbench does not retry, reload, or synthesize a full-document write.
Switching Canvas, replacing the Project binding, or disposing the owning
`CanvasEditorRuntime` drops all active and submitted drafts for that instance.
An already-sent Runtime mutation is neither cancelled nor replayed; its late
completion cannot republish disposed presentation. A later open starts only
from the current authoritative Canvas Projection, and Manual Layout Drafts are
not Working Copies or browser-persisted recovery state.

Text scrolling uses the same authority distinction without treating a local
copy of the Canvas Document as committed state. Workbench displays the newest
pending Text Viewport immediately while Runtime remains the sole validator and
writer. A successful mutation outcome closes the Runtime command but does not
confirm presentation. Only an accepted, revision-ordered Canvas Projection
whose Text Viewport exactly matches the submitted value confirms that local
overlay. A newer pending viewport continues to win until its own exact Runtime
state is accepted, while newer authoritative Canvas fields remain intact. A
failed commit drops only its corresponding pending viewport, renders the latest
Runtime projection plus any newer pending value, and surfaces the failure;
Workbench does not retry the mutation automatically.

Playback Position commits may overlap at media event boundaries. A failed older
request cannot roll back or pause a newer submitted position; only the newest
still-pending request may restore the latest durable Runtime position.

Runtime exposes every available Canvas file and video text track with the one
relative URL shape
`/api/projects/<project-id>/files/raw/<project-path>?v=<revision>`. Workbench
preview builders consume that exact Runtime response; they do not accept an
absolute URL, invent an origin, or preserve additional query parameters.
Runtime adds these URLs to a typed projection before JSON serialization, so a
missing path, revision, or video-track field cannot be skipped or converted to
an empty value during public response construction.

The minimap is derived from current node bounds, camera, surface size, and
selection. Clicking or dragging its viewport recenters the existing camera
without changing zoom. It is a navigation projection, not persisted Canvas
state.

## Runtime And Rendering Ownership

- `CanvasEditorRuntime` owns camera, coordinates, input, selection, and drag
  state.
- One `CanvasRenderLifecycle` per mounted `CanvasSurface` owns the accepted
  Projection, render-related Runtime subscriptions, render scheduling,
  visibility sync, and the single externally published render snapshot.
  Pending moving work always recomputes from current Runtime and Manual Layout
  state.
- Its `CanvasRenderCoordinator` combines Projection, Manual Layout Drafts,
  selection, active nodes, and virtualization into that render snapshot.
- `CanvasStageRuntime` performs cached stage-camera and node-shell DOM writes.
- `CanvasOverlayRuntime` places screen-space overlays from Canvas geometry.
- React composes controls and node content; it does not become the per-pointer
  geometry store.

`CanvasSurface` always composes the required image, video, and text-preview
React providers around their consumers. Their hooks treat a missing provider as
a component-composition error and fail immediately with a specific message;
they do not substitute no-op functions, empty collections, or an absent preview
runtime. Ordinary empty files, unavailable media, and typed preview failures
remain normal feature states supplied by an installed provider. Tests that
render a consumer in isolation install an explicit fixture provider.

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

- Canvas documents, reconciliation, projection, layout, stack order, Canvas Map
  parsing and expansion, feedback mutation, and persistence:
  `apps/runtime/src/project/canvas_map.rs`, `canvas.rs`, `feedback.rs`, and
  `service.rs`.
- Shared Canvas declarations and browser presentation values:
  `packages/canvas-core/src/`.
- Camera, selection, Manual Layout Drafts, minimap, and rendering:
  `apps/web/src/workbench/canvas/`.
- Pending Text Viewport display and Runtime-result reconciliation:
  `apps/web/src/workbench/services/canvasSnapshotUpdates.ts`.
- Visible Project paths: `apps/runtime/src/project/paths.rs`.
- Protocol request and snapshot shapes: `packages/app-protocol/src/`.
