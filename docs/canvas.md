# Canvas Architecture

Canvas is a visual file manager for a Debrute Project. The Project filesystem
defines membership and hierarchy. Runtime owns filesystem truth and persisted
Canvas state; Workbench owns scene geometry and interaction.

The complete contracts are
[Project Tree membership](../packages/canvas-core/docs/adr/0008-project-tree-defines-canvas-membership.md)
and
[single root-scoped Canvas state](../packages/canvas-core/docs/adr/0009-canvas-workspace-contains-one-canvas-state.md),
with presentation geometry refined by
[camera-independent content and chrome](../packages/canvas-core/docs/adr/0010-canvas-presentation-separates-content-from-screen-space-chrome.md)
and interaction refined by
[distinct Selection, Content Activation, and manipulation](../packages/canvas-core/docs/adr/0011-canvas-node-selection-content-activation-and-manipulation-are-distinct.md),
with state-only event transport defined by
[authoritative Canvas State deltas](../packages/canvas-core/docs/adr/0014-canvas-state-events-carry-authoritative-deltas.md).

## Runtime Authority

Runtime owns one on-demand Project Tree shared by Explorer and Canvas. It
publishes the real root entry at project-relative path `""`, direct children of
loaded directories, deterministic sibling order, visibility flags, file
availability, media facts, and intrinsic image or video dimensions.

Every regular Project file and directory belongs to the Canvas.
`expandedDirectories` selects the visible resource stream. The root is always
structurally expanded and is never stored in `expandedDirectories`; default
Canvas state therefore stores `[]` while showing the root and its direct
children. A child directory begins collapsed. Collapsing one hides descendants
without clearing their retained state. Videos with persisted Feedback Moments
also remain in a separate lightweight preview-maintenance resource view so their
exact derived artifacts can settle. That view does not change Canvas membership,
disclosure, geometry, or node visibility.

Runtime does not compute node rectangles, edges, overlaps, or z values. Every
durable Canvas change enters one `patchCanvasState` command and atomically
updates the root-scoped Canvas Workspace Document. Runtime validates Project
paths and normalizes sparse state. A patch that leaves Folder Disclosure
unchanged publishes one `canvas.state.changed` event carrying only authoritative
complete resulting node states for changed paths plus `occlusionOrder` when that
order changed. Workbench structurally applies that delta to its canonical Canvas
state while retaining Folder Disclosure, Project Tree, and Canvas Resource View
identities. A Folder Disclosure change
continues through the Project Tree loader and publishes one complete Project
snapshot. A no-op publishes neither.

## Workbench Authority

Workbench waits for its fonts before rendering and measuring the scene. It
derives:

- root and folder labels;
- deterministic depth-first Automatic Layout with one horizontal row for the
  direct-child files of each directory;
- Manual Layout overlay;
- parent-child Hierarchy Edges;
- overlap-only `occlusionOrder` reconciliation and z values;
- Canvas Selection, camera, drag drafts, and pointer interaction.

Directory-node identity reflects Folder Disclosure with the same folder-glyph
semantics as Explorer: a collapsed directory uses the closed folder glyph and
a disclosed directory uses the open folder glyph. The structurally disclosed
Project root therefore always uses the open glyph. A disclosed empty directory
also remains open, distinguishing "opened and empty" from "not opened" without
depending on visible descendants.

Generic root, folder, unknown, and image-without-dimensions nodes are 48 presentation pixels
high. Automatic Layout derives their width from one rendering-matched DOM
measurement of the stable icon-and-label identity row, rounds upward, and
clamps continuously between one Canvas-owned minimum and maximum. Those bounds
are initially 120 and 360 pixels and are not size tiers. They are expressed in camera-independent presentation
pixels and converted once through the scene scale of 10. Camera zoom and
transient error copy never change node geometry or label overflow; only an
identity row wider than the automatic maximum is ellipsized. Manual Layout does
not use these bounds. Text nodes use `4200 × 2800` scene units, audio uses
`3200 × 680`, available image and video nodes use intrinsic dimensions, and an
unavailable video uses a `3200 × 1800` fallback so its title bar and Content
Region remain usable.

A Manual Layout overrides only its own node. Its complete persisted rectangle,
including width, is never rewritten by the automatic bounds. Automatic nodes do
not route around manual rectangles. Reset removes only the selected
`manualLayout` values and thereby opts those nodes back into current Automatic
Layout geometry. No Canvas-state migration or width-source field is required.

The fixed lower-left Hierarchy Edge Visibility control is independent of
Project and Canvas availability. Its Runtime-owned global value defaults to
visible and applies across Projects, Workbench windows, and Debrute restarts.
Hidden Hierarchy Edges are not derived or presented; Canvas Nodes, Project Tree,
layout, selection, and interaction continue unchanged. This value governs only
Hierarchy Edges, not other edge semantics.

Within each directory, direct-child directory subtrees remain vertical blocks
in Project order, followed by one horizontal row containing all direct-child
files in Project order. Files are separated by 80 scene units and vertically
center-aligned; the file row and directory blocks are also separated by 80 scene
units. File type does not split the row, and Canvas state stores no custom
Automatic Layout grouping. Manual movement and resize are the only custom
layout mechanism.

