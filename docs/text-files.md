# Text Files, Editing, And Canvas Previews

This page records the current Project text-file, Workbench editor, and Canvas
text-preview contracts. Exact format tables, key bindings, failure-stage names,
capture budgets, and cache algorithms remain source-owned.

## Text Classification

Project Core owns one editor-independent text format registry. It classifies
paths by exact filename, path or filename pattern, extension, and selected
first-line signatures, and returns a Debrute text language ID plus MIME type.
The registry covers plain text, Markdown and prompt files, structured data,
configuration, logs, web formats, programming languages, scripts, patches,
tables, subtitles, and additional document-oriented text formats. Binary office,
archive, and media formats are not classified as text.

Canvas uses this registry to decide whether a Project file is a text node.
CodeMirror maps the Debrute language ID to an available parser or an explicit
plain-text mode; editor-library names and extensions are not Project metadata.
The executable registry in `projectTextFileTypes.ts` is the authority for exact
coverage.

Text-file access is broader than Canvas classification. A Project-visible file
with an unfamiliar suffix can still be opened through the text API when it is a
regular, bounded, non-binary, valid UTF-8 file; it receives plain-text language
and MIME defaults.

## Read And Write Contract

A text read resolves an existing Project-relative path inside the Project root,
requires a regular file, applies the open-time size limit, rejects NUL-bearing
binary data and invalid UTF-8, and returns content with a SHA-256 content
revision. The browser-facing protocol omits the absolute path.

A text write requires an existing Project-visible regular file, rejects final
symlinks, and compares the current content hash with the required
`expectedRevision`. A mismatch returns `project_file_revision_conflict` without
changing the file. A successful write creates a managed sibling temporary file,
preserves permission bits, atomically renames it over the target, and returns the
new content revision.

The write path does not parse or validate JSON, YAML, or any other structured
format. Project-visible Debrute Project Documents can therefore be edited through
the same text API, while generic create, rename, move, copy, and delete remain
blocked for protected `.debrute` paths. The committed file remains successful
even if the following Project refresh exposes an invalid structured document or
cannot build a new snapshot; normal diagnostics report that state.

## Workbench Text Buffers

Workbench maintains one buffer per Project identity and project-relative path.
A buffer owns content, Debrute language, word-wrap preference, dirty and saving
state, disk revision, external-change state, and an owning error.

One save coordinator runs per Project/path. Edits remain possible during a
write. Saving captures a content version and disk revision; if newer edits exist
after success, the newer buffer stays dirty while its disk baseline advances.
An explicit save of newer content queues one follow-up write, with repeated
requests coalescing to the latest intent. Reload and discard wait for the active
save chain. A conflicting external revision keeps current content dirty and
prevents a queued write from crossing that change automatically. Results from a
previous Project identity cannot update the newly active Project.

## CodeMirror Editor Boundary

`CanvasTextEditor` is the single editor component used by inline Canvas editing,
the hidden preview-capture surface, and floating text editor windows. It owns one
CodeMirror `EditorView`, reconfigurable language, read-only, and word-wrap
compartments, external-value synchronization, search, save and wrap commands,
and the shared Canvas text metrics.

For an inline Canvas text node, only a unique single-node selection owns the live
editor. Multi-selection does not. DOM focus is an input detail rather than the
ownership source. A first pointer selection carries its coordinates into the
new editor; the runtime resolves a collapsed caret against the measured position
or the matching visible line block. Text bodies keep Canvas wheel routing until
focus enters the editor, after which scrolling stays local.

Floating text editor windows use the same editor and buffer but are independent
of inline Canvas selection and Canvas preview handoff.

## Text Viewport And Editor Handoff

Each Canvas text node may persist a Text Viewport containing non-negative
`scrollTop` and `scrollLeft`. Top-left is represented by the absence of the
field. Reconciliation preserves the viewport for a surviving text node, and
Workbench applies local viewport updates immediately while serializing the
matching Canvas Document writes.

The editor tracks its viewport on scroll and commits the last observation on
blur, unmount, or the active-to-read-only transition. Deselecting an inline text node does not
immediately destroy its `EditorView`: it becomes read-only and remains the
visible layer until both conditions are true:

1. the committed Text Viewport is present in current Canvas state; and
2. the preview for the exact current target has committed as a visible DOM
   image, or a typed preview failure has been surfaced.

This prevents stale-scroll previews and blank editor-to-preview transitions.
Timeouts, DOM-focus heuristics, and a fallback text renderer are not handoff
authorities.

When an inactive node already has a decoded preview for the same current target,
selecting it keeps that exact DOM image mounted but hidden beneath the live
editor. Deselecting without a pixel-affecting change reveals the same image after
the Text Viewport commit, so it neither requests nor decodes the resource again.
Any content, language, wrap, geometry, viewport, or style change invalidates the
retained presentation synchronously before it can become visible.

## Preview Identity

A Canvas text-preview target is identified by the Canvas ID, project-relative
path, and a SHA-256 visual fingerprint. The fingerprint includes every current
pixel-affecting input owned by the pipeline:

