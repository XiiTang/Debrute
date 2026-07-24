# Canvas Rendering And Preview Resources

This page records the current Canvas rendering, image-preview, scheduling, and
performance-diagnostics contracts. It complements
[`canvas.md`](./canvas.md), which owns the document, registry, layout, and
interaction model. Counter names and lower-level algorithms remain
source-owned; user-visible scheduling thresholds are recorded here when they
form part of the intended interaction contract.

Text preview capture and editor handoff are documented in
[`text-files.md`](./text-files.md). Video preview sources, player lifecycle, and
handoff are documented in [`canvas-media.md`](./canvas-media.md). This page owns
their shared scheduling, culling, and diagnostic boundaries only.

## Camera And Render Hot Path

Camera movement is not a React geometry loop. `CanvasEditorRuntime` publishes
the live camera, `CanvasStageRuntime` writes the stage transform directly, and
the render-snapshot scheduler coalesces moving updates onto animation frames.
When movement becomes idle, the pending moving update is cancelled and the
final camera is flushed immediately.

`CanvasRenderCoordinator` owns mounted render membership. It builds reusable
spatial indexes for nodes and routed edge segments, queries an overscanned
virtual rectangle, and refreshes a moving snapshot only when the live viewport
approaches the retained margin or a zoom change makes the previous virtual area
too broad. Geometry or edge membership changes rebuild the index once;
availability, presentation, and stack-order-only changes update current node
data without rebuilding spatial membership.

Selection, active move/resize paths, and local layout drafts pin the affected
nodes into the snapshot. Edges are queried independently of endpoint-node
mounting and are rerouted from draft geometry when an endpoint moves or
resizes.

Image and text nodes retain stable component identity while they belong to the
active Canvas, even when offscreen. Other node types can be omitted outside the
virtual rectangle. `CanvasVisibilityController` turns retained-but-culled node
shells on and off through cached stage writes; selected and active nodes remain
display-visible. This culling state is a rendering decision, not Canvas
Document visibility.

## Image Preview Source Selection

The Runtime projection marks a still raster image previewable only after its
path, decoded media type, page count, and intrinsic width are validated. The
projection supplies source width and revision metadata; the browser does not
probe the source file to invent missing values. Source pixel count or the size
of a hypothetical full RGBA decode is not node availability: a valid large
image remains an available Project node even when a particular derivative
request would exceed its derivation boundary.

For a previewable image node, Workbench derives one target width from:

- the node's displayed width;
- the intrinsic source width;
- the settled resource zoom; and
- device pixel ratio.

The scale is quantized on a square-root-of-two ladder and clamped between the
minimum preview scale and the intrinsic preview-source width. There is no fixed
cross-media maximum preview width. The resulting URL contains only the Project
path, source revision, and target width. JPEG, PNG, WebP, and AVIF requests
whose target has reached intrinsic source width return the revision-bound
Project file through that preview route as an intentional direct-source tier;
Runtime performs only the source validation needed by the route and does not
decode pixels, resize, re-encode, or cache an equal-width copy. TIFF
and SVG/SVGZ remain derived variants because they require browser conversion
or Runtime-controlled safe rasterization. Unsupported or invalid preview state
is explicit and does not treat the raw file as an error fallback.

A lower tier is still sized for the current device pixel ratio. On a Retina
display it should remain visually sharp at its smaller on-screen size; tier
changes are verified from the requested and decoded pixel width, not from an
intentional blur or visible loss of quality.

Resource zoom follows the live camera while idle, freezes at the last idle zoom
for the whole movement, and catches up to the final camera zoom when movement
settles. This keeps camera transforms independent from preview-resolution churn.
The short camera-idle threshold answers only whether interaction is still in
progress; it does not authorize an immediate quality replacement.

## Node-Local Image Lifecycle

Each mounted image node owns its source revision, retry key, loaded image, next
image, and local error. Canvas Surface provides only shared resolution and
interaction context.

