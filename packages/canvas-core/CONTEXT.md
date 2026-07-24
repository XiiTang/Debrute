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
adds current availability, derived file-tree edges, and Project Diagnostics
without making them persisted Canvas state.
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

**Stack Order**:
The persisted back-to-front order of Canvas Nodes. It is independent of Project
hierarchy and automatic placement.
_Avoid_: Layer tree, z-order panel

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

**Feedback Item**:
A durable non-empty review comment, optionally paired with normalized spatial
geometry, and scoped either to a file or a Feedback Moment.
_Avoid_: Note, region record, feedback history

**Feedback Moment**:
A stable label for one exact normalized timestamp in a video, shared by all
Feedback Items created for that timestamp.
_Avoid_: Frame number, playback position
