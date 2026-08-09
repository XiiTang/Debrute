# Canvas

The Canvas context names the visual organization and review model projected from
Project files.

## Language

**Canvas**:
A visual file manager whose nodes represent Project files and directories. Its
Folder Disclosure and sparse visual state are machine-local presentation
associated with one canonical Project root.
_Avoid_: Board, document layer

**Project Tree**:
The Runtime-owned, on-demand index of user-visible Project files and
directories shared by Explorer and Canvas. Every indexed entry logically
belongs to the Canvas.
_Avoid_: Canvas membership, Explorer snapshot

**Folder Disclosure**:
The persisted set of directories whose children are visible. The Project root
is structurally disclosed and cannot be collapsed. Explorer expansion is
independent view state.
_Avoid_: Membership, filesystem loading, Explorer expansion

**Canvas Node**:
The Canvas representation of one Project file or directory, identified by its
project-relative path.
_Avoid_: Asset record, layer

**Canvas Node Selection**:
The transient set of Canvas Nodes targeted together by the current Canvas
interaction. Empty, one-node, and many-node selections are cardinalities of
this one selection, not separate selection states. It contains only Canvas
Nodes and is not Canvas State.
_Avoid_: Mixed selection, selected assets

**Canvas Content Activation**:
The transient, optional identity of the one text, video, or audio Canvas Node whose
Content Region currently accepts direct content-specific interaction. It is
distinct from Canvas Node Selection but may exist only when that node is the
sole selected node; Selection alone never activates content. It is not Canvas
State. Generic and image nodes have no Content Region.
_Avoid_: Canvas Node Selection, active node, persisted focus

**Canvas Content Region**:
The text body, video player, or audio player area reserved for content-specific
pointer and keyboard behavior. It never initiates Canvas Node movement.
_Avoid_: Canvas Node, Node Manipulation Region, preview node

**Content Interaction Island**:
A popup or portal owned by the currently active Content Region. A completed
click inside it preserves Canvas Content Activation even when its DOM is
outside the Canvas Node or CanvasSurface.
_Avoid_: Workbench overlay, Node Manipulation Region, global focus scope

**Content Activation Click**:
One successful unmodified click in an inactive Content Region that atomically
sole-selects its node, establishes Canvas Content Activation, and applies the
click's content action exactly once. Text places the editor caret at the
original click position; video toggles playback; and an audio button applies
its targeted control action. An audio time- or volume-range press is an
immediate direct-manipulation activation rather than a Content Activation
Click. It is one gesture, not an activation click followed by a simulated
second click.
_Avoid_: Double click, click replay, select then activate, preview click

**Node Manipulation Region**:
The non-action background of a text, video, or audio Canvas Node title bar. A
completed click there selects the node and ends Canvas Content Activation; a
drag gesture beginning there may move the node. Title-bar actions and resize
handles remain separate action and resize targets; the visual node frame is not
a manipulation target.
_Avoid_: Interaction area, Canvas Content Region, whole-node drag target, visual frame

**Selection Marquee**:
A transient pointer interaction and displayed rectangle that updates the Canvas
Node Selection from every Canvas Node whose current displayed rectangle
intersects it. It is not a selection state or persistent selection mode.
_Avoid_: Selection box, lasso

**Canvas State**:
The Canvas's sparse Folder Disclosure, non-default node-local state, and
Occlusion Order. Project membership, hierarchy, Automatic Layout, Selection,
and camera are derived or transient.
_Avoid_: Project Tree, live editor state

**Canvas Resource View**:
The Runtime view produced from Canvas State and the shared Project Tree. It
adds visible paths, current availability, node kinds, and media facts without
calculating geometry.
_Avoid_: Canvas State, scene projection

**Canvas Scene Projection**:
The Workbench-owned nodes and edges derived from one Canvas Resource View and
Canvas State after fonts are ready. It contains Automatic Layout, Manual Layout
overlay, overlap-only stacking, and hierarchy edges without persisting them.
_Avoid_: Runtime projection, Canvas State

**Hierarchy Edge**:
A derived Canvas Scene Projection edge connecting each visible non-root Canvas
Node to its visible parent in the Project Tree.
_Avoid_: Stored edge, link