The first eligible display-visible image may begin immediately. Once an image
is loaded, camera movement and culling retain it and suppress replacement
quality work. A different desired preview becomes a hidden next image while the
loaded image stays visible. A matching browser load event promotes the next
image only after a paint opportunity; stale load events are ignored. A failed
replacement leaves the loaded image intact, retry affects one node, and a
source-revision change resets only that node.

The direct-source tier uses the same loaded/next handoff and revision identity
as derived variants; reaching source width never replaces the visible image
before the original can be painted. Leaving and re-entering the viewport
therefore does not recreate the image resource or flash a placeholder. Node
deletion naturally releases its local state. There is no production-wide image
asset runtime, loading-plan store, or decoded-image budget acting as the source
of truth.

## Shared Preview Scheduling

Image, video, and Canvas text-preview producers share one scheduler for deferred
resource starts. Image handoffs and Canvas text-preview promotion and commit
phases use the same scheduler for result publication. The scheduler controls
when work may enter a frame; it does not own resource or presentation state.
Canvas text previews keep their separate serialized capture lane described in
[`text-files.md`](./text-files.md).

The scheduler:

- coalesces queued request starts and queued result publications independently
  by preview kind and node identity, with the newest work in each phase winning;
- pauses deferred starts while camera movement or node dragging is active;
- starts current visible queued work on the next animation frame after
  interaction becomes idle;
- shares a three-operation animation-frame budget across eligible request starts
  and image or text result publications;
- gives ready publications priority over starting more resource work; and
- rechecks current identity and culling immediately before either operation.

The camera-idle boundary is the only time gate. Resource zoom remains fixed
while the camera moves, and queued starts coalesce by node, so intermediate
image, video, or text-preview tiers are already suppressed without a second
post-idle timer.
Once idle, current visible starts and ready publications share the next-frame
budget. Publications enter React as low-priority transitions so new input can
preempt them. Stale publications are discarded. Culled publications and
still-current request starts stay deferred until a later idle visibility check
rather than committing offscreen, losing eligible work, or restarting already
completed decode work.

Immediate first loads, source revision changes, explicit retries, and
not-eligible transitions remain node-owned. A direct-source image is immediate
when it is the first eligible resource; a later quality replacement starts from
the shared next-frame budget after interaction becomes idle. Scheduled request
starts are discarded when stale. A current culled start is retained without
scheduling an animation-frame loop until visibility changes.

## Local Image Preview Service And Cache

The Runtime image-preview route passes Project identity, project-relative path,
source revision, and requested width to `CanvasImagePreviewService`. The service
normalizes the path, rejects stale revisions and non-positive widths, verifies
the decoded image matches the supported path type, rejects multi-page sources,
and never enlarges beyond intrinsic width. It has no fixed maximum requested
width or intrinsic source dimension. Derived-target admission is based on
area: `target width * target height * 4` must not exceed a fixed 256 MiB RGBA8-
equivalent budget for one job. This format-independent estimate allows wider
panoramas than square images at the same memory boundary.

The Runtime-owned Raster Preview Engine uses bounded metadata, target-output
allocation, and working-set admission. Runtime owns its path, revision, cache,
cancellation, and resource contracts. Its still-raster implementation calls a
pinned, packaged libvips build in-process through a narrow Rust boundary;
libvips is an implementation detail of the existing Runtime rather than a
process, service, or alternate owner. JPEG, PNG, WebP, AVIF, TIFF, text-preview
rasters, extracted video frames, and Feedback Artifact raster work use this
backend. SVG/SVGZ remains owned by `resvg` and outside the detailed scope of
this backend design.

The required libvips runtime and license notices ship with supported macOS and
Windows packages. A Node App Server, Sharp wrapper, child process, pure-Rust
production fallback, operating-system-specific image backend, or compatibility
backend is not permitted. Once
the libvips path satisfies the contract, superseded custom JPEG decode, colour
conversion, resize, and encode product paths are deleted rather than retained
as alternatives.

