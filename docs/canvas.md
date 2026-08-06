# Canvas Architecture

Canvas is a visual file manager for a Debrute Project. The Project filesystem
defines membership and hierarchy. Runtime owns filesystem truth and persisted
Canvas state; Workbench owns scene geometry and interaction.

The complete contracts are
[Project Tree membership](../packages/canvas-core/docs/adr/0008-project-tree-defines-canvas-membership.md)
and
[single root-scoped Canvas state](../packages/canvas-core/docs/adr/0009-canvas-workspace-contains-one-canvas-state.md).

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
without clearing their retained state.

Runtime does not compute node rectangles, edges, overlaps, or z values. Every
durable Canvas change enters one `patchCanvasState` command and atomically
updates the root-scoped Canvas Workspace Document. Runtime validates Project
paths, normalizes sparse state, and publishes one complete Project snapshot.

## Workbench Authority

Workbench waits for its fonts before rendering and measuring the scene. It
derives:

- root and folder labels;
- deterministic depth-first Automatic Layout with one horizontal row for the
  direct-child files of each directory;
- Manual Layout overlay;
- parent-child edges;
- overlap-only `occlusionOrder` reconciliation and z values;
- Canvas Selection, camera, drag drafts, and pointer interaction.

Generic root, folder, unknown, and unavailable nodes are 48 CSS pixels high and
`clamp(120, measured label width + 54, 360)` CSS pixels wide. Text nodes use
`4200 × 2800` scene units, audio uses `3200 × 960`, and image and video nodes
use intrinsic dimensions. Scene coordinates use the existing scale of 10.

A Manual Layout overrides only its own node. Automatic nodes do not route around
manual rectangles. Reset removes only the selected `manualLayout` values.

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
is transient and clears when Canvas interaction loses focus.

## Interaction

Canvas directory click selects and toggles disclosure on pointer up when the
pointer stays within the drag threshold. Crossing the threshold performs a
Manual Layout drag. Explorer single-click changes Explorer Selection;
double-clicking a file or invoking Reveal in Canvas discloses and loads its
ancestors, centers the Canvas, focuses it, selects the target, and applies the
ordinary raise rule.

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
