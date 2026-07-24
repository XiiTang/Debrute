# Canvas Feedback

Canvas Feedback is Project-scoped current review state for Project files. It is
not Canvas layout, a workflow history, an approval gate, or Generated Asset
metadata. This page records the current structured model, Workbench interaction,
and derived artifact boundaries.

## Source Of Truth

One Project file is the durable source of truth:

```text
.debrute/reviews/canvas-feedback.json
```

The document is keyed by normalized project-relative path and stores only
current entries. Missing storage means empty feedback. An entry is omitted when
it has neither Feedback Marks nor Feedback Items. Feedback stays outside Canvas
Documents so the same Project file keeps one review state across Canvas views
and can be read by external Agents through ordinary filesystem or generic
Project-file access.

Runtime validates the complete document on read, serializes overlapping
writes per Project file, and commits against the content hash it read. Invalid
JSON, unexpected fields, invalid paths, invalid item combinations, or concurrent
external edits fail instead of being normalized through an old schema or
silently overwritten. Accepted changes are broadcast as shared Project-state
events.

## Marks, Items, And Moments

A Feedback Mark is one of the fixed selected-only values: like, dislike, check,
cross, pending, important, or needs revision. Marks apply to the whole file,
are independent toggles, and normalize into fixed order.

A Feedback Item contains a non-empty comment and is one of:

- a file-scoped comment;
- an image file-scoped numbered pin or rectangle;
- a video moment-scoped comment;
- a video moment-scoped numbered pin or rectangle.

File-scoped spatial items are valid only for images. Moment-scoped items are
valid only for videos. Item IDs are unique within an entry. Spatial labels are
positive, entry-local, stable for the item's lifetime, and never reused by the
entry's next-label counter.

A Feedback Moment has a stable `M#` label and one exact normalized non-negative
video timestamp. Items created at the same exact timestamp reuse that moment;
one label cannot refer to multiple times and one time cannot use multiple
labels. Moments are represented by their items, so deleting the final item for
a moment removes that moment without a separate empty container.

Spatial geometry is normalized to media content. Pins use a point; regions use
a positive rectangle wholly inside the unit square. Image geometry excludes
Canvas chrome. Video geometry is relative to the actual aspect-fitted frame and
excludes player controls, the title bar, Canvas chrome, and letterboxing.

## Workbench Editing And Display

Hovering a node opens one shared floating Feedback Bar. Every media type gets
the fixed Feedback Marks and a persistent file-comment creator. Images also get
pin and rectangle tools. Videos get moment-comment, moment-pin, and
moment-rectangle tools only while a mounted player can supply a real timestamp.

The bar's width is derived from its visible fixed-size actions and creator, not
from media-specific width buckets. It has one primary row and adds one
horizontally scrolling saved-item row only when durable items exist. Enter or
blur saves non-empty creator text; Escape clears a file draft or cancels a
pending spatial/moment item. Pending geometry and comment text remain Workbench
state until one accepted mutation creates the item.

Each saved item renders as one display pill. Spatial pills show their numeric
label; moment pills use a stable palette derived from their `M#` label and seek
the player to their exact time when activated. The close affordance deletes
only that item.

Every node with any accepted feedback renders one pointer-transparent,
theme-aware Feedback Frame. The frame is a single feedback-presence border; it
does not encode feedback kinds with segmented colors and does not show icons,
counts, comments, labels, timestamps, or controls. Ordered kind metadata is kept
only for deterministic tests and diagnostics. Image and video spatial items
remain high-contrast numbered overlays over their media content.

## Video Moment Interaction

Starting a video-moment tool reads and normalizes the real player time, pauses
and seeks the player to that locked frame, and creates transient pending state.
Saving requires a non-empty comment. Saving or cancelling leaves the player
paused at the locked frame. Moment pills seek and pause at their stored time.
Only spatial items for the current locked or displayed exact moment are drawn
over the video.

## Rendered Feedback Artifacts

Rendered feedback images are derived review outputs under:

```text
.debrute/reviews/rendered-feedback/<image-path>.annotated.png
.debrute/reviews/rendered-feedback/<video-path>.moment-<M#>.annotated.png
```

Image artifacts exist only when an entry has file-scoped spatial items. Every
video moment with an item gets a frame artifact, including comment-only moments,
because the frame supplies timestamp context. Artifacts draw only numbered
yellow pins and rectangle outlines; comments and moment labels remain in the
structured document. Image sources and extracted video frames are reduced to
the shared feedback-artifact maximum dimension before overlay and PNG encoding;
artifact rendering therefore never requires an unbounded full-resolution
review raster.

Workbench renders live overlays from accepted feedback plus transient drafts;
it never reads rendered artifacts back into the UI. External Agents may read
the structured document and derived images but must not edit, materialize, or
refresh the artifact tree.

Feedback writes publish the accepted document before artifact work completes.
The bounded scheduler reconciles expected artifact paths, supersedes older work
for the same output, removes stale queued work, and atomically publishes only
the latest complete PNG. Native raster work that has already begun is not
cancelled; its temporary output is discarded when its identity is stale at the
publication check. Source-image changes, source-video changes, external
feedback-file changes, Project open, and geometry-affecting mutations requeue
the relevant materialization. Mark changes and comment-text-only updates do not
rerender pixels. Removing the final relevant item removes its artifact. These
stable-path artifacts are rematerialized on Project open rather than treated as
cache hits, so they do not carry a separate cache or renderer version.

Artifact failures do not roll back accepted feedback. They remove stale output
for the failed target and surface a Project diagnostic keyed to the image path
or video path plus moment. A later successful render clears that diagnostic.
The artifact tree and its temporary files are excluded from Project-visible
content and Canvas Map expansion.

## Agent Contract

Canvas Feedback has no dedicated CLI command or capability. The public
`debrute-core` skill documents the structured file and deterministic artifact
paths. An Agent should match rendered numeric labels to structured spatial
items, treat the JSON as exact meaning, and ask for confirmation before broad or
irreversible work when selected marks conflict or the review intent is unusual.

## Executable Authorities

- Feedback model, normalization, mutation, labels, moments, geometry, and
  artifact paths: `packages/canvas-core/src/`.
- Feedback persistence, media-scope validation, artifact scheduling, rendering,
  diagnostics, and video-frame extraction:
  `apps/runtime/src/project/feedback/` and `apps/runtime/src/project/previews/`.
- Feedback controller, floating bar, frame, media overlays, and video moment
  interaction: `apps/web/src/workbench/canvas/` and
  `apps/web/src/workbench/shell/floatingBars.ts`.
- Visibility policy: `packages/project-core/src/projectPaths.ts`.
- Agent-facing consumption contract: `skills/debrute-core/SKILL.md`.
- Browser-free coverage: `packages/canvas-core/src/canvasFeedback.test.ts`,
  colocated Workbench tests, and `apps/runtime/src/project/tests.rs`.