- the `Canvas Text Preview Source Version`, which changes with the browser
  capture contract;
- text content and Debrute language;
- word-wrap state;
- measured text-body width and height;
- persisted Text Viewport;
- the fixed canonical source scale; and
- a style key derived from shared text metrics, effective theme text colors,
  syntax-highlight style identity, and a style snapshot version.

The canonical source uses a fixed 4x raster scale. Its version is a source-
pipeline version rather than a Project revision. Width variants add the shared
`Raster Preview Engine Version` and requested width to that source identity.
When the requested width reaches the canonical source width, Runtime returns
`source.png` directly rather than decoding and encoding an equal-width PNG.
Cache paths are therefore:

```text
.debrute/cache/canvas-text-previews/
  <canvas-id>/<source-path-key>/<fingerprint-key>/
    source.png
    raster-engine-v<version>/
      preview-w<width>.png
```

The direct-source tier adds no `preview-w<source-width>.png` entry and consumes
no Raster Preview Pool slot.

The cache tree is not Project-visible. A project-visible `.debrute` text file,
including a Canvas Map or Canvas JSON document, remains eligible as a source;
the hidden derived cache cannot recursively become one. Once a new fingerprint
becomes the current source identity for the same Canvas and Project path,
Runtime removes superseded fingerprint and engine-version directories without
applying a byte quota, LRU, or TTL to the current identity's width variants.

## Capture Pipeline

`CanvasTextPreviewRuntime` derives current targets, checks source availability,
selects capture work, starts uploads, requests width variants, coordinates
publication, and owns typed per-node failures. Availability is returned per
item as available, missing, or error, so one invalid source cannot poison sibling
text nodes.

`CanvasTextPreviewCaptureLane` owns one serialized browser capture lane. Work
does not enter the lane during camera movement or node dragging. Readiness,
snapshot building, and raster start occur on separate eligible frames. Snapshot
building is incremental and bounded to visible CodeMirror geometry: it copies
only aligned visible line numbers, visible text fragments, and required
background planes. Long wrapped or unwrapped lines use bounded range searches
rather than cloning the complete editor DOM. Empty text is a valid blank
snapshot; missing geometry and escaping or unmarked descendants are explicit
failures.

The rasterizer converts only the bounded snapshot to the fixed-scale PNG. Once
rasterization completes, source upload may continue while the lane advances to
another target. Runtime stores the canonical source atomically, creates
requested PNG width variants through the shared raster service, reuses existing
variants, and deduplicates identical in-flight variant work.

## Variant Selection And Mounted Handoff

Variant width uses the same node display width, settled resource zoom, device
pixel ratio, and stepped raster scale model as image previews. Culled nodes do
not request new variants. Text variant mounts use the shared image/video/text
resource-start scheduler; promotion and visible commit use its publication
queue.

Presentation uses mounted visible and pending `<img>` layers. A pending variant
is mounted once, and that DOM image owns network loading, decode, error, and
readiness. It is promoted only if it is still the current source and DOM element;
there is no preliminary `fetch(...).blob()` request. The prior visible image
remains mounted throughout, including hidden retention beneath the selected
editor. Mounting, promotion, and visible commit run only on eligible idle frames.
Stale work is discarded by runtime epoch, target key, and source key.

Culling suppresses new preview work but retains an already committed image.
Hidden retained text bodies may measure `0x0`; that observation does not replace
the last valid body size, invalidate the committed preview, or unload it.

## Failure And Observability Contract

Preview failures are owned at the stage that can explain them: snapshot not
ready, snapshot invariant violation, source availability, raster rendering,
source upload, mounted-image load, or mounted-image decode. A failure affects only its
current node and source identity, allows later capture-lane work to continue,
and remains visible instead of becoming an empty success state.

Development/test performance counters record availability, capture readiness,
snapshot, raster, upload, pending readiness, publication, and failure
boundaries. See [`canvas-rendering.md`](./canvas-rendering.md) for the shared
resource scheduler and diagnostic capture surface.

## Executable Authorities

- Text classification and safe file access: `packages/project-core/src/`.
- Browser protocol views and mutations: `packages/app-protocol/src/` and
  `apps/runtime/src/workbench/project_routes.rs`.
- Buffer and save coordination: `apps/web/src/workbench/services/textFile*.ts`.
- CodeMirror language and editor ownership:
  `apps/web/src/workbench/canvas/CanvasTextEditor*.ts*` and
  `textEditorCodeMirrorLanguages.ts`.
- Text Viewport persistence: `packages/canvas-core/src/index.ts` and
  `apps/web/src/workbench/services/canvasSnapshotUpdates.ts`.
- Preview identity, capture, runtime, handoff, and typed failures:
  `apps/web/src/workbench/canvas/CanvasTextPreview*.ts*`.
- Source and variant storage: `packages/canvas-core/src/canvasTextPreviews.ts`
  and `apps/runtime/src/project/previews/mod.rs`.
- Integration coverage: `apps/runtime/src/project/tests.rs` and
  `apps/runtime/tests/runtime_lifecycle.rs`.
