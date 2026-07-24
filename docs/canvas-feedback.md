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

Runtime validates the complete document on read, serializes overlapping writes
per Project file, and commits against the content hash it read. Invalid JSON,
unexpected fields, invalid paths, invalid item combinations, and concurrent
external edits fail validation or concurrency checks. Accepted changes are
broadcast as shared Project-state events.

## Marks, Items, And Moments

A Feedback Mark is one of the fixed selected-only values: like, dislike, check,
cross, pending, important, or needs revision. Marks apply to the whole file,
are independent toggles, and normalize into fixed order. Workbench renders only
the Marks in Runtime-accepted Feedback state. The Feedback Bar has no optimistic
Marks copy, Draft, or Working Copy. Selecting a Mark submits the exact next set
while the current accepted set remains displayed; Runtime acceptance installs
the returned set, and failure changes nothing. At most one Marks mutation for
the same file is in flight. Workbench ignores another selection during that
request and never turns it into an automatic retry.

A Feedback Item contains a non-empty comment and is one of:

- a file-scoped comment;
- an image file-scoped numbered pin or rectangle;
- a video moment-scoped comment;
- a video moment-scoped numbered pin or rectangle.

File-scoped spatial items are valid only for images. Moment-scoped items are
valid only for videos. Item IDs are unique across the document. Each Item
retains the Capsule's validated creation timestamp, and Runtime orders Items by
creation timestamp plus Item ID rather than mutation arrival. Spatial labels are
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
the fixed Feedback Marks and a file-comment authoring affordance. Images also
get pin and rectangle tools. Videos get moment-comment, moment-pin, and
moment-rectangle tools only while a mounted player can supply a real timestamp.
While any Feedback Capsule owns real input focus, that focus locks the Bar open
and locks its target to the Capsule's Project file. Pointer movement cannot hide
the Bar or retarget it to another node. After the user deliberately moves focus
outside the Bar, its ordinary hover visibility and targeting resume while the
focus-triggered save proceeds. If the pointer has already moved over another
Project file, the Bar switches directly to that file after focus leaves; it
never reuses the previous file's Capsules for the new target. Moving focus from
a Capsule to a tool inside the same Bar keeps the current file target. Without a
focused Capsule, leaving either the current Project file or the Bar starts the
same 120-millisecond dismissal grace. Entering a Project file or re-entering the
Bar cancels that pending dismissal; entering another file retargets the Bar
immediately. If the target file disappears and forces the Bar to unmount, the
Capsule's Working Copy still protects its current value.

The bar's width is derived from its visible fixed-size actions, not from
media-specific width buckets. Its primary row contains only
Feedback Marks and media-specific tools; it has no persistent comment input.
A separate item row scrolls Feedback Capsules within that width and always ends
with one compact `+ Comment` Capsule. Activating that affordance
turns it in place into a new, always-editable Feedback Capsule. When that
Capsule first loses focus with a non-empty value, Runtime creates the
corresponding Feedback Item. Workbench immediately places a new `+ Comment`
Capsule after the non-empty Capsule without waiting for Runtime acceptance. An
empty new Capsule simply returns to the one trailing affordance. Every Capsule
has its own stable identity before its first save, so multiple creations and
failures synchronize independently. Capsules keep their stable user-creation
order regardless of request or response order, and Runtime persists that order
so reopening the Project produces the same sequence. Deleting one Capsule does
not reorder the others. Starting authoring therefore inserts nothing in the
primary row and never copies or moves a comment between rows.

