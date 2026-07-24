# Inactive Text Nodes Use Derived Previews

Only the uniquely selected Canvas text node owns a live inline CodeMirror
editor; inactive text nodes use cached raster previews derived from the same
content, style, geometry, and persisted Text Viewport. A selected editor may
retain its already decoded, current-target preview DOM image mounted but hidden.
On deselection, the editor becomes read-only and remains mounted until its
viewport is durable and a current-target preview image has committed, or a typed
failure is visible. If no pixel-affecting input changed, the retained image is
revealed without another resource request; if only the requested width changed,
the retained image remains visible while the next width loads. This trades a
capture and cache pipeline for stable large-Canvas rendering and a handoff that
neither loses scroll position nor flashes blank or stale content, instead of
keeping every CodeMirror editor live.