`occlusionOrder` contains only visible nodes that currently overlap another
visible node. Selecting nodes raises the complete resulting selection above
overlapping unselected nodes while preserving the selected nodes' internal
order. Newly disclosed overlapping nodes start above existing nodes. Selection
is transient. Workbench focus changes do not clear it or control Content
Activation.

A Selection Raise is a stable partition of the latest Runtime-confirmed
`occlusionOrder`; it does not rebuild the Project Tree, Canvas Resource View, or
Automatic Layout. It is recomputed only when Selection changes, when the
Runtime-confirmed base Occlusion Order changes, or when Canvas membership is
replaced. Unchanged-selection drag frames update only draft geometry and keep
the existing raised z values. A completed move or resize already derives the final
overlap-only order from its final scene once, then applies that same stable
selection partition. The persistence chain builds the current scene once,
overlays the submitted rectangles directly, and performs no second Automatic
Layout scene or overlap reconciliation.

Finishing a move or resize submits one prospective layout mutation through the
latest accepted Canvas state. Workbench removes unchanged geometry and an
unchanged occlusion order from that mutation, then skips persistence only when
the complete patch is empty. Ending a drag at its current rectangle can still
persist a selection raise when the final overlap order changed; the interaction
kind itself is not persisted or forwarded through the layout command chain.

## Interaction

Canvas Node Selection and Canvas Content Activation are separate. Only text,
video, and audio have a Content Region; their title-bar background is the only
Node Manipulation Region. A successful unmodified click in inactive content
atomically sole-selects and activates it, then applies the one content action.
Clicking elsewhere ends Content Activation after the click succeeds, without
making browser focus a state authority. Generic and image nodes retain their
whole non-action surface as the move handle.

The stable sole-selected text node owns the one Inline Text Presentation. It
uses the live CodeMirror layout while remaining read-only and inert until its
Content Region is activated. Empty, non-text, and many-node
selections own no Inline Text Presentation. Starting resize continues to end
Content Activation, but the resized text remains the sole selection, so the
same CodeMirror presentation stays mounted and reflows throughout the Manual
Layout Draft. Video and audio retain their independent player lifecycles;
selection does not mount or activate their players.

Canvas directory click selects and toggles disclosure on pointer up when the
pointer stays within the drag threshold. Crossing the threshold performs a
Manual Layout drag. Text, video, and audio move only from their title bars.
Explorer single-click changes Explorer Selection; double-clicking a file or
invoking Reveal in Canvas discloses and loads its ancestors, centers the Canvas,
focuses it, selects the target, and applies the ordinary raise rule.

Explorer filesystem drag and Canvas layout drag are independent. Canvas never
changes Project hierarchy, and Explorer never changes Canvas membership.

## Path And Failure Semantics

Project-relative path is Canvas Node identity. Runtime-owned Rename and Move
prefix-rewrite retained Canvas state, accepted Feedback paths, text Working
Copies, and Feedback Working Copies, including descendants of a moved
directory. Confirmed deletion prunes all four; overwrite prunes the target
before rewriting the source. Shallow reads, watcher bursts, and directory
errors cannot prove deletion. Watcher reconciliation confirms a missing path
through a successful parent enumeration that omits it, or through the expected
missing result when resolving an enumerated entry's identity; other identity
errors do not authorize cleanup.

The filesystem mutation is primary. A following Project refresh failure does
not roll back or retry a successful filesystem command; its Project revision
contains the Error diagnostic `project_refresh_failed`. If related Canvas or
Feedback state cannot be persisted, the corresponding Error diagnostic is
`project_path_state_persistence_failed`. Ordinary refresh does not clear the
latter; the next successful related path mutation does.

Missing Canvas state creates default empty Canvas state. Unreadable or malformed
Canvas JSON, a stored canonical-root mismatch, or a Canvas persistence failure
does not block Project open. The Project Tree, editor, and terminal remain
available while the entire Canvas workspace is unavailable with one exact code
and message. Runtime does not repair, migrate, or fall back to another Canvas
document, and it does not duplicate the failure as a Project Diagnostic.

The unavailable surface offers one explicit **Reset Canvas** action.
It performs no second confirmation and creates no backup. Runtime atomically
replaces the damaged state with the default empty state; if the write fails,
Canvas remains unavailable with the exact persistence failure.

Every Project snapshot has `canonicalRoot`, `projectTree`, `canvasWorkspace`,
`diagnostics`, and `health`. `canvasWorkspace` is exactly one of:

```ts
type CanvasWorkspaceSnapshot =
  | {
      status: 'available';
      workspace: CanvasWorkspaceDocument;
      canvasResources: CanvasResourceView;
    }
  | {
      status: 'unavailable';
      code:
        | 'canvas_workspace_invalid'
        | 'canvas_workspace_unreadable'
        | 'canvas_workspace_root_mismatch'
        | 'canvas_workspace_persistence_failed';
      message: string;
    };
```

Canvas workspace members are required. Persisted and wire Project/Canvas types
belong to `@debrute/app-protocol`; `@debrute/canvas-core` owns only pure Canvas
projection and preview identity.

Canvas state lives at
`~/.debrute/state/roots/<rootKey>/canvas.json`. Project-local `.debrute/`
contains only shareable Feedback source and derived Feedback artifacts and is
visible through Explorer and Canvas.
