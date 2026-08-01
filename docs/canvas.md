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
expansion. Glob rules filter the background Project index. Exact-file and
recursive-directory literals are explicit dependencies, so they may select a
visible path inside a `.gitignore`, dependency, cache, or generated directory;
Runtime then admits changes only for that named file or subtree. Unrelated
Project files never enter Canvas ordering or reconciliation work.

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
is manual. Reset Layout removes manual mode for exact selected Canvas Node
paths or for all nodes, then runs the same map reconciliation.

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
request contains a non-empty unique `nodePaths` array naming exact current
Canvas Nodes; a full reset uses the separate `all` shape.

## Canvas Node Selection

Canvas Node Selection is transient Workbench state containing only Canvas
Nodes. A Project Diagnostic may be selected on its own, but diagnostics never
mix with a Canvas Node Selection. Selection is neither persisted nor restored
per Canvas: switching Canvas, Project, or Runtime scope clears it. A current
Projection update retains surviving selected nodes, removes nodes no longer in
the Projection, keeps a one-item remainder in the same node-selection shape,
and never automatically selects newly projected nodes.

Empty, one-node, and many-node selections are cardinalities of this one Canvas
Node Selection, not separate selection states. A Selection Marquee is a
temporary pointer interaction that updates this selection; it is not another
selection state or persistent mode, and its result may contain zero, one, or
many nodes.

Plain node click selects one node. Shift or the platform additive modifier
(Command on macOS, Ctrl on Windows) toggles a node on click. Pointer-down on a
member of an existing multi-selection preserves the group: movement beyond
`4 CSS px` moves the group, release below that threshold collapses selection to
the pressed node, and cancellation restores the pointer-down selection. An
additive drag on an unselected node adds it before moving the expanded group;
an additive drag on an already selected node moves the group without removing
that node.

A Selection Marquee begins only from true Canvas blank space. Nodes, resize
handles, text or media interaction surfaces, Feedback, floating bars, and the
title bar retain their own pointer behavior; non-interactive Canvas edges count
as blank space. The marquee activates after `4 CSS px` of screen-space movement
and selects every Canvas Node whose currently displayed rectangle intersects
it, regardless of Stack Order, visual occlusion, or DOM culling. Its result is
recomputed on every pointer move. Without a modifier it replaces the initial
selection; with Shift or the platform additive modifier it unions with the
pointer-down selection. A below-threshold blank click clears selection without
a modifier and preserves it with an additive modifier.

The pointer-down anchor is fixed in Canvas coordinates. After activation, the
current pointer is converted through the latest camera on every
frame, so edge-driven camera movement extends the same marquee through Canvas
space instead of pinning its origin to a screen pixel. The displayed fill is
Canvas-aligned while its outline keeps a zoom-invariant `1 CSS px` width.

Marquee edge scrolling starts only after activation. Its edge zone is `8 CSS
px`, independent of zoom, with a `200 ms` delay and `200 ms` ease-in; speed
increases toward and beyond the viewport edge. The top edge begins below the
transparent title bar, while floating Canvas bars do not create additional
scroll edges. Pointer release commits the current selection. Escape, pointer
cancel, lost capture, Project or Canvas replacement, and interaction blocking
restore the pointer-down selection and stop edge scrolling.

Every selected node renders its own outline. A single selection retains its
eight resize handles; a multi-selection exposes group move only, with no group
bounds, resize, or rotation handles.

Canvas shortcuts are routed by focus domain and the active interaction owner.
An active marquee owns Escape even if focus moves during the gesture.
Otherwise, Canvas blank space and non-interactive nodes focus the Canvas root
and receive Canvas shortcuts; text editors, form controls, video, Feedback,
context menus, floating panels, and the title bar retain local behavior. Body
or other outside focus does not infer Canvas ownership from an existing
selection. Canvas-owned Command/Ctrl+A selects every node in the current
Projection, including offscreen, occluded, and culled nodes; text-editing
surfaces keep native text Select All. The Edit menu uses the same focus router.

Canvas-owned Escape consumes only the highest-priority applicable behavior. An
active Selection Marquee, node move, or resize cancels first and restores its
interaction-start selection and geometry without changing the file clipboard.
Otherwise, a pending Cut is cancelled while preserving selection. Otherwise,
a non-empty Canvas Node Selection is cleared. Escape is a no-op when none of
those conditions applies. Locally interactive surfaces retain their own Escape
behavior.

