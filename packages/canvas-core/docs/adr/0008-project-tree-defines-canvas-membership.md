---
status: accepted
---

# Project Tree Defines Canvas Membership

ADR 0010 supersedes this ADR's original generic-node width rules. ADR 0011
supersedes its original transient Selection, focus, pointer-routing, and node
interaction rules. The corresponding original passages remain below only as
decision history; current contracts are stated in the newer ADRs and public
Canvas documentation.

Canvas is a visual file manager for the complete Project Tree. Every regular
Project file and directory belongs to the Canvas. Folder Disclosure decides
which descendants are visible; Canvas state stores only
user-authored presentation values that cannot be derived from the filesystem.

## Shared Project Tree

Runtime owns one flat Project Tree Index keyed by normalized project-relative
path. Explorer and Canvas receive the same ordered entries and never perform
independent filesystem discovery. The real Project root is the directory entry
at path `""`. Canvas renders it as a node named from the canonical root's
basename; Explorer omits only this root row.

Opening a Project loads the root's direct children. Other directories are
`unloaded`, `loaded`, or `error` and enumerate their direct children on demand.
A loaded directory remains indexed and watched until the Project session ends.
Explorer expansion, Canvas disclosure, and Reveal in Canvas all load through
this index.

Entries are directories before files, followed by case-insensitive natural
basename order with deterministic original-name and full-path tie-breakers.
Dotfiles, `.gitignore`, and paths named by `.gitignore` rules remain ordinary
visible entries; Runtime does not interpret ignore rules. Version-control
internals, fixed operating-system debris, symbolic links, and other non-regular
entries are excluded. Large directories are not excluded and do not incur
descendant enumeration until loaded.

A successful parent enumeration can confirm that a child is absent. Shallow
snapshots, watcher bursts, and directory read failures cannot. Runtime prunes
sparse Canvas and Feedback state only for confirmed absence. A Runtime-owned
Rename or Move rewrites every matching Canvas path; moving a directory rewrites
the prefix of all retained descendant state. Manual rectangles keep their
absolute coordinates while hierarchy edges change.

Each refresh enumerates into a Project Tree copy and publishes only after the
complete refresh succeeds. A direct child at the same path retains loaded
descendants only when both its filesystem identity and kind are unchanged. An
identity or file/directory kind change removes that path and every indexed
descendant, then inserts the current entry; a replacement directory begins
`unloaded`. Remaining refresh work beneath the replaced path is obsolete and
is skipped. External renames are observed as deletion plus addition; Runtime
does not infer or migrate them by inode.

## Folder Disclosure

Canvas persists an ordered-set value `expandedDirectories`. Default Canvas
state contains `[]`. The root is structurally expanded, is never stored in this
array, and always discloses its direct children; real child directories begin
collapsed. Collapsing any child directory hides descendants without clearing their own
disclosure, Manual Layout, Text Viewport, Playback Position, or other sparse
state. Explorer disclosure is independent Workbench view state.

Visible Canvas resources are the root plus every indexed entry whose complete
ancestor chain is disclosed. Runtime publishes one `canvasResources`
view containing paths, kinds, availability, media facts, intrinsic image or
video dimensions. It publishes no rectangles, overlap results, hierarchy
edges, z values, or Project Diagnostics.

## Workbench Scene Projection

Workbench derives the complete Canvas scene after required Workbench fonts are
ready. It owns label measurement, Automatic Layout, Manual Layout overlay,
hierarchy edges, overlap detection, occlusion order reconciliation, and z
values.

Scene coordinates use a scale of 10 relative to CSS pixels:

The generic-node width and label-measurement rules in the first two bullets,
plus the unavailable-video part of the media-sizing rule, are superseded by ADR
0010. The audio-size bullet is superseded by the current Canvas media
presentation contract in `docs/canvas-media.md`; the original sizing text
remains here as decision history.

- root, directory, unknown, and unavailable nodes are 48 CSS pixels high and
  `clamp(120, measured label width + 54, 360)` CSS pixels wide;
- labels use `700 13px Noto Sans SC` for measurement;
- text nodes are `4200 × 2800` scene units;
- audio nodes are `3200 × 960` scene units;
- image nodes and available video nodes use intrinsic source dimensions;
  unavailable video uses the fallback defined by ADR 0010.

