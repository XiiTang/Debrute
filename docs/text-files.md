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
regular, non-binary, valid UTF-8 file; it receives plain-text language and MIME
defaults.

## Read And Write Contract

A text read resolves an existing Project-relative path inside the Project root,
requires a regular file, rejects NUL-bearing binary data and invalid UTF-8, and
returns content with a SHA-256 content revision. A write validates its UTF-8
bytes before revision comparison or temporary-file creation. The editor and
Canvas preview do not inherit a shared small file-size limit from this API.
The request body and file contents are materialized in memory; there is no
separate product-level text-size threshold. The browser-facing protocol omits
the absolute path.

A text write requires an existing Project-visible regular file, rejects final
symlinks, and compares the current content hash with the required
`expectedRevision`. A mismatch returns `project_file_revision_conflict` without
changing the file. A successful write creates a managed sibling temporary file,
preserves permission bits, captures that staged file's stable identity,
atomically renames it over the target, and returns the new content revision. The
following Project refresh preserves path-keyed Canvas and Feedback state only
while the target still has that committed identity; a subsequent external
same-path replacement invalidates the old state.

The write path does not parse or validate JSON, YAML, or any other structured
format. Project-visible `.debrute/feedback/feedback.json` can therefore be edited
through the same text API, as can other visible `.debrute/**` content. The
committed file remains successful even if the following Project refresh exposes
an invalid Feedback document or cannot build a new Project snapshot; normal
diagnostics report that state as `project_refresh_failed`.

## Workbench Text Buffers

Workbench maintains one buffer per Canonical Root and project-relative path.
A buffer owns content, Debrute language, word-wrap preference, dirty and saving
state, disk revision, external-change state, and an owning error.

Ordinary large text files remain displayable, editable, saveable, and eligible
for Canvas preview under the same text contract as smaller files.

One save coordinator runs per Project/path. Edits remain possible during a
write. Saving captures a content version and disk revision; if newer edits exist
after success, the newer buffer stays dirty while its disk baseline advances.
An explicit save of newer content queues one follow-up write, with repeated
requests coalescing to the latest intent. Reload and discard wait for the active
save chain. A conflicting external revision keeps current content dirty and
prevents a queued write from crossing that change automatically. Results from a
previous Canonical Root cannot update the newly active Project.

## CodeMirror Editor Boundary

`CanvasTextEditor` is the single editor component used by inline Canvas editing,
the hidden preview-capture surface, and floating text editor windows. It owns one
CodeMirror `EditorView`, reconfigurable language, read-only, and word-wrap
compartments, external-value synchronization, search, save and wrap commands,
and consumes the current resolved Canvas Text Render Profile.

Interactive editors use CodeMirror's drawn cursor rather than the browser's
native caret. Every drawn primary or secondary cursor uses `--db-text`, so it is
dark against the light Workbench theme and light against the dark Workbench
theme. The rule is shared by inline Canvas editors and floating text editor
windows; preview-capture surfaces remain non-interactive and omit cursors.

When a canonical preview source is missing, the hidden preview-capture surface
loads the complete current text into its read-only editor so CodeMirror can
reproduce the persisted pixel viewport and word wrapping exactly. This capture
buffer is independent of the interactive editor buffer. Preview-content count
and byte budgets limit only concurrent retained work: a task larger than the
soft byte budget runs alone rather than becoming ineligible or remaining queued
forever. Exact scheduling budgets are source-owned.

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
captured from the preview DOM, and the Profile identity. A Profile is published
to an actual live editor only after every full managed face has been read,
digest-verified, registered, and loaded. Merely projecting a text node or
generating a preview does not load full font bytes in the main renderer. Full
faces are retained by the current Project generation, reused by all live
editors in that Workbench, and removed when the generation ends. The previously
active exact Profile remains published while a requested replacement prepares,
then the replacement is published atomically. Cold preparation failure is
fatal for the requested Profile; replacement failure keeps the previous active
Profile. Neither case is retried, rewritten to another Canvas Font, or replaced
by an implicit system-font fallback.