Runtime reaches libvips through the exact `rs-vips` 0.7.0 Rust dependency and a
private Runtime adapter. The adapter owns initialization and exposes only
Debrute's Raster Preview Engine operations; `rs-vips` handles and types do not
cross that boundary. Debrute does not maintain a second hand-written FFI layer,
and the workspace keeps forbidding `unsafe` application code. Product packages
carry the exact libvips 8.18.4 runtime rather than binding to a machine-installed
copy. Binding and native-library upgrades are deliberate Raster Preview Engine
changes and must be verified together on macOS and Windows.

Debrute prepares one checksum-pinned native libvips payload for each supported
macOS and Windows target from the upstream archive named in
`assets/native-raster-payload-lock.json`. macOS uses the target-specific
NetVips.Native archive and Windows uses the libvips `build-win64-mxe` archive;
Debrute normalizes both into one Product layout. Source development and Product
assembly consume the same locked archive for their target and never discover
Homebrew or another system installation. URL, SHA-256 digest, target, libvips
version, payload revision, and Debrute's five-format adapter contract form one
repository-owned lock. A missing or mismatched payload stops the build or
development launch instead of selecting another image backend.

Runtime initializes the adapter once before publishing `Ready` and verifies
that the loaded library reports libvips 8.18.4. Missing libraries,
initialization failure, or a different reported version is a Runtime startup
failure, not a first-image node error. Product assembly inventories the native
files with the rest of the Product seed; macOS signs the libraries with the
Product binaries, and Windows places the required DLLs in the Runtime's fixed
library directory. Runtime never consults a general library search path.

The adapter performs exactly one `Vips::init("Debrute Runtime")` for the
process lifetime. It has no stop, reload, or reinitialize state. Product Quit,
product replacement, and ordinary Runtime exit do not call `Vips::shutdown()`
or wait for the Raster Preview Pool to drain; Runtime stops admitting work and
process termination releases the remaining native state. Lifecycle tests that
need a fresh native initialization use a fresh Runtime process rather than
cycling libvips inside one test process.

The private Runtime adapter exposes only the raster formats in Debrute's Canvas
contract: JPEG, PNG, WebP, AVIF, and TIFF. The upstream native archives may
contain transitive codecs used by those formats, but Runtime has no generic
loader entry point. It selects a format-specific loader only after the validated
extension and file signature agree. AVIF input must identify an AVIF container;
the shared HEIF codec does not make HEIC a supported Project image type. SVG and
SVGZ bypass libvips and use `resvg`. Animated or multi-page raster input is
rejected as a static Canvas preview source rather than silently taking its first
frame or page.

Runtime never calls generic ImageMagick, PDF, OpenSlide, camera-raw, GIF, PSD,
JPEG 2000, or other foreign loaders, never consults machine-installed codecs,
and never tries a second loader after a format mismatch. Known Runtime-produced
PNG or JPEG intermediates use the same explicit PNG or JPEG loaders. Format
mismatch and unsupported input remain typed per-node failures rather than
compatibility fallback.

SVG and SVGZ remain on the separate `resvg` path. Their parsing, external and
embedded resource, font, cache-identity, and detailed resource-limit contracts
are intentionally deferred to a dedicated design and are not expanded by this
Raster Preview Engine refactor.

Image, text, and video variant rendering share one global Raster Preview Pool
with capacity three. Feedback Artifact rendering may retain its own latest-only
or serialized scheduling, but it consumes the same global slot while performing
raster work. There are no per-media raster pools, dynamic weights, machine
memory probing, or user-configurable concurrency. Metadata reads and external
video-frame extraction keep their own admissions because they are not raster
rendering, and a direct-source image tier consumes no raster slot.

Pool capacity limits active Runtime raster jobs; it does not impose a second
per-image worker count on libvips or on codecs that manage their own workers.
libvips uses its supported-platform default internal worker policy. Its global
cross-operation cache is disabled because Debrute's revisioned disk cache and
equivalent in-flight request sharing own reuse across jobs. Per-job streaming
buffers, shrink-on-load, and SIMD remain enabled, and a completed job releases
its libvips image graph and source handles. There is no user setting, per-media
setting, or adaptive Runtime policy for libvips worker count or operation cache.