Every comment remains freely editable for its complete lifetime. Input changes
are visible immediately and are the Feedback value shown by Workbench; there is
no Draft state, submit action, or saved/read-only mode. Losing focus writes the
Capsule's exact current value to Runtime but does not change its identity,
position, appearance, or editability. Runtime acceptance updates authoritative
review state without replacing the Capsule. Each changed focus loss makes one
canonical Feedback mutation; Working Copy writes independently protect the
current input value. There is no debounce, background canonical autosave,
offline queue, or retry loop. A value not yet accepted is protected as a
Working Copy under the Capsule's stable identity. An unexpected failure simply
leaves the current value and active surface styling in place; a later ordinary
focus loss writes the latest value again. Keyboard-focus styling and the text
caret always follow real DOM focus. Enter confirms by moving focus out of the
Capsule and follows the same persistence path as any other focus loss. Shift +
Enter inserts a line break. A Capsule begins at one line with its text vertically
centered. Its width follows the longest current line from 24 pixels to the
240-pixel maximum. It grows with its content through four visible lines, and
then scrolls internally instead of continuing to cover the Canvas.

Escape only moves keyboard focus out of the Capsule. It never clears text,
restores an older value, or introduces a separate cancel action. The resulting
focus loss follows the same rules as any other: a non-empty value is saved, an
empty new Capsule returns to `+ Comment`, and an existing Item left empty is
deleted.

Empty text means that no Feedback Item exists, but clearing a focused Capsule
has no immediate side effect. The Capsule remains empty and its exact current
value remains the Workbench value until focus moves away. At that point an empty
new Capsule returns to the trailing `+ Comment` affordance, while an existing
Item requests deletion. Its empty Working Copy and Capsule remain until Runtime
accepts that deletion, while its spatial geometry is absent from Workbench
presentation because the current value no longer forms a Feedback Item. Runtime
acceptance removes the Capsule and clears its Working Copy and local version. A
failure performs none of that cleanup: the empty value remains available for a
later ordinary focus loss to submit again. The empty edit is never replaced with
the previous accepted text merely because the request failed or another
interaction occurred.

Selecting a tool, locking a video time, or placing spatial geometry without
non-empty text creates a Feedback Composition, not a Feedback Item. After a
spatial tool is selected, the trailing `+ Comment` Capsule remains visible and
unchanged while the Canvas awaits an actual placement. When spatial placement
or video-moment lock completes, that trailing Capsule changes in place into the
corresponding always-editable Capsule and receives focus automatically; the user
never activates a second comment control. A pin placement completes on pointer
release so the same pointer gesture cannot take focus back from the newly
created Capsule. Losing focus with its first non-empty value creates the Item
together with the applicable geometry or moment. The tool action that receives
focus proceeds independently; the focus-triggered save never converts the previous
Capsule, retargets its comment, or blocks the new interaction. Only
Runtime-accepted Feedback Items are authoritative review state or accepted
spatial overlays.

Canvas presentation uses the latest Workbench value for each stable Capsule
until Runtime accepts the same value. Pins and rectangles therefore remain at
their current geometry without response-driven removal or recreation, and
clearing an Item to empty hides its geometry immediately. Values for different
visible files render independently, including unsynchronized spatial Working
Copies restored after reopening the Project.

Each accepted item renders as the same always-editable Feedback Capsule.
Spatial Capsules show their numeric label; moment Capsules use a stable palette
derived from their `M#` label. Clicking or focusing any editable part of a
moment Capsule seeks and pauses the player at its exact time before editing; the
text and `M#` badge are not separate navigation targets. The close affordance
deletes only that item. A close-pointer intent takes precedence over the blur it
causes: Workbench suppresses that blur save and performs one deletion. An
accepted Capsule and its geometry remain visible until Runtime accepts the
deletion. A failed close deletion changes no Capsule, Working Copy, geometry, or
local-version state, so a later close is a new explicit attempt. At most one
deletion for the same Item is in flight; Workbench never turns that guard into an
automatic retry. Closing a never-saved Capsule only removes its local value and
transient geometry; it does not create an Item merely to delete it.