Each managed Resource receives a digest-derived internal CSS family name, so
two font files with the same human-readable family name cannot collide. Its
weight faces share that internal family; a composed CJK fallback keeps its own
internal family and follows the primary family in the CSS family list. Full and
preview faces use separate internal aliases. Live editors use the
digest-verified full bytes. Preview snapshots use only the active
project-generation subset bundle described below; subsetting changes retained
tables and glyph coverage without changing the outlines or metrics of retained
glyphs.
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

For an inline Canvas text node, explicit Content Activation owns the live
editor. Canvas Node Selection alone does not. DOM focus is an input detail
rather than the ownership source. Pressing an inactive preview does not select
or activate it. Pointer release within the same preview commits the node
selection, activates its content, and carries those release coordinates into
the new editor; the runtime resolves a collapsed caret against the measured
position or the matching visible line block. Text bodies keep Canvas wheel
routing until focus enters the editor, after which scrolling stays local.

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

When an inactive node already has a loaded preview for the same current target,
selecting it keeps that exact DOM image mounted but hidden beneath the live
editor. Deselecting without a pixel-affecting change reveals the same image after
the Text Viewport commit, so it does not reload the resource.
Any content, language, wrap, geometry, viewport, or style change invalidates the
retained presentation synchronously before it can become visible.

## Preview Identity

A Canvas text-preview resource key is scoped by Project binding and
project-relative path around a SHA-256 Preview Target Identity. The target identity includes every
current pixel-affecting input owned by the pipeline:

- the `Canvas Text Preview Source Version`, which changes with the browser
  capture contract;
- a raster-environment identity containing the target platform, Desktop or
  browser frontend, Chromium engine, repository-owned raster-contract version,
  and fixed system-fallback-policy version. The raster contract is bumped when a
  supported Chromium change can alter preview pixels; Workbench does not inspect
  User-Agent values;
- the exact SHA-256 content digest and Runtime-projected Debrute language;
- word-wrap state;
- canonical text-body width and height derived from node geometry by the fixed
  `10x` presentation scale and `32px` titlebar contract;
- persisted Text Viewport;
- the adaptive canonical source dimensions and scale; and
- a style key derived from the complete Canvas Text Render Profile identity,
  effective theme text colors, syntax-highlight style identity, and a style
  snapshot version. The Profile identity includes exact font byte digests and
  every supported typography and editor-geometry value.

The canonical source scale is the minimum of `4`, `4096 / cssWidth`,
`4096 / cssHeight`, and `sqrt(8,388,608 / (cssWidth * cssHeight))`. Pixel
dimensions are the floored CSS dimensions multiplied by that scale. This keeps
small nodes at 4x while bounding every source to 4096 pixels on either axis and
8,388,608 pixels in total. The capture-policy version is a source-pipeline
version rather than a Project revision. Width variants add the shared
`Raster Preview Engine Version` and requested width to that source identity.
When the requested width reaches the canonical source width, Runtime returns
`source.png` directly rather than decoding and encoding an equal-width PNG.
For the current Project Root Key, cache paths are therefore:

```text
~/.debrute/cache/roots/<rootKey>/canvas/canvas-text-previews/
  <source-path-key>/<target-identity-key>/
    source.png
    raster-engine-v<version>/
      preview-w<width>.png
```

The direct-source tier adds no `preview-w<source-width>.png` entry and consumes
no Raster Preview Pool slot.

The Runtime-global cache tree is outside the Project and is not Project-visible.
The Project's `.debrute/` directory remains ordinary visible content. Any
visible Project text file remains eligible as a source; the external derived
cache cannot recursively become one. Runtime reads and writes
only the exact requested target identity and Raster Engine path; neither lookup
nor save enumerates sibling target-identity or engine-version directories. No byte
quota, LRU, or TTL applies to width variants.

## Capture Pipeline

`CanvasTextPreviewRuntime` owns one real-time task registry keyed by
project-relative path; the current target identity is the task version. Every
stable missing-or-stale target is admitted, including offscreen nodes. The same
path is latest-wins: new input replaces pending work, invalidates a running target,
and makes any stale read, capture,
upload, or publication result ineligible. There is no frozen cohort, historical
queue, viewport-admission queue, or editor-priority batch.

