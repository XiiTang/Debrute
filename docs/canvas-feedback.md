# Canvas Feedback

Canvas Feedback is Project-scoped current review state for Project Path targets. It is
not Canvas layout, a workflow history, an approval gate, or Model Artifact
metadata. This page records the current structured model, Workbench interaction,
and derived artifact boundaries.

## Source Of Truth

One Project file is the durable source of truth:

```text
.debrute/feedback/feedback.json
```

The document is keyed by normalized project-relative path and stores only
current entries. Missing storage means empty feedback. An entry is omitted when
it has neither Feedback Marks nor Feedback Items. Feedback stays outside the
Runtime-global Canvas Workspace so the same Project Path target keeps one
review state independently of Canvas presentation and can be read by external Agents through
ordinary filesystem access. `.debrute/` is ordinary visible Project content;
Canvas and Explorer can disclose this document like any other visible file.

Runtime validates the complete document on read, serializes overlapping writes
per Project file, and commits against the content hash it read. Invalid JSON,
unexpected fields, invalid paths, invalid item combinations, and concurrent
external edits fail validation or concurrency checks. Feedback Names are exact
Unicode strings: Runtime does not trim, case-fold, or normalize them, and the
Project reader retains names that strict local Settings creation would reject.
Accepted changes are broadcast as shared Project-state events.
The closed document limits remain 2 MiB, 1,000 entries, 500 Items per entry,
5,000 Items total, and 200 Moments per entry. Multi-selection introduces no
separate selection-size limit; the resulting document must satisfy those same
limits atomically.

If this document is unreadable or invalid, Runtime leaves its bytes unchanged
and the Project load or refresh fails with that ordinary error.

Path is the complete identity of Feedback state. The Project root uses the
empty path. Files, directories, and the Project root may each own independent
entries; selecting a directory never expands a mutation to its descendants and
never suppresses an independently selected descendant. `.debrute/**` cannot be
a Feedback target, preventing feedback from recursively reviewing its own
source or derived files. Delete removes accepted Feedback for that path subtree.
Rename and Move rewrite the source path or directory prefix; overwrite prunes
the destination before rewriting the source. The same rules apply to Feedback
Working Copies. A watcher signal alone removes nothing; Runtime prunes only
after a successful parent-directory enumeration confirms that the path is
missing.

## Marks, Items, And Moments

A Feedback Mark is identified by its exact, directly intelligible Feedback
Name. Names that differ by case or Unicode sequence are different identities.
Marks apply to the whole Node, are independent toggles, and retain document
order. They carry no Mark ID, icon, color, or display-label registry. A Mark
command snapshots one or more exact Project Paths and sets or clears one Name
for all of them in one Runtime transaction. Runtime first validates that every
target is a current real file, directory, or Project root, then writes the
document once and emits one change event. One invalid or missing target rejects
the whole command. A semantic no-op writes nothing, changes no timestamp or
Project revision, and emits no Feedback event. Only entries whose Mark value
changes receive a new timestamp; clearing the final Mark from an Item-free entry
removes that entry.

The machine-local Global Feedback Mark Catalog maps immutable Names to mutable
Phosphor Fill icon identifiers. Its separate ordered Action Bar list contains
at most eight Catalog Names. Catalog size is not otherwise capped. Settings may
create or delete mappings, change icons, and change Action Bar membership and
order, but none of those actions reads or writes the Project Feedback Document.
An unmapped Project Name remains accepted and uses the system-reserved
question-mark icon. That fallback remains resolvable but is not offered by the
Settings icon picker or accepted by Catalog writes.
The Settings UI edits membership directly: drag Catalog Feedback into the
Floating Feedback Bar preview, drag within the preview to reorder, and remove
from the preview to exclude it. It exposes no duplicate membership checkbox or
picker. The same surface supports keyboard configuration: Enter or Space adds
an available focused Catalog entry, and Left or Right reorders a focused
preview entry. Catalog identities announce when they are already present or the
eight-item bar is full.

The Feedback Bar presents only the locally configured Action Bar Names. It is a
set-or-clear action palette rather than a complete status view. It has no
optimistic Marks copy, Draft, or Working Copy. The
current accepted set remains displayed during a request; Runtime acceptance is
installed by the ordinary ordered Project event, and failure changes nothing.
At most one Marks mutation for the Project is in flight. All single- and
multi-selection Mark buttons are disabled during it. Workbench ignores another
selection during that request, never retargets the captured paths, never queues
or retries it, and publishes one Runtime-global Canvas failure notice to
Activity on failure.

A Feedback Item contains a non-empty comment and is one of:

- a node-scoped comment on any Project Path target;
- an image node-scoped numbered pin or rectangle;
- a video moment-scoped comment;
- a video moment-scoped numbered pin or rectangle.

Node-scoped spatial items are valid only for image files. Moment-scoped items are
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

