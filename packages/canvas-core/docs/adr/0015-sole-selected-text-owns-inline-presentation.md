---
status: accepted
---

# Sole-selected text owns the Inline Text Presentation

Canvas Node Selection and Canvas Content Activation remain distinct. The stable
sole-selected text node owns the one Inline Text Presentation, while Content
Activation only grants that presentation editable, interactive ownership of its
Content Region. Empty, non-text, and many-node selections own no
Inline Text Presentation.

The presentation uses one node-local CodeMirror `EditorView`. While selected but
content-inactive it is visible, read-only, inert, unfocused, and without Canvas
text-wheel ownership. Activating the Content Region reconfigures the same view
as editable and applies the completed click's caret request. Ending Activation
while the text remains selected reconfigures the same view as read-only and does
not begin editor-to-preview handoff. Leaving the stable sole-text Selection
retires the view only after the durable Text Viewport and exact current preview
are ready under ADR 0003.

Inline Text Presentation is derived rather than stored. Its path is the sole
path of the current Canvas Node Selection only when that accepted node is text.
An active Selection Marquee uses its pre-gesture Selection for presentation and
adopts the completed Selection once at gesture end, preventing transient
one-node intersections from repeatedly mounting and retiring CodeMirror. Canvas
Content Activation remains valid only for the sole selected node, so it cannot
provide a second presentation path.

Starting resize continues to sole-select the node and end Content Activation as
specified by ADR 0011. For text, that leaves the same read-only Inline Text
Presentation mounted. `CanvasStageRuntime`, already the sole direct node-layout
writer during a Manual Layout Draft, derives the canonical rounded text frame
from the shared text-presentation geometry and writes it with every node layout.
CodeMirror can therefore remeasure and reflow throughout resize without a React
scene update or per-pointer preview capture.

Video and audio do not adopt selection-derived presentation. Video keeps its
existing preview, player, playback, and Feedback-driven mount lifecycle. Audio
keeps its stable mounted player. Their Content Activation continues to govern
content interaction and local keyboard ownership without making Selection a
media-resource lifetime authority.

This decision clarifies ADR 0003's uniquely selected live editor as a read-only
presentation before Activation. It supersedes only ADR 0011's statements that
text Activation hands the preview to the live editor and that an activation
click has no selected-only presentation. ADR 0011's separation of Selection,
Content Activation, and manipulation, including resize ending Activation,
remains accepted.

The result deliberately accepts the cost of at most one selected-only
CodeMirror view so that editor preparation is outside the resize hot path. It
rejects mounting an editor at resize start, storing a second real-time flag,
keeping a second read-only editor, updating React geometry on pointer move,
regenerating text previews per resize frame, and applying the text rule to video
or audio.
