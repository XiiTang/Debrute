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
the live camera and `CanvasStageRuntime` writes the stage transform directly.
Each mounted `CanvasSurface` has one `CanvasRenderLifecycle` bound to its
`CanvasEditorRuntime`. The lifecycle owns the current accepted Canvas
Projection, its `CanvasRenderCoordinator`, the stable full-scene render
snapshot, culling synchronization, preview-order publication, render-related
Runtime subscriptions, and at most one pending animation-frame cull. React
reads the scene snapshot through
an external-store subscription; it does not coordinate the underlying input
lifetimes.

`CanvasRenderCoordinator` composes every current Projected Canvas node and
every routed edge into that scene. Manual Layout Draft geometry and stack order
replace their projected values, and connected edges are rerouted from the same
draft geometry. Camera, surface size, selection, and viewport position never
change React scene membership. Projection and Manual Layout changes publish a
new scene; ordinary camera movement retains the exact same scene snapshot.

Moving camera events update the stage transform immediately and coalesce one
exact-viewport query onto the next animation frame. `CanvasCullingController`
keeps culling cost bounded by current scene complexity rather than the canvas
area covered by a low-zoom viewport. Repeating synchronization with the same
scene, camera, and surface does not repeat geometric work, while
`CanvasStageRuntime` writes only changed node-shell and edge-layer `display`
values. Selected and active move/resize nodes remain display-visible when they
are outside the viewport, but retention-only changes do not repeat geometric
work or alter preview scheduling identity. These direct DOM
writes do not publish a React scene snapshot and do not remove node-local preview
state. This culling state is a rendering decision, not Canvas Document visibility.

When camera movement becomes idle, the lifecycle ensures that the final camera
has been synchronized and publishes its viewport rectangle for preview-resource
ordering without repeating already completed culling work. Producers order all
current work by squared distance from the viewport center to the nearest point
of each node rectangle, with Project path as the exact tie-breaker. The viewport
never admits, cancels, or delays required preview production. Projection,
surface-size, and Manual Layout changes publish the corresponding current scene
and preview order immediately. Detaching the last scene subscriber removes the
Runtime subscriptions and cancels pending work, so a callback from an older
mounted lifetime cannot publish later.

There is no Canvas mount virtualization, retained virtual rectangle, overscan,
or node-type retention exception. All current node shells and edge layers remain
mounted until their Canvas membership ends. The exact viewport controls direct
DOM culling; its center controls preview distance ordering without creating an
inside/outside tier.

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
settles. A pure pan leaves the resource-zoom state untouched at both the moving
and idle transitions, so it does not render `CanvasSurface`. This keeps camera
transforms independent from preview-resolution churn. The short camera-idle
threshold answers only whether interaction is still in progress; it does not
authorize an immediate quality replacement.

## Shared Raster Preview Presentation

Image, text, and video use one mounted Workbench presentation module. Each
media adapter supplies only a Raster Preview Request:

- a Preview Continuity Key for the complete pixels that may remain visible;
- the owner-scoped Preview Target Identity and optional Canonical Preview
  Source Identity;
- the canonical source width; and
- a pure URL factory for an exact requested width.

The shared module alone combines node display width, settled resource zoom,
device pixel ratio, and canonical source width into the stepped requested
width. It derives the Preview Variant Identity, submits current starts to the
shared scheduler, owns visible, pending, failure, and retry state, and
coalesces repeated zoom changes by media kind and Project path.

A pending variant is a real mounted `<img>`, not an off-DOM `Image` object or a
preliminary fetch. Its `load` event, or cached `complete` state with positive
intrinsic width, begins `decode()`. The decoded element is promoted only when
its continuity key, variant key, retry attempt, and DOM membership are still
current. The same keyed DOM element becomes visible; it is not loaded again.
When a visible variant already exists, it remains mounted until the scheduler
publishes the decoded replacement. An initial decoded variant may publish
immediately because there is no visible content to preserve.

A continuity change synchronously excludes every older layer from rendering.
Width-only changes preserve the current visible layer. Load or decode failure
keeps a valid visible layer, records one typed local failure, and waits for an
explicit node retry. There is no automatic retry, fixed settle timeout,
double-animation-frame promotion delay, or media-specific presentation
reducer. Text may request a layout-effect DOM-commit acknowledgement for its
editor handoff; that acknowledgement does not claim that a browser paint
occurred and schedules no animation frame.

Canonical source production remains media-specific. Images use revision-bound
Project bytes, Text retains its latest-wins content and serialized CodeMirror
capture lane, and Video retains Probe and Ensure frame-source discovery.
Those producers expose current source readiness and typed source errors to the
shared presentation request instead of owning width or DOM handoff state.

## Shared Preview Scheduling

The scheduler has two coalesced phases: resource start and decoded-result
publication. Both are keyed by media kind and node identity, newest work wins,
and current identity is rechecked immediately before execution. Starts pause
while camera movement or node dragging is active. Once idle, eligible work is
ordered by squared distance from viewport center, publications win only an
equal-distance tie, and at most three operations enter one animation frame.
The scheduler limits admission time; it does not own canonical producer work,
DOM elements, decode promises, failures, or visible presentation state.