Semantically hovering one node opens the shared full floating Feedback Bar.
The current Bar target lives in one Bar-private external channel; only the Bar
subscribes to it, and target changes do not commit the Workbench or Canvas
React trees. Camera movement clears the Stage hover but retains the transient
node Bar target in that channel. Canvas suspends only that Bar's overlay presentation while
transformed nodes pass beneath the pointer; it does not suspend a multi-selection
Bar or a Bar whose Capsule owns focus. At camera idle, one hit-test at the last
pointer position reconciles the final target. The same node restores the cached
current placement immediately, a different node remains hidden until the new
placement is written, and an empty result leaves the old Bar hidden until its
ordinary target-loss clear completes. An active Canvas pointer interaction
retains the existing target-loss lifecycle unless it manipulates Canvas Node
geometry. A pending node move still retains its hover target. Crossing the move
threshold or beginning a resize publishes no target, immediately unmounts the
current single-node or multi-selection Bar, and clears its placement. Pointer release uses the existing
single reconciliation to derive a new target from current presented node
geometry; it performs no manipulation-specific delay, second hit-test, or
reopen path. Every Canvas Node, including directories and the Project root,
gets the locally configured Feedback Mark actions
and a node-comment authoring affordance. Image files also get pin and rectangle
tools. Video files get moment-comment, moment-pin, and moment-rectangle tools
only while a mounted player can supply a real timestamp.

A Canvas selection of two or more nodes instead shows one persistent Marks-only
Bar for the complete selection. It is horizontally centered below the outer
selection bounds and falls back above when needed, using the same reserved-area
placement rules as the single-node Bar. The selection outline is the only count
or grouping cue: the Bar contains no item count, comments, Capsules, image
tools, or video tools. It includes files, directories, and root exactly as
selected, without descendant expansion or filtering. A Mark appears selected
only when every selected Node has it. There is no mixed visual state: clicking
an unselected aggregate sets the Mark on all captured paths; clicking a selected
aggregate clears it from all captured paths. The multi-selection Bar replaces
the single-node Bar immediately and the two shells are never rendered together.

While any Feedback Capsule owns real input focus, that focus locks the Bar open
and locks its target to the Capsule's Canvas Node. Pointer movement cannot hide
the Bar or retarget it to another node. After the user deliberately moves focus
outside the Bar, its ordinary hover visibility and targeting resume while the
focus-triggered save proceeds. If the pointer has already moved over another
Canvas Node, the Bar switches directly to that Node after focus leaves; it
never reuses the previous Node's Capsules for the new target. Moving focus from
a Capsule to a tool inside the same Bar keeps the current Node target. Without a
focused Capsule, leaving either the current Canvas Node or the Bar starts the
same 120-millisecond dismissal grace. Entering a Canvas Node or re-entering the
Bar cancels that pending dismissal; entering another Node retargets the Bar
immediately. If the target Node disappears and forces the Bar to unmount, the
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

The trailing creator and every editable Capsule use one square technical frame,
not a second offset paper layer inside the Feedback Bar. The idle frame is a
muted one-pixel line; focus replaces that same frame with the shared two-pixel
focus color without changing geometry. Video-moment Capsules retain their
moment-colored idle frame and tint. Creator hover strengthens only its frame,
while Capsule hover changes no frame and continues to reveal only the delete
control. The one-line Bar remains 74 pixels high across creator and focused
input states; multiline comment content may still increase its height. Width
continues to follow visible content and may change when the creator becomes an
editable Capsule.

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
visible Nodes render independently, including unsynchronized spatial Working
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

Canvas renders no node-wide Feedback Frame or other persistent
feedback-presence border. Feedback remains visible through its Feedback Bar,
Feedback Panel, saved Capsules, marks, and the high-contrast numbered pin or
rectangle overlays owned by image and video spatial items.

The fifth Workbench floating panel is the Project-scoped Feedback Panel. It
renders every accepted Feedback Mark and Feedback Item, grouped by Project Path
in Project Tree order with unresolved external paths last. It uses local Catalog
icons where available and the question-mark icon otherwise. The panel can
locate a target, clear an accepted Mark, or delete an Item; it does not add Marks
that are absent from the local Action Bar and does not poll or maintain a second
Feedback state.

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
.debrute/feedback/artifacts/<image-path>.annotated.png
.debrute/feedback/artifacts/<video-path>.moment-<M#>.annotated.png
```

Image artifacts exist only when an entry has node-scoped spatial items. Every
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
feedback-document changes, Project open, and geometry-affecting mutations requeue
the relevant materialization. Mark changes and comment-text-only updates do not
rerender pixels. Removing the final relevant item removes its artifact. These
stable-path artifacts are rematerialized on Project open rather than treated as
cache hits, so they do not carry a separate cache or renderer version.

Artifact failures do not roll back accepted feedback. They remove stale output
for the failed target and surface a Project diagnostic keyed to the image path
or video path plus moment. A later successful render clears that diagnostic.
Completed artifacts are visible ordinary Project content. Runtime-owned
temporary files remain excluded by the common managed-temporary policy.

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

- Shared Feedback document and command declarations:
  `packages/app-protocol/src/`.
- Feedback normalization, mutation, labels, moments, geometry, artifact paths,
  persistence, media-scope validation, scheduling, rendering, diagnostics, and
  video-frame extraction:
  `apps/runtime/src/project/feedback/` and `apps/runtime/src/project/previews/`.
- Feedback interaction, floating bar, panel, icon presentation, media overlays,
  and video moment interaction: `apps/web/src/workbench/canvas/`,
  `apps/web/src/workbench/feedback/`, and
  `apps/web/src/workbench/shell/floatingBars.ts`.
- Visibility policy: `apps/runtime/src/project/paths.rs`.
- Agent-facing consumption contract: `skills/debrute-core/SKILL.md`.
- Browser-free coverage: colocated Workbench tests,
  `apps/runtime/src/project/feedback/`, and `apps/runtime/src/project/tests.rs`.