Spatial Capsules and their Canvas geometry are linked in both directions.
Focusing a spatial Capsule highlights its pin or rectangle; for video it also
seeks and pauses at the Item's moment. Activating a pin or rectangle opens and
locks the matching Feedback Bar, scrolls its Capsule into view, and focuses its
text. Geometry pointer sequences belong to Feedback and never start Canvas Node
move or resize interaction. This linkage selects context only. Accepted pin and
rectangle geometry is fixed for the Item's lifetime: Workbench provides no
drag, resize, or geometry
edit mode. Repositioning requires deleting the Item and creating a new spatial
comment.

Every node with any accepted feedback renders one pointer-transparent,
theme-aware Feedback Frame. The frame is a single feedback-presence border; it
does not encode feedback kinds with segmented colors and does not show icons,
counts, comments, labels, timestamps, or controls. Ordered kind metadata is kept
only for deterministic tests and diagnostics. Image and video spatial items
remain high-contrast numbered overlays over their media content.

## Video Moment Interaction

Starting a video-moment tool reads and normalizes the real player time, pauses
and seeks the player to that locked frame, and creates a Feedback Composition.
Losing focus with a non-empty comment creates the moment Item. Later editing
does not alter the locked time, but focusing its Capsule always seeks and pauses
the player there so the comment is edited in context. Removing the Feedback
Composition or deleting the Item leaves the player paused at the locked frame.
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

Workbench renders live overlays by combining accepted feedback with the latest
per-Capsule Workbench values under the precedence rule above; it never reads
rendered artifacts back into the UI. External Agents may read the structured
document and derived images but must not edit, materialize, or refresh the
artifact tree.

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

## Workbench Interaction Ownership

Workbench coordinates Canvas Feedback through one deep
`CanvasFeedbackInteraction` module per accepted Project binding generation.
`WorkbenchProjectProjection`, not the Feedback module, owns the active Project
identity, binding generation, and ordered Project revision acceptance. React
mounts Project-scoped presentation beneath a generation-keyed subtree, so a
replacement binding disposes the previous Feedback interaction and creates a
new one from the replacement binding's Working Copies. The module does not
reset itself for another binding or migrate arbitrary interaction state between
generations, and completion from a disposed generation cannot publish into the
new Project surface.

Within one generation, `CanvasFeedbackInteraction` owns stable Capsule
identities and order, current Workbench values and Working Copies, Feedback Bar
focus and target locks, tool composition, video-moment locking, live overlay
presentation, focus-loss mutations, and ordering between accepted Runtime
events and local interaction. This is one interaction lifecycle rather than
state redistributed through `WorkbenchApp`, `CanvasSurface`, and the Bar.

`WorkbenchApp` supplies the generation's accepted binding, Working Copies, and
already-ordered Runtime events without unpacking Feedback state into Bar props.
`CanvasSurface` reports a target fact bundle containing the mounted node,
media-content geometry, camera, player operations, and direct Canvas
interaction facts; it does not own target locking or Feedback persistence. The
interaction module derives its controlled Bar and Canvas presentation from
those facts. The Bar owns no Feedback value. Runtime remains authoritative and
the module has no offline or retry subsystem.

## Executable Authorities

- Shared feedback declarations and browser presentation values:
  `packages/canvas-core/src/`.
- Feedback normalization, mutation, labels, moments, geometry, artifact paths,
  persistence, media-scope validation, scheduling, rendering, diagnostics, and
  video-frame extraction:
  `apps/runtime/src/project/feedback/` and `apps/runtime/src/project/previews/`.
- Feedback interaction, floating bar, frame, media overlays, and video moment
  interaction: `apps/web/src/workbench/canvas/` and
  `apps/web/src/workbench/shell/floatingBars.ts`.
- Visibility policy: `apps/runtime/src/project/paths.rs`.
- Agent-facing consumption contract: `skills/debrute-core/SKILL.md`.
- Browser-free coverage: colocated Workbench tests,
  `apps/runtime/src/project/feedback/`, and `apps/runtime/src/project/tests.rs`.
