# Inactive Text Nodes Use Derived Previews

ADR 0015 clarifies that the uniquely selected editor described here is a
read-only Inline Text Presentation until Canvas Content Activation grants edit
interaction. The preview and handoff decisions in this ADR otherwise remain
accepted.

Only the uniquely selected Canvas text node owns a live inline CodeMirror
editor; inactive text nodes use cached raster previews derived from the same
content, style, geometry, and persisted Text Viewport. A selected editor may
retain its already decoded, current-target preview DOM image mounted but hidden.
Entering edit mode keeps that retained preview published while the node-local,
on-demand editor prepares its buffer, exact interactive font profile, editor
module, language extension, initial Text Viewport, and visible syntax layout.
The preparing editor is visually hidden and inert. Only the editor's current
layout-ready signal publishes it, removes `inert`, hides the preview, and applies
the pending pointer focus request in the same pre-paint commit. Losing selection
before publication discards that editor activation without entering the
editor-to-preview handoff. Activation failures keep any valid preview visible
under an explicit text-editor error; they do not publish a partial plaintext
editor, retry automatically, or fall back to a shared `EditorView`.
On deselection, the editor becomes read-only and remains mounted until its
viewport is durable and a current-target preview image has committed, or a typed
failure is visible. If no pixel-affecting input changed, the retained image is
revealed without another resource request; if only the requested width changed,
the retained image remains visible while the next width loads. This trades a
capture and cache pipeline for stable large-Canvas rendering and a handoff that
neither loses scroll position nor flashes blank or stale content, instead of
keeping every CodeMirror editor live. One serialized capture lane renders the
current hidden CodeMirror DOM into the canonical source described by
[`0006-text-preview-dom-is-the-visual-authority.md`](./0006-text-preview-dom-is-the-visual-authority.md).
All stable missing text sources enter one viewport-independent latest-wins task
registry. The exact viewport affects only next-job and width-variant request
order; every current node remains admitted. Image, text, and video sources then
share one Runtime width-variant service.