Automatic Layout walks Project order depth-first. Each depth owns one column,
with 100 scene units between columns. Within one directory, visible direct-child
directories and their subtrees remain separate vertical blocks in Project
order, followed by one horizontal row containing every visible direct-child
file in Project order. Files in that row have 80 scene units between them and
are vertically center-aligned; the row and directory blocks have 80 scene units
between them. The parent is centered over the complete child span. File type
does not create additional rows, and Canvas state stores no custom Automatic
Layout grouping. A Manual Layout overrides only its node's automatic rectangle;
it is not an obstacle and does not cause other nodes to reflow around it.
Resetting layout removes only the selected `manualLayout` fields.

Workbench derives one edge from each visible non-root node to its visible
parent. Moving a file or directory changes only its Manual Layout; it never
changes the filesystem hierarchy.

## Occlusion And Selection

`occlusionOrder` is one bottom-to-top ordered array containing only visible
nodes that overlap at least one other visible node. Separating nodes or hiding
them removes obsolete participation. A newly visible overlapping node is above
already visible nodes.

Whenever Canvas Selection changes, the complete resulting selected set is
raised above overlapping unselected nodes. Nodes selected together keep their
existing internal order. Additive selection therefore does not reorder nodes
already selected, while a newly added node rises above overlapping unselected
nodes. Selection itself is transient, clears when Canvas interaction loses
focus, and is never persisted. Workbench presents this Selection Raise
immediately for every selection source; drag and resize do not own another
raise rule. If the Occlusion Order patch fails, Workbench reports the failure
without retrying or treating the local presentation as persisted. The current
Selection remains raised while it exists; once it changes or clears, Workbench
derives presentation from that next Selection and the latest Runtime-confirmed
Occlusion Order.

Workbench serializes every operation that writes Occlusion Order per Project
binding generation. When an operation reaches the head of that lane,
it reads the latest Runtime-confirmed Canvas State, derives the complete next
Occlusion Order, and submits one patch. This includes Selection Raise, Manual
Layout commits, Manual Layout reset, ordering newly visible nodes after Folder
Disclosure, and visibility-driven overlap cleanup. Canvas patches that do not
write Occlusion Order do not use this lane. The lane executes current-generation
intents in order without coalescing; an intent from a retired Project generation
is rejected instead of being applied to another Project.

The renderer may assign the ordered selected group temporary z values above
every unselected node. Those values express no non-overlap relationship, are
not Canvas State, and disappear with the Selection. Pointer movement therefore
updates draft geometry without recomputing whole-scene overlap on every frame;
only the final persisted Occlusion Order is restricted to nodes that actually
overlap in the final geometry.

Move and resize use a Workbench-local Manual Layout Draft. Pointer movement
updates geometry while the current Selection Raise remains presented. Pointer
up derives Occlusion Order from the final geometry and current Selection, then
commits that order and the final rectangles in one patch; it does not issue a
second drag-specific raise. Cancellation discards the draft. Dragging a
selected folder moves only the selected Canvas nodes, not its filesystem
descendants.

## Interaction

An unmodified primary click on a Canvas directory selects it and toggles its
disclosure on pointer up when movement remains within the existing four-screen-
pixel drag threshold. Crossing the threshold performs a Manual Layout drag.
Modifier clicks change Selection without toggling disclosure.

Explorer single-click changes Explorer Selection. Double-clicking a file or
using Reveal in Canvas expands and loads every ancestor on the Canvas, centers
the camera on the target, transfers interaction focus to Canvas, selects the
file, and applies the ordinary selection-raise rule. Explorer and Canvas drag
operations remain local to their own surfaces.

## Mutation Contract

Workbench sends every durable Canvas state change through one
`patchCanvasState` command. A patch may replace Folder
Disclosure or `occlusionOrder`, and may set or delete complete node-local
Manual Layout, Playback Position, and Text Viewport values. Runtime validates
current Project paths against a staged Project Tree, normalizes the sparse
result, writes the Canvas Workspace Document atomically, and publishes one
complete Project snapshot. An empty patch, an empty `nodeStateUpdates`-only
patch, or a node update containing only its path is invalid. Explicit empty
Folder Disclosure and Occlusion Order arrays are valid clears. Repeating the
current value is a valid no-op and publishes no revision. A failed validation
discards the staged Project Tree and leaves Canvas and Feedback unchanged.
There are no separate Runtime commands for layout, reset, playback, text
viewport, disclosure, reveal, selection raise, or scene projection.

Malformed, unreadable, or root-mismatched Canvas JSON remains unchanged but
does not block Project open. Project Tree, editor, and terminal remain
available while Canvas is unavailable. The user may explicitly reset the whole
Canvas state to the empty default without confirmation or backup; failure to
persist that reset preserves the exact prior Canvas availability and state.
Feedback loading keeps its separate Project-owned contract.