Initial requests and quality replacements use the same start phase. A decoded
replacement uses the publication phase; an initial result does not consume a
publication slot because no older visible layer exists. Resource zoom remains
fixed during camera motion, so intermediate width requests coalesce without a
post-idle timer. Culling changes shell display only and never changes preview
membership or canonical-source work.

Text and video producer registries observe interaction imperatively and rerun
only while producer work remains. Their Runtime contexts expose stable command
surfaces and path-local snapshots containing the shared presentation request
and source error. A source change for one path therefore rerenders only that
node shell.

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
libvips is a Runtime implementation detail rather than a process, service, or
alternate owner. JPEG, PNG, WebP, AVIF, TIFF, text-preview
rasters, extracted video frames, and Feedback Artifact raster work use this
backend. SVG/SVGZ remains owned by `resvg` and outside the detailed scope of
this backend design.

The required libvips runtime and license notices ship with supported macOS and
Windows packages. Raster preview has one production backend: in-process libvips
through the private Runtime adapter.

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

The Windows link payload carries the exact libvips, GLib, and GObject import
libraries required by the pinned `rs-vips` binding. That link-library closure is
part of the payload identity; an incomplete declaration is rejected before
Cargo builds Runtime.

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
mismatch and unsupported input are typed per-node failures.

SVG and SVGZ remain on the separate `resvg` path. Their parsing, external and
embedded resource, font, cache-identity, and detailed resource-limit contracts
belong to a dedicated design outside the Raster Preview Engine contract.

Image, text, and video width variants are resolved by one Runtime raster-variant
service and share one global Raster Preview Pool with capacity three. The
service owns width validation, per-cache-key exclusion, evaluation of the
caller-selected output policy, equal-width direct-source return, Raster Preview
Engine path identity, atomic publication, and response-file creation. Media-
specific callers own source production, source-current validation, and their
output policy. Feedback Artifact rendering may retain its own latest-only
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

The target-area budget is the raster admission limit. libvips streams from the
resolved source to an atomic temporary output rather than materializing the
encoded result or complete uncompressed source in a Rust buffer. With three admitted
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

Every cached width variant produced by the shared variant service uses one code-owned
`Raster Preview Engine Version`. Image, text, and video variants use the same
value. A change that can alter the engine's output pixels, encoding, or format
increments this version in the same change; a Debrute product version does not
increment it automatically. `Version` identifies a code contract, while
`revision` remains reserved for Project, file, and Operation state.

The shared variant service does not create an equal-width variant. When a requested
width reaches a browser-displayable source's intrinsic width, its caller serves
that exact revision-bound source: a Project file for an image, the canonical
browser-captured PNG for text, or the canonical extracted frame for video.
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

The source-path cache key combines a readable encoded path prefix with a stable hash so
long or similar paths remain distinct. The direct-source tier has no entry in
this cache. Derived-variant cache hits must be regular non-symlink files.
Project open and refresh reconcile the cache against current visible,
metadata-previewable image files: unavailable sources and superseded file
revisions are deleted. Runtime reads and writes only the exact current
`raster-engine-v<version>` path and does not enumerate or delete sibling
engine-version directories. The
entire cache tree is excluded from Project visibility, so previews cannot
recursively become Canvas inputs.

Preview caches use structural reconciliation rather than a byte quota, LRU,
TTL, or background cleanup timer. Image caches retain requested quantized-width
variants only for the current visible source and file revision under the exact
current engine path.
Text caches resolve only the exact requested source identity for each Canvas and
Project path; superseded target-identity directories do not participate in current
lookup. Video caches retain the current source revision and the source identity
implied by its persisted Playback Position; superseded frame identities do not
participate in current lookup. Current-identity width variants remain reusable
across zoom changes, displays, and sessions. This policy does not add a
user-facing cache setting or cleanup command.

The loopback image-preview response is also revision-addressed by Project path,
source revision, and quantized width. After Runtime validates that identity, it
returns `Cache-Control: private, max-age=31536000, immutable`, allowing the
local browser profile to reuse that exact byte response without another
loopback request. A changed file produces a different revision URL, and a
request with a stale revision still fails at Runtime. This browser cache is not
a second Project authority and does not replace the structurally reconciled
Runtime disk cache. Text and video preview responses remain `no-cache` because
their current source identities have different publication lifecycles.

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
When diagnostics are enabled, one React Profiler boundary surrounds the Canvas
surface subtree so the `react-commit` counter includes nested preview-provider
and node commits rather than only `CanvasSurface` renders.

`CanvasPerfBrowserAdapter` maps session boundaries to browser performance marks
and measures and observes non-buffered Long Animation Frames only when supported
and while a session needs them. Ended sessions are removed immediately, so a
later observer cannot replay their frame entries into another capture.
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