With Canvas shortcut ownership and a non-empty Canvas Node Selection,
Command/Ctrl+C and Command/Ctrl+X run the same filesystem Copy and Cut commands
as the Project Explorer. Move to Trash uses Command+Backspace on macOS and
Delete on Windows; Delete Permanently uses Command+Option+Backspace on macOS
and Shift+Delete on Windows. These shortcuts use the same batch resolution,
directory folding, exclusions, and confirmation behavior as their Project Path
Commands. They do nothing for an empty selection. Editable and other locally
interactive surfaces retain their native keyboard behavior.

Canvas-owned Command/Ctrl+V requires the current Canvas Node Selection to
contain exactly one current directory node and pastes into that directory; the
Project root is a valid destination. It is unavailable for an empty selection,
a file, a multi-selection, or a directory no longer present as such. The
keyboard command never substitutes a file's parent or chooses a directory from
a multi-selection. Locally editable surfaces retain native Paste. A context
menu may still Paste into its explicit directory invocation target while
preserving a wider Canvas selection.

The Canvas and Project Explorer project the same pending Cut clipboard. Every
effective Cut source root visible in either surface is presented at `50%`
opacity; a directory root alone represents its complete subtree, so projected
descendants are not separately dimmed unless they are independent effective
roots. Changing Canvas selection does not clear this presentation. Another
Copy or Cut, Canvas-owned Escape at the Cut-cancellation priority, source
deletion, or a successful Cut-Paste clears it; a failed Paste preserves it for
retry. Copy has no pending-source presentation.

Rename remains a Project Path Command exposed only by Project Explorer. Canvas
single- and multi-selection menus omit it, and Canvas shortcut ownership does
not assign F2 to filesystem rename. Batch rename and any Canvas-specific rename
editor are outside this selection contract.

Canvas shortcut ownership does not assign the arrow keys to node navigation or
keyboard movement. Nodes and multi-selections move only through pointer drag;
locally interactive media and text surfaces retain their own arrow-key
behavior. Keyboard nudge and spatial keyboard navigation are outside this
selection contract.

Media shortcuts require the Canvas Node Selection to contain exactly one video
node and the video behavior to own focus. A selection containing that video and
any other node does not route Space or arrow keys to the video, and a context
menu invocation target is never substituted for the current selection.

Right-clicking a selected member preserves the Canvas Node Selection and opens
a multi-selection menu. Right-clicking an unselected node first collapses to
that node and opens the single-node menu. A preserved multi-selection also
records the right-clicked node as that menu invocation's primary target. Batch
commands act on the Canvas Node Selection, while explicitly node-local commands
such as Open in Terminal act only on this invocation target. Open in Terminal
uses the directory itself or the containing directory of a file and never opens
one Terminal per selected directory. Reveal in Finder or File Explorer is also
invocation-target-only: it reveals that file, directory, or Project root while
preserving the Canvas Node Selection, never opens one system file-manager
location per selected node, and does not fall back to another selected node if
the invocation target no longer exists. Copy Paths and Copy Relative Paths
include every explicitly selected node, including explicitly selected
descendants of a selected directory; they emit one path per line in stable
project-relative-path order. Both commands complete through the Runtime-owned
system clipboard, so Browser and Desktop use the same native path-copy
contract. Copy Paths validates the complete existing batch before changing the
clipboard. Copy Relative Paths accepts unavailable Canvas nodes whose canonical
Project path is still valid and formats separators for the Runtime platform
(`\\` on Windows and `/` elsewhere); the canonical empty Project-root path is
presented as `.`.

Right-clicking true Canvas blank space clears the Canvas Node Selection without
starting a marquee, moving the camera, or changing stack order. It suppresses
the native browser context menu but opens no Canvas background menu. Nodes,
Feedback, floating bars, and other non-blank surfaces retain their own context
behavior; non-interactive Canvas edges follow the blank-space rule.

Reveal in Canvas is not a Project Path Command. A plain Project Explorer file
click already selects and centers that file when it has a node in the active
Canvas, while modified Explorer selection gestures do not navigate the Canvas.
A plain directory click retains its existing expand-or-collapse behavior and
does not locate or center a directory node; directories do not gain a
replacement navigation command.

Send to Photoshop remains available only for an eligible single-file
selection. A multi-selection menu omits it even when the invocation target is
an eligible file; it neither sends only that target nor sequences the selected
files through the single-file command. Debrute-to-Photoshop batch placement is
outside this selection contract and requires a separate design.

Show Details is selection-scoped. It preserves a multi-selection and opens an
Inspector summary containing the total, file and directory counts, availability
counts, and Manual Layout count. Single-node paths, geometry, and generated
metadata remain single-selection details and are not borrowed from the menu
invocation target.

