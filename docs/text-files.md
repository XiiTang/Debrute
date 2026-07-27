# Text Files, Editing, And Canvas Previews

This page records the current Project text-file, Workbench editor, and Canvas
text-preview contracts. Exact format tables, key bindings, failure-stage names,
capture budgets, and cache algorithms remain source-owned.

## Text Classification

Runtime owns one editor-independent text format registry. It classifies
paths by exact filename, path or filename pattern, extension, and selected
first-line signatures, and returns a Debrute text language ID plus MIME type.
Static filename-pattern matchers are compiled once for the Runtime process;
classification never recompiles glob-derived regular expressions per file.
Canvas MIME projection resolves registered filenames, patterns, and extensions
without opening the file, and reads a first line only when static classification
cannot decide the text type.
The registry covers plain text, Markdown and prompt files, structured data,
configuration, logs, web formats, programming languages, scripts, patches,
tables, subtitles, and additional document-oriented text formats. Binary office,
archive, and media formats are not classified as text.

Canvas uses this registry to decide whether a Project file is a text node.
CodeMirror maps the Debrute language ID to an available parser or an explicit
plain-text mode; editor-library names and extensions are not Project metadata.
The executable registry in `apps/runtime/src/project/files.rs` is the authority
for exact coverage.

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
cannot build a new Project snapshot; normal diagnostics report that state.

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
and consumes the current resolved Canvas Text Render Profile.

## Canvas Text Render Profile

Workbench owns one immutable Canvas Text Render Profile generation at a time.
Each Font Resource owns one managed family with exact SHA-256 face identities
and fixed numeric weights. Every face is normal style at 100% stretch; the
resource does not expose variable axes, Unicode ranges, alternate styles, or
synthetic faces. A catalog entry that needs CJK coverage composes an ordered
primary Resource and Noto Sans Mono CJK SC fallback Resource. The Profile
resolves the Runtime-owned global Canvas Text Appearance together with the fixed
editor geometry. Canvas Text Appearance is one complete value: managed font ID,
font size, line-height ratio, requested base weight, letter spacing, and the
common/contextual-ligature switch. The Profile derives pixel line height, fixed
word spacing and tab size, normal kerning, fixed OpenType and optical-sizing
settings, no-synthesis policy, line padding, gutter padding, and cursor scroll
geometry.

The managed Canvas Font catalog contains Noto Sans Mono CJK SC, Lilex,
JetBrains Mono, IBM Plex Mono, and proportional Noto Sans SC. Lilex, JetBrains
Mono, and IBM Plex Mono use the exact managed Noto Sans Mono CJK SC faces as
their CJK fallback. Catalog IDs are stable settings values; display names,
operating-system family names, file paths, and asset digests are not settings.
The default appearance selects Noto Sans Mono CJK SC at 12 px, a 1.4 line-height
ratio, requested weight 400, zero letter spacing, and enabled common/contextual
ligatures.

Every supported typography preference has one canonical mapping to the live
editor CSS binding, the CodeMirror measurement generation, the computed styles
read into a preview scene, and the Profile identity. A Profile is published
only after every managed face has been read, digest-verified, registered, and
loaded. The previously active exact Profile remains published while a requested
replacement prepares, then the replacement is published atomically.
Preparation failure is fatal for the requested Profile: it is not retried,
rewritten to another Canvas Font, or replaced by an implicit system-font
fallback.

Each managed Resource receives a digest-derived internal CSS family name, so
two font files with the same human-readable family name cannot collide. Its
weight faces share that internal family; a composed CJK fallback keeps its own
internal family and follows the primary family in the CSS family list. The same
exact bytes generate the `FontFace` instances used by live editors and are
supplied to the isolated raster Worker for its own `FontFace` registration.
System font names without readable, fixed font bytes are not valid managed
Profile assets.
Canvas rendering uses `font-synthesis: none`. The saved requested weight remains
independent of Canvas Font selection; when no exact normal face exists, the
renderer selects the closest real managed face without rewriting the request or
fabricating bold or oblique outlines. Workbench Theme syntax rules may request
a token-specific weight or style, but they cannot override the Canvas Font,
size, line height, letter spacing, or ligature value.

Settings exposes Canvas Text Appearance on the global Appearance page. Every
valid control change updates the real Canvas optimistically and submits the
complete value immediately. One Workbench window serializes those writes and
coalesces only values that have not been sent. Runtime events remain the
authoritative cross-window projection; a rejected write restores the latest
Runtime-confirmed appearance. There is no apply action, restore-default action,
custom font input, font import, or temporary preview editor.

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
Runtime is the sole validator and writer of the persisted value. Workbench
displays a separate pending viewport immediately while serializing Runtime
mutations. A Runtime response confirms only the submitted value, so a newer
pending viewport remains visible until its own response arrives. Failure drops
the pending value, restores the last Runtime-confirmed viewport, and is surfaced
without automatic retry.

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
- a style key derived from the complete Canvas Text Render Profile identity,
  effective theme text colors, syntax-highlight style identity, and a style
  snapshot version. The Profile identity includes exact font byte digests and
  every supported typography and editor-geometry value.

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
the hidden derived cache cannot recursively become one. Runtime reads and writes
only the exact requested fingerprint and Raster Engine path; neither lookup nor
save enumerates sibling fingerprint or engine-version directories. No byte
quota, LRU, or TTL applies to width variants.

