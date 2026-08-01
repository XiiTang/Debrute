# Canvas

The Canvas context names the visual organization and review model projected from
Project files.

## Language

**Canvas**:
A visual workspace whose nodes represent selected Project files and directories,
with stored layout, stack order, annotations, feedback, and preferences. Canvas
state is secondary to Project files: missing or invalid Canvas state never makes
the Project files unavailable.
_Avoid_: Board, document layer

**Canvas Map**:
A YAML document that selects the Project paths appearing on one Canvas and may
define automatic comparison rows for those selected paths.
_Avoid_: Canvas document, workflow

**Canvas Node**:
The Canvas representation of one Project file or directory, identified by its
project-relative path.
_Avoid_: Asset record, layer

**Canvas ID**:
The stable filesystem-safe identity shared by one Canvas, its Canvas Map, and
its registry entry. It does not change when the Canvas is renamed.
_Avoid_: Canvas name, title

**Canvas Name**:
The editable display label of a Canvas. It is presentation, not identity.
_Avoid_: Canvas ID

**Canvas Document**:
The pushed JSON state for one Canvas: identity, display name, materialized node
geometry, stack order, annotations, and preferences.
_Avoid_: Canvas Map, live editor state

**Canvas Projection**:
The runtime view produced from a Canvas Document and current Project state. It
adds current availability, exact text language for available text files, derived
file-tree edges, and Project Diagnostics without making them persisted Canvas
state.
_Avoid_: Canvas Document

**Canvas Registry**:
The ordered collection of Canvas IDs for one Project. Every registered ID owns
exactly one Canvas Document and one Canvas Map.
_Avoid_: Recent canvases, active Canvas

**Automatic Layout**:
Deterministic hierarchy-and-row placement recalculated from current Canvas Map
membership for nodes without a manual override.
_Avoid_: Saved layout, fallback layout

**Manual Layout**:
A persisted node rectangle created by direct move or resize and preserved while
the node remains a member of the Canvas.
_Avoid_: Locked node, drag preview

**Manual Layout Draft**:
A not-yet-confirmed node rectangle produced by direct move or resize. It may be
presented over a Canvas Projection, but it is not Canvas Document state.
_Avoid_: Manual Layout, pending layout, optimistic Canvas Document

**Stack Order**:
The persisted back-to-front order of Canvas Nodes. It is independent of Project
hierarchy and automatic placement.
_Avoid_: Layer tree, z-order panel

**Canvas Text Appearance**:
The user's complete global typography value for Project text shown on every
Canvas, comprising font selection, font size, line height, font weight request,
letter spacing, and ligatures. Changing Projects or Canvases does not
override it. Runtime owns it as the complete `canvas.textAppearance` member of
global settings rather than a Project, Canvas Document, Workbench Theme, or
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
The persisted scroll position confirmed in a Canvas Document and shared by a
Canvas text node's editor and derived preview. An unconfirmed local scroll
position is transient interaction state rather than a Text Viewport.
_Avoid_: Editor focus, capture viewport

**Playback Position**:
The persisted video timestamp shared by an active player and the derived still
preview used when that player is inactive.
_Avoid_: Player time, playback session

**Canvas Maintenance Job**:
An automatic, rebuildable attempt to derive a preview, fill a cache, or update
an index from authoritative Project and Canvas state. It has no public identity,
history, or Operation lifecycle and may be cancelled, coalesced, or superseded.
_Avoid_: Runtime Operation, user task, source data

**Feedback Mark**:
A selected categorical review signal that applies to one Project file as a
whole.
_Avoid_: Reaction event, approval state

**Feedback Composition**:
Transient Workbench state that combines a target, Feedback kind, scope, and any
selected moment or geometry before a non-empty comment forms a Feedback Item.
_Avoid_: Pending Item, Draft Item

**Feedback Item**:
A durable non-empty review comment, optionally paired with normalized spatial
geometry, and scoped either to a file or a Feedback Moment.
_Avoid_: Note, region record, feedback history

**Feedback Moment**:
A stable label for one exact normalized timestamp in a video, shared by all
Feedback Items created for that timestamp.
_Avoid_: Frame number, playback position