Filesystem Copy and Cut share one Project Path Command pipeline. Their
effective source set deduplicates paths, treats each current selected directory
as one complete filesystem-subtree root, and removes explicitly selected
descendants covered by that root. Descendants need not be projected or selected
to travel with the directory. The Project root is not a filesystem Copy/Cut
source. Healthy Projection reconciliation removes deleted nodes and prunes
selection; if a transient or degraded Projection still exposes a top-level
`missing` node, the batch is unavailable rather than silently reduced. Canvas
`unreadable` alone does not make a source unavailable because it may describe a
preview failure for an otherwise valid file. Runtime revalidates the complete
effective source batch when Paste performs the copy or move; a failure never
becomes a silent partial Project Path Command.

Paste is a menu-invocation-target command rather than a Canvas Node Selection
batch command. Invoking it on a directory pastes once into that directory,
including when the directory is one member of a multi-selection. A file is not
implicitly replaced by its containing directory, so Paste is unavailable when
the invocation target is a file. The Project root may be a Paste destination
even though it cannot be copied, cut, or deleted. Paste preserves the existing
Canvas Node Selection, and newly projected results are not automatically
selected. A successful Cut-Paste clears the clipboard only after the complete
move succeeds; a failed Paste retains the Cut clipboard so the user can retry.

Single-node and multi-selection context menus both expose Move to Trash and
Delete Permanently. The two commands share the same effective-source resolver:
selected directories cover their selected descendants, and the Project root is
excluded. Multi-selection does not remove or otherwise change either deletion
operation. Both require confirmation; permanent deletion additionally states
that it cannot be undone. The recoverable command is labelled Move to Trash
rather than the ambiguous Delete.

Reset Auto Layout is a Canvas Node Selection command rather than a filesystem
subtree command. Its selective form submits the exact unique `nodePaths` in the
selection as one batch and resets only those nodes, including when one selected
node is a directory; unselected descendants retain their layouts. The separate
global Reset Layout action retains its all-nodes behavior. A successful
selective reset preserves selection and zoom, then centers the updated menu
invocation target after the confirming Projection arrives; if that node no
longer exists, the camera does not move. Global Reset Layout does not move the
camera.

## Stack Order

Every Canvas Node has persisted stack order independent of its hierarchy and
layout mode. Selection alone never changes stack order. Once a direct move
crosses its existing activation threshold, its Manual Layout Draft immediately
raises the moved Canvas Node Selection as one frontmost block while preserving
the selected nodes' prior relative order and the relative order of all
unselected nodes. A resize is active from handle pointer-down and immediately
raises only that node. Pointer release persists geometry and this stack-order
change in one mutation; cancellation or failure restores both.
There is no Bring to Front command or selection-driven stack-order
synchronization; the layer change belongs to the same Manual Layout lifecycle
as move and resize geometry.
DOM order stays deterministic by path while CSS stacking reflects the persisted
order; the Project tree is not a layer panel.

## Workbench Interaction State

`CanvasEditorRuntime` owns the live camera, camera activity state, selection,
pointer interaction, surface measurement, and coordinate conversion. These are
Workbench session state and are not persisted in Canvas JSON.

Wheel input pans by default and Ctrl/Cmd-wheel zooms around the pointer; native
gesture input uses the same camera model. Canvas handles input on its surface
and Canvas floating bars, except controls marked for local scrolling. Textual
or scrollable bodies use focus-gated local wheel handling: they keep wheel
input only while focus is inside them.

Moving a selected node moves the selected node group from shared origin
geometry. Single-node resizing clamps to a minimum size and applies the
media-aware aspect-ratio rule.

During move and resize, a Manual Layout Draft is the visual geometry and stack
order. Node shells, connected edges, culling retention, overlays, and CSS
stacking read that same draft.
On pointer release, Workbench submits the draft immediately and keeps presenting
it until the Canvas Projection confirms the same rectangles and relative stack
order, or a target node disappears. A submitted draft is presentation state,
not Canvas Document state.
A successful mutation outcome closes the Runtime command but does not itself
confirm presentation. Confirmation requires exact rectangle equality and stack
order in the already revision-ordered Canvas Projection; `projectRevision`
orders authority but is not a substitute for that presentation check. A
finished interaction is skipped only when neither geometry nor stack order
would change.

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

- `CanvasEditorRuntime` owns camera, coordinates, input, selection, and pointer interaction
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