Text and video canonical preview lanes share one pure scheduling rule while
retaining separate executors. At each new-job boundary Workbench orders current
tasks by the squared distance from the viewport center to the nearest point of
each node rectangle; project-relative path breaks exact ties. Camera movement
and node dragging prevent new
availability, content-read, coverage, font, and capture jobs from starting.
In-flight reads, font work, capture, and upload may finish, but identity checks
discard stale results. The latest stable viewport is consulted again at the
next job boundary. An actively edited text node has no canonical task; when it
leaves edit mode it joins the live registry immediately if work remains, or
starts the next work epoch if the registry was empty.

Runtime projects the exact full-file SHA-256 revision and Debrute text language.
Workbench therefore computes target identities before loading saved file bodies and
checks all canonical-source availability first. A matching `source.png` cache
hit performs no content read, font work, or DOM capture. Dirty editor content is
UTF-8 encoded once to obtain its byte length and SHA-256 digest. For a missing
target, an already matching editor buffer is referenced without copying;
otherwise Workbench performs a preview-private Runtime read that never enters
the long-lived editor-buffer store. The response revision and language must
match the target, and its content reference is released immediately after
capture. A rolling materialization view over the registry holds at most 10
targets and 8 MiB of UTF-8 content, with at most two reads in flight. The
current capture and already loaded editor buffers count against the same
logical window.

Workbench scans materialized content directly by Unicode codepoint, without
normalization or DOM inspection. Coverage always includes U+0020 through
U+007E and U+FFFD, deduplicates and sorts once, and yields in roughly 4 ms
slices. One project-generation preview-font session retains one active subset
bundle and allows one short-lived Worker build at a time. Within a non-empty
registry epoch, requested coverage only grows: a later candidate is rebuilt
from the complete original managed primary and fallback faces for the epoch's
full union, not patched as a delta. The active bundle continues serving covered
targets while the candidate builds. Candidate faces are loaded off to the side,
then atomically replace the active faces at a capture boundary. When the
registry becomes empty, the coverage union resets; a later epoch reuses the
active bundle only when it is already a superset. The bundle is memory-only,
persists for the Project generation, and is neither project-persisted nor shared
across Projects or Workbench instances. Every Worker terminates after its build.

Source availability uses one Runtime request in flight. Availability is
returned per item as available, missing, or error, so one invalid source cannot
poison sibling nodes. A missing glyph in the active bundle is ordinary
`waiting-font` work rather than a failure. The first implementation has no
automatic retry or partial-font success model; typed terminal failures remain
node-local.

`CanvasTextPreviewCaptureLane` owns one serialized browser capture lane and one
hidden read-only `CanvasTextEditor`. Work does not enter the lane during camera
movement or node dragging. Readiness, DOM snapshot slices, image decode, draw,
and PNG encoding run only for that current job; inactive nodes remain `<img>`
presentations rather than retaining CodeMirror DOM or loading an editor buffer.
The title chrome and mounted preview are valid without a `TextFileBuffer`; only
Content Activation requests the live editor body. The lane incrementally
rebuilds the current CodeMirror DOM from shallow element clones and text nodes,
copying an explicit allowlist of pixel-affecting computed styles over eligible
animation frames with a source-defined slice target. It removes cursor,
selection, tooltip, panel, and announcement layers, strips URL/event-bearing
attributes, and materializes the current horizontal and vertical scroll offsets
as clone-stable transforms. Empty text is a valid blank capture; missing
CodeMirror viewport geometry and unsupported DOM elements are explicit failures.