**Hierarchy Edge Visibility**:
The user's global choice to show or hide every Hierarchy Edge without changing
the Project Tree, Canvas Nodes, or layout. Hiding omits Hierarchy Edge
derivation and presentation while other Canvas behavior remains active. It
defaults to visible and does not govern other present or future edge semantics.
The choice takes effect immediately, is shared by all Workbench windows,
persists across Projects and Debrute restarts, and returns to the latest
Runtime-confirmed value when persistence fails.
_Avoid_: Edge deletion, Canvas State

**Canvas Workspace Document**:
The one Runtime-global Canvas JSON document for a Project Canonical Root. It
stores that root and the complete Canvas State. It is not Project content.
_Avoid_: Project file

**Automatic Layout**:
Deterministic hierarchy placement recalculated from currently visible Project
Tree nodes. Manual rectangles override only their own nodes.
_Avoid_: Saved layout, fallback layout

**Automatic Generic Node Width**:
The content-responsive displayed width that Automatic Layout assigns to a
Canvas Node rendered with the generic node presentation, including Project
roots, directories, unknown resources, and images without intrinsic
dimensions. It grows continuously with the intrinsic width of the stable node
identity row between one Canvas-owned minimum and maximum; those bounds are not
size tiers and have one owner in camera-independent presentation pixels. The
initial bounds are 120 and 360 presentation pixels. The measured width is
rounded upward before clamping; only the maximum may cause an
Automatic Layout label to be ellipsized. Transient error or availability copy
does not change this geometry. Camera changes never alter this width or its
label overflow, and the bounds never constrain or rewrite Manual Layout.
Resource presentations with an explicit media sizing policy retain that policy.
_Avoid_: Folder node length, folder-only width, size preset, resource-name length limit, Manual Layout limit

**Manual Layout**:
A complete persisted node rectangle created by direct move or resize and
preserved while the Project Path exists. Automatic width bounds never rewrite
its position or size; Reset Layout deletes it and returns the node to current
Automatic Layout.
_Avoid_: Locked node, drag preview

**Manual Layout Draft**:
A not-yet-confirmed node geometry produced by direct move or resize. It may be
presented over a Canvas Scene Projection, but it is not Canvas State.
_Avoid_: Manual Layout, pending layout, optimistic Canvas State

**Occlusion Order**:
The persisted bottom-to-top order containing only currently visible Canvas
Nodes that overlap at least one other node. Non-overlapping relative order has
no product meaning. Selecting nodes raises the complete resulting Selection
while preserving its internal order.
_Avoid_: Layer tree, z-order panel

**Selection Raise**:
The rule that immediately presents the complete Canvas Node Selection above
overlapping unselected nodes while preserving the selected nodes' existing
internal order. Workbench presents it locally, while Canvas State records only
the resulting overlap-only Occlusion Order.
_Avoid_: Drag raise, global stack order, bring-to-front command

**Canvas Text Appearance**:
The user's complete global typography value for Project text shown on Canvas,
comprising font selection, font size, line height, font weight request,
letter spacing, and ligatures. Changing Projects does not
override it. Runtime owns it as the complete `canvas.textAppearance` member of
global settings rather than a Project, Canvas State, Workbench Theme, or
field-level patch; it excludes named preset identity, syntax colors, editor
ornamentation, and editing behavior. Font size is a finite `6–100` CSS-pixel
value with `0.5px` precision and a `12px` default; invalid values are rejected
rather than clamped. Line height is a `1.0–2.0` ratio with at most two decimal
places, a `0.05` control step, and a `1.4` default. Letter spacing is a finite
`-5–20` CSS-pixel value with `0.1px` precision and a `0px` default, subject to
the same rejection rule.
Ligatures are one boolean value, enabled by default, that controls only the
font's `liga` and `calt` OpenType features; arbitrary feature tags and CSS
feature strings are not part of Canvas Text Appearance. Every valid settings
interaction immediately adopts and persists the complete value; there is no
apply, save, or restore-default action. A failed persistence attempt restores
the latest Runtime-confirmed value rather than leaving a window-specific
appearance active. Font weight is an independent integer request from `100` to
`900`, defaulting to `400`; changing Canvas Font preserves it, and controls step
by `50`, by `100` with Shift, or by `10` with Alt/Option. Concurrent Workbench
windows do not merge individual fields: the last complete value accepted and
published by Runtime is authoritative, while each window serializes its own
writes and coalesces values that have not yet been sent. Active text editors
adopt a new value immediately. A resolved appearance change creates a new
derived-preview identity, so prior previews become invalid and the ordinary
Canvas Maintenance Job regenerates them as needed; it does not introduce a
separate appearance-specific rebuild path.
_Avoid_: Named text style, Canvas Text Render Profile, editor theme