## Capture Pipeline

`CanvasTextPreviewRuntime` derives current targets, checks source availability,
selects capture work, starts uploads, requests width variants, coordinates
publication, and owns typed per-node failures. Availability is returned per
item as available, missing, or error, so one invalid source cannot poison sibling
text nodes.

Text-body measurements are retained latest-by-path and coalesced once per
animation frame. Camera movement or node dragging cancels the pending
measurement frame without discarding its eligible paths; the batch resumes
after interaction becomes idle. Culled and actively edited text bodies do not
enter the batch, retain their last valid measurement, and receive one new
measurement when they next become eligible. A culled text node with no loaded
buffer also issues no file-content request; becoming visible or entering edit
intent performs the first read. Target reconciliation retains the
resolved fingerprint for every path whose content, language, wrap, measured
geometry, persisted viewport, and style key remain unchanged; changed paths
replace pending work instead of creating a historical queue.

Source availability uses the existing batch Runtime interface with at most one
request in flight. Camera movement or node dragging prevents a queued request
from starting; an already in-flight request may settle, while later targets are
retained by path with the newest identity winning and form the next batch after
interaction becomes idle. Availability and completed source-upload state enter
React as low-priority maintenance updates. There is no automatic retry.

`CanvasTextPreviewCaptureLane` owns one serialized browser capture lane. Work
does not enter the lane during camera movement or node dragging. Readiness,
scene building, and Worker submission occur on separate eligible frames. Scene
building is incremental and bounded to visible CodeMirror geometry: it records
only aligned visible line numbers, visible text fragments, and required
background planes as immutable drawing commands. Long wrapped or unwrapped
lines use bounded range searches rather than cloning the complete editor DOM.
Empty text is a valid blank scene; missing geometry and commands outside the
capture bounds are explicit failures.

When an inline editor releases a node, that path receives one capture priority
over ordinary visible maintenance. An already-rasterizing target is allowed to
finish; the priority changes only the next eligible target. Other visible work
keeps deterministic Canvas spatial order, and culled nodes do not start source
availability, capture, or variant work.

The main thread builds the immutable rectangle and text drawing-command scene
directly from the bounded CodeMirror geometry and prepares the checksum-verified
managed font bytes. It submits those values to one dedicated browser Worker.
The Worker loads each font profile once, draws the scene through
`OffscreenCanvas`, and encodes the fixed-scale PNG. It does not depend on
Worker-side SVG or HTML decoding. The Capture Lane owns serialized submission;
the Worker client rejects a concurrent request as an invariant violation. An
already-submitted job is not paused, terminated, or restarted when Canvas
interaction begins; stale completion is discarded by the existing runtime epoch
and target identity checks.

Once rasterization completes, source upload may continue while the lane advances
to another target. Runtime stores the canonical source atomically. Image, text,
and video callers then pass their selected source, target width, output policy,
and source validator to one shared raster-variant service. That service owns
width validation, equal-width direct-source return, keyed in-flight exclusion,
Raster Preview Engine identity, resize/encode, atomic cache publication, and
file response creation. Text selects alpha-preserving PNG output; the source
producer does not reimplement variant generation.

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

Preview failures are owned at the stage that can explain them: scene not ready,
scene-command invariant violation, source availability, raster rendering,
source upload, mounted-image load, or mounted-image decode. A failure affects only its
current node and source identity, allows later capture-lane work to continue,
and remains visible instead of becoming an empty success state.

Development/test performance counters record availability, capture readiness,
scene building, raster, upload, pending readiness, publication, and failure
boundaries. See [`canvas-rendering.md`](./canvas-rendering.md) for the shared
resource scheduler and diagnostic capture surface.

## Executable Authorities

- Text classification and safe file access: `apps/runtime/src/project/files.rs`
  and `apps/runtime/src/project/paths.rs`.
- Browser protocol views and mutations: `packages/app-protocol/src/` and
  `apps/runtime/src/workbench/project_routes.rs`.
- Buffer and save coordination: `apps/web/src/workbench/services/textFile*.ts`.
- CodeMirror language and editor ownership:
  `apps/web/src/workbench/canvas/CanvasTextEditor*.ts*` and
  `textEditorCodeMirrorLanguages.ts`.
- Text Viewport validation and persistence:
  `apps/runtime/src/project/canvas.rs`, `service.rs`, and
  `apps/runtime/src/workbench/project_routes.rs`.
- Pending Text Viewport display and Runtime-result reconciliation:
  `apps/web/src/workbench/services/canvasSnapshotUpdates.ts`.
- Preview identity, DOM scene extraction, Worker raster, runtime, handoff, and typed failures:
  `apps/web/src/workbench/canvas/CanvasTextPreview*.ts*`.
- Source capture and identity: `apps/web/src/workbench/canvas/CanvasTextPreview*.ts*`.
- Uploaded source storage: `apps/runtime/src/project/previews/mod.rs`.
- Shared image, text, and video width-variant derivation:
  `apps/runtime/src/project/previews/raster_variants.rs`.
- Integration coverage: `apps/runtime/src/project/tests.rs` and
  `apps/runtime/tests/runtime_lifecycle.rs`.