The target-area budget replaces the former fixed source-dimension and
pure-Rust full-decode working-set limits. libvips streams from the resolved
source to an atomic temporary output rather than materializing the encoded
result or complete uncompressed source in a Rust buffer. With three admitted
jobs, their combined target-area allowance is at most 768 MiB; Runtime does not
add a weighted global memory queue or inspect machine memory. Direct-source
tiers perform no derived-target admission. A derived TIFF tier can be
rejected when its requested target area exceeds the same budget.

Equivalent in-flight requests share one render result. Queued work with no
remaining consumer is removed before it acquires a Raster Preview Pool slot.
Once native rendering begins, a consumer may stop waiting but Runtime does not
set libvips's kill flag, impose a render timeout, or reschedule the work. Before
atomic publication, the job revalidates the source file identity, Source
Version, Raster Preview Engine Version, and target cache identity. A still-
current job publishes its variant even when its original consumers have left;
a stale job deletes its temporary output without publishing or retrying.
Product Quit relies on process exit rather than a separate job-cancellation
protocol.

Derived variants apply source orientation before deriving their final
proportional dimensions, use shrink-on-load and Lanczos3 without enlargement,
colour-manage valid source profiles, and produce 8-bit sRGB pixels. CMYK,
grayscale, higher-bit-depth, wide-gamut, and HDR inputs therefore converge on
one Canvas display colour space; HDR gain maps are not retained in derived
previews.

The presence of an alpha channel selects RGBA PNG without an all-pixels alpha
scan. Otherwise output is RGB JPEG at quality 82. Output strips source EXIF and
orientation tags, ICC, XMP, IPTC, GPS, embedded thumbnails, and other source
metadata after the pixels have been oriented and converted. Runtime does not
promise byte-identical encoder output across supported platforms, but it does
promise the same target dimensions, orientation, 8-bit sRGB interpretation,
alpha semantics, and PNG-versus-JPEG choice. The direct-source tier performs
none of these transformations and leaves original colour, HDR, and metadata to
the browser and source file.

Rendered bytes are atomically renamed into place. A variant-rendering
failure, including corrupt pixels, unusable colour configuration, or encode
failure, is explicit for that request and does not retry with ignored metadata
or retroactively make the source node unavailable. When a new quality tier
exceeds a real allocation or working-set boundary, the node retains its
already-loaded lower-resolution image and exposes the replacement failure;
Runtime does not silently substitute another width.

Ordinary libvips operation failures map to the same typed per-node render
failure and leave Runtime running. An unrecoverable native fault inside the
in-process library instead terminates Runtime as an unexpected process failure;
Rust panic handling cannot isolate it. Debrute does not add a raster child
process, Supervisor, or automatic Runtime restart for this case. Atomic
publication protects completed cache paths, and the next structural cache
reconciliation removes abandoned temporary outputs after a later explicit
Runtime start.

Every cached width variant produced by the shared engine uses one code-owned
`Raster Preview Engine Version`. Image, text, and video variants use the same
value. A change that can alter the engine's output pixels, encoding, or format
increments this version in the same change; a Debrute product version does not
increment it automatically. `Version` identifies a code contract, while
`revision` remains reserved for Project, file, and Operation state.

The shared engine does not create an equal-width variant. When a requested
width reaches a browser-displayable source's intrinsic width, its caller serves
that exact revision-bound source: a Project file for an image, the canonical
browser-captured PNG for text, or the selected poster/extracted frame for video.
This direct-source tier consumes no Raster Preview Pool slot and creates no
`preview-w<source-width>` file. It retains the caller's source-identity checks
and the same loaded/next visual handoff as lower-width variants. TIFF remains a
derived image format; SVG/SVGZ direct-source behaviour remains deferred to
their separate design.

Image-preview cache identity has four levels:

```text
.debrute/cache/canvas-image-previews/
  <filesystem-safe source-path key>/
    <filesystem-safe revision key>/
      raster-engine-v<version>/
        preview-w<width>.<jpg|png>
```

The source key combines a readable encoded path prefix with a stable hash so
long or similar paths remain distinct. The direct-source tier has no entry in
this cache. Derived-variant cache hits must be regular non-symlink files.
Project open and refresh reconcile the cache against current visible,
metadata-previewable image files: removed or unsupported sources and superseded
file revisions are deleted. Runtime reads and writes only the exact current
`raster-engine-v<version>` path; it does not enumerate sibling engine-version
directories or delete data attributed to an earlier engine contract. The
entire cache tree is excluded from Project visibility, so previews cannot
recursively become Canvas inputs.

Preview caches use structural reconciliation rather than a byte quota, LRU,
TTL, or background cleanup timer. Image caches retain requested quantized-width
variants only for the current visible source and file revision under the exact
current engine path.
Text caches retain the current source identity for each Canvas and Project path;
video caches retain the current video revision and the source identity implied
by its persisted Playback Position or initial poster. Source-identity changes
remove superseded text fingerprints and video frame identities. Current-
identity width variants remain reusable across zoom changes, displays, and
sessions. This policy does not add a user-facing cache setting or cleanup
command.

## Performance Diagnostics

Canvas performance instrumentation is available only to development Workbench
sessions and is inactive by default. Start the development process with either
`pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf` to enable it
for every Project page served by that process. Starting without the flag keeps
it off; production builds do not expose the probe. Unit tests instantiate
diagnostics directly instead of turning on the live global probe.
`CanvasPerfMonitor` records structured pan, minimap, move, and resize sessions;
frames; ownership-specific counters; final Canvas counts; and optional Long
Animation Frame entries. Summaries report observed work rather than making
machine-dependent timing promises.

`CanvasPerfBrowserAdapter` maps session boundaries to browser performance marks
and measures and observes non-buffered Long Animation Frames only when supported
and while a session needs them. Ended sessions are removed immediately, so a
later observer cannot replay historical frame entries into a new capture.
Browser performance API failures are isolated from Canvas interaction.
High-volume marks are opt-in.

An explicitly enabled development Canvas registers
`window.__debruteCanvasPerf`. A caller can start a clean capture, perform an
interaction, stop or export it, and receive a cloned JSON-safe trace, counter
totals, and current Canvas snapshot. `stopCapture()` ends only the current
capture and freezes its export; it does not turn off the process-level probe.
Without the startup flag, the global is not registered and the monitor, browser
observer, marks, counters, and per-frame diagnostic work remain off. The bridge
owns capture exposure only: it does not change rendering or resource behavior,
persist traces, upload telemetry, or register its global API in production
builds.

Default tests assert deterministic ownership and work boundaries rather than
FPS, CPU, heap, decode time, or absolute benchmark thresholds. Live browser
capture is a requested diagnostic workflow, not a normal documentation or CI
gate. The workflow uses the in-page capture API and an explicit user
interaction; Debrute does not retain a second CDP pan driver, hidden Electron
remote-debugging switch, fixed-settle script, or DOM/network scraper. Pan-away
and pan-back image retention is already a deterministic image-state contract
and test rather than a duplicate live-script assertion.

## Executable Authorities

- Camera, render coordination, scheduling, culling, resource zoom, image state,
  and diagnostics: `apps/web/src/workbench/canvas/`.
- Raster preview scale and width model:
  `packages/canvas-core/src/canvasRasterPreviews.ts`.
- Image projection, preview rendering, and cache cleanup:
  `apps/runtime/src/project/service.rs` and
  `apps/runtime/src/project/previews/`.
- Filesystem-safe preview cache identity:
  `apps/runtime/src/project/previews/cache.rs`.
- Runtime preview route: `apps/runtime/src/workbench/project_routes.rs`.
- Deterministic browser-free coverage: colocated Canvas tests and
  `apps/runtime/src/project/tests.rs`.