**Canvas Font**:
A selectable Debrute-managed font family available to Canvas Text Appearance
across all Projects. A stable catalog ID records the user's selection while a
separate content-addressed render identity denotes its exact faces and
supported weights; display names, operating-system family names, paths, and
content digests are not user settings. When an exact requested weight is
unavailable, rendering selects the closest real managed face without changing
the saved request or synthesizing a weight. The initial catalog comprises Noto
Sans Mono CJK SC, Lilex, JetBrains Mono, IBM Plex Mono, and Noto Sans SC. Lilex,
JetBrains Mono, and IBM Plex Mono use the managed Noto Sans Mono CJK SC faces as
their deterministic fallback.
_Avoid_: System font, CSS font stack

**Text Viewport**:
The persisted scroll position confirmed in Canvas State and shared by a
Canvas text node's editor and derived preview. An unconfirmed local scroll
position is transient interaction state rather than a Text Viewport.
_Avoid_: Editor focus, capture viewport

**Playback Position**:
The persisted non-negative integer millisecond video timestamp shared by an
active player and the derived still preview used when that player is inactive.
_Avoid_: Player time, playback session

**Canvas Maintenance Job**:
An automatic, rebuildable attempt to derive a preview, fill a cache, or update
an index from authoritative Project and Canvas state, with no public identity,
history, or Operation lifecycle. Hiding a Canvas Node ends queued or preparatory
work without deleting reusable derived output; one source executor that has
already started may finish. Showing the node again starts a new maintenance
attempt, and any non-executing attempt may be cancelled or superseded.
_Avoid_: Runtime Operation, user task, source data

**Preview Target Identity**:
The media-specific identity of one exact canonical preview requested from
current Project and Canvas state before raster-width selection. It includes the
Source Revision when the target uses saved Project bytes, or a content digest
for uncommitted text, plus every target input that can change the requested
pixels. It does not include the Project binding or Project Path that owns a
resource; those scope resource keys.
_Avoid_: Source Revision, resource key, cache path

**Canonical Preview Source Identity**:
The producer-owned identity of the exact canonical raster source materialized
for one Preview Target Identity. It is distinct only when producer policy cannot
be known completely at target-selection time, such as Runtime video frame
extraction; image Source Revision and text Preview Target Identity already
determine their canonical sources.
_Avoid_: Preview Target Identity, Source Revision, source URL

**Preview Variant Identity**:
The identity of one displayable raster derived from a Preview Target Identity,
the producer's Canonical Preview Source Identity when distinct, and one exact
requested width. Changing ownership does not change this identity; changing
width or producer policy does.
_Avoid_: Preview Target Identity, source URL, retry key

**Preview Continuity Key**:
The owner-scoped identity of pixels that may remain visible while another
Preview Variant width loads. It contains the complete pixel identity but not
requested width or retry attempt. Image uses its Source Revision, Text uses its
Preview Target Identity, and Video adds its Canonical Preview Source Identity.
Changing width preserves continuity; changing any pixel-producing input does
not.
_Avoid_: Preview Variant Identity, source URL, load key

**Preview Quality Settlement**:
The transient boundary after which the Canvas may adopt the latest camera scale
for Preview Variant selection. It follows 500 ms of uninterrupted camera quiet,
is independent of interaction idle, and is shared across raster media.
_Avoid_: Camera idle, resource debounce, preview publication

**Feedback Mark**:
A selected categorical review signal that applies to one Project Path target as a
whole. One atomic Mark command may set or clear it across an exact path
selection without expanding directories.
_Avoid_: Reaction event, approval state

**Feedback Composition**:
Transient Workbench state that combines a target, Feedback kind, scope, and any
selected moment or geometry before a non-empty comment forms a Feedback Item.
_Avoid_: Pending Item, Draft Item

**Feedback Item**:
A durable non-empty review comment, optionally paired with normalized spatial
geometry, and scoped either to a Project Path target or a Feedback Moment.
_Avoid_: Note, region record, feedback history

**Feedback Moment**:
A stable label for one exact normalized timestamp in a video, shared by all
Feedback Items created for that timestamp.
_Avoid_: Frame number, playback position