The clone is serialized incrementally in the same interaction-gated frame
slices. Text nodes are split only at Unicode-safe chunk boundaries; the XML
parts become one SVG Blob, and asynchronous browser `FileReader` encoding
produces the self-contained `foreignObject` data URL without a synchronous
whole-SVG join or percent-encoding pass.
The snapshot embeds only active subset faces whose managed family appears in
the computed DOM family list and whose weight is required. If a requested
weight has no exact managed face, it embeds that managed family's complete face
set so the browser performs the same closest-face match as the live editor. One
decoded image is drawn once into an adaptive-size
`OffscreenCanvas` and encoded as PNG. There is no drawing-command scene, raster
Worker, alternate renderer, or compatibility fallback. An already-rasterizing
job is not paused or restarted when Canvas interaction begins; stale completion
is discarded by the existing runtime epoch and target identity checks.

Once rasterization completes, source upload may continue while the lane advances
to another target. Runtime stores the canonical source atomically. Image, text,
and video callers then pass their selected source, target width, and source
validator to one shared raster-variant service. That service owns
width validation, equal-width direct-source return, keyed in-flight exclusion,
Raster Preview Engine identity, resize/encode, atomic cache publication, and
file response creation. The transparent Text source carries an alpha channel,
so the shared format rule selects alpha-preserving PNG output; the source
producer does not reimplement variant generation.

## Variant Selection And Mounted Handoff

Variant width uses the same node display width, settled resource zoom, device
pixel ratio, and stepped raster scale model as image previews. Canonical source
admission and current-width variant production are viewport-independent. The
nearest current node is scheduled first, but all current variants are admitted.
Text variant mounts use the shared
image/video/text resource-start scheduler. A decoded replacement uses the same
publication queue as image and video; an initial decoded preview publishes
immediately because it has no visible predecessor.

Typed failures remain visible and do not retry automatically. A node-local
Retry clears only the current target's failure and restarts source availability
checking; any still-valid visible presentation remains mounted until a new
presentation is ready.

Presentation uses mounted visible and pending `<img>` layers. A pending variant
is mounted once, and that DOM image owns network loading, error, and readiness.
Its `load` event, or a cached `complete` image with a positive intrinsic width,
begins `decode()`. It is promoted only if its Preview Continuity Key, Preview
Variant Identity, retry attempt, and DOM membership are still current; there is
no preliminary `fetch(...).blob()` request or off-DOM image preload. The prior
visible image remains mounted throughout, including hidden retention beneath
the content-active editor. Text waits only for the promoted image's React DOM commit
before releasing a retiring editor. It uses no fixed timeout or animation-frame
paint proxy. Stale producer work is discarded by runtime epoch and target key;
stale presentation work is discarded by continuity and variant identity.

Viewport culling changes only shell display. It does not suppress canonical
source work, current-width variant work, mounted handoff, or committed preview
state.

## Failure And Observability Contract

Preview failures are owned at the stage that can explain them: font preparation,
capture not ready, DOM snapshot, source availability, raster rendering,
source upload, or mounted-image load. A failure affects only its current node
and source identity, allows later capture-lane work to continue, and remains
visible instead of becoming an empty success state.

Development/test performance counters record availability, coverage collection,
subset duration and linear-memory peak, capture readiness, DOM snapshot, raster,
upload, and producer failures. Shared raster counters record request, mounted
pending DOM, decode, publication, presentation failure, and retry boundaries. See
[`canvas-rendering.md`](./canvas-rendering.md) for the shared
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
- Canvas Text Viewport projection:
  `apps/web/src/workbench/canvas/CanvasScene.ts`.
- Preview identity, DOM capture, raster, runtime, handoff, and typed failures:
  `apps/web/src/workbench/canvas/CanvasTextPreview*.ts*`.
- Project-load full-font and subset-font ownership:
  `apps/web/src/workbench/canvas/font-subset/`.
- Locked font-subset façade, sources, ABI, and maintainer rebuild:
  `assets/wasm/` and `scripts/*canvas-text-font-subset*`.
- Uploaded source storage: `apps/runtime/src/project/previews/mod.rs`.
- Shared image, text, and video width-variant derivation:
  `apps/runtime/src/project/previews/raster_variants.rs`.
- Cross-layer coverage: `apps/runtime/src/project/tests.rs` and
  `apps/runtime/tests/runtime_lifecycle.rs`.
