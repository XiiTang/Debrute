# Canvas Media Presentation

This page records the current image, audio, and video presentation contracts on
Canvas. Project Tree projection and Canvas layout are documented in
[`canvas.md`](./canvas.md); shared raster scheduling and image resources are
documented in [`canvas-rendering.md`](./canvas-rendering.md); feedback over media
is documented in [`canvas-feedback.md`](./canvas-feedback.md).

## Media Classification And Projection

Canvas classifies visible Project files as image, video, audio, text, or
unknown from their current Project path. Available nodes carry a revisioned raw
file URL and MIME type. Available images and videos use intrinsic dimensions for
automatic layout; audio uses a fixed `3200 × 680` scene-unit Canvas size, and an unavailable video uses
a fixed `3200 × 1800` scene-unit fallback so its Content Region remains usable.

Every available file node derives its media revision by streaming the exact
current file bytes through SHA-256. Size and modification time remain projection
metadata, not media identity. Raw-file and preview services rehash the opened
source and reject a request when its expected content revision is stale;
directory nodes retain their separate metadata revision because they have no
file bytes.

Image nodes use the derived raster-preview lifecycle in
[`canvas-rendering.md`](./canvas-rendering.md). Audio nodes use a project-styled
Media Chrome control composition over a native audio playback element, with no
native browser controls or browser-owned pill presentation. Their upper title
bar is the Node Manipulation Region and their lower player is the Content
Region. The Automatic Layout presentation is exactly the 32-pixel title row and
36-pixel control row without a video surface or empty media area. Manual Layout
continues to preserve its complete user-owned rectangle. The Media Chrome
controller exposes the Workbench-localized Audio Player region name after its
custom element connects. The native playback element uses no preloading, and
Audio playback state is not stored in Canvas state.
Audio uses the same mounted Media Chrome composition while content-inactive and
content-active. Ending Content Activation neither pauses nor unloads it; the
active state changes interaction ownership and Content Region presentation, not
the playback engine's residency.

Content-inactive audio controls remain readable and continue to show live
playback progress rather than appearing disabled. Selection is the node's
orange outer outline and Content Activation is the player's teal inner ring;
neither is encoded by dimming the controls. The control region is rectangular,
uses Debrute design tokens, and does not retain the native browser audio pill or
semicircular ends.

An available video projection must include intrinsic width and height, optional
duration, and discovered WebVTT text tracks. Static preview data is deliberately
absent from the projection because it belongs to the video-preview pipeline,
not the player metadata contract.

## Video Playback Position

Playback Position is persisted Canvas state because it controls the still frame
shown after a player is unloaded or Workbench is reopened. Canvas state
stores only a non-negative safe-integer millisecond timestamp on video file nodes;
zero removes the stored playback field. Browser media time is converted to and
from seconds only at the player adapter boundary.

Workbench writes Playback Position at playback boundaries such as pause, ended
playback, player unload, Canvas switch, and Project close. It does not persist
continuous `timeupdate` events. Volume, mute, playback rate, captions,
fullscreen, picture-in-picture, loading state, errors, player mounting, and
one-shot playback-toggle requests remain transient browser or Workbench state.

## Inactive Preview And Active Player

A content-inactive, non-playing available video settles to one derived preview
image and no player.
A content-active or playing video settles to one real player. A playing video
remains mounted if Canvas Node Selection changes; a paused content-inactive
video returns to its preview.

Content Activation identifies at most one video, while any number of videos may
be playing. Starting another video does not pause or unload existing playback.
Only the conjunction of content-inactive and not playing makes a video player
eligible for preview handoff and unload; an offscreen playing video likewise
remains mounted.

A completed unmodified primary click on an inactive preview atomically
sole-selects and activates the node, mounts the player, and issues exactly one
playback toggle from that click. Pointer-down alone, release outside the target,
or cancellation does none of those. Inside the mounted player, Media Chrome
owns its pointer controls and local shortcuts. Canvas only enables those local
shortcuts for the content-active controller and does not retain a window-level
video hotkey controller, target registry, delayed key replay, or keyboard
shortcut dialog. Audio uses the same local shortcut ownership with unsupported
video-only commands omitted. Focused CodeMirror, Media Chrome, and native
controls retain their library behavior without a second Canvas keyboard model.
When a live video player remains mounted while content-inactive, its buttons and
ranges use the same trusted-event activation handoff as audio controls. Clicking
the video media surface or its non-control background activates and toggles
playback once; clicking empty audio-player background activates without
autoplay.

The preview-to-player handoff keeps the current preview visible until the
player has displayable data and any persisted initial seek has completed. The
player-to-preview handoff keeps the player visible until the target image has
loaded, decoded, and been published by the shared raster presentation module.
Both layers may coexist while switching, but only one is visible. The decoded
preview DOM remains mounted and is hidden while the player is visible, so a
later switch can reuse it without another load. Source path, raw URL, revision,
or availability changes replace the Preview Continuity Key, making every stale
layer ineligible immediately.

The player remains mounted until the preview has actually committed. If the
video is reactivated first, reactivation invalidates only the pending retirement
and reuses that same player. A late preview may remain cached but cannot replace
reactivated content. Viewport culling never stops playback. Leaving the Canvas
projection through ancestor collapse, deletion, Project change, or Canvas close
does stop and unmount media; there is no player registry outside projected
nodes.

## Video Preview Sources

Every video preview is the frame at the exact persisted Playback Position,
including zero milliseconds. Runtime owns the opaque Canonical Preview Source
Identity that binds the Canvas Video Preview Source Version to the target frame.
Workbench stores, compares, and returns that identity without parsing or deriving
it.

Workbench owns one latest-wins Video Preview registry for the mounted Canvas.
The registry is keyed by Project path, while the Preview Target
Identity comprises the Source Revision and frame time in milliseconds. Runtime's
opaque Canonical Preview Source Identity completes producer policy. Active
players retain any current preview target and mounted DOM for continuity, while
new Probe or Ensure work is admitted only for inactive players. Each task moves through `needs-probe`, `probing`,
`needs-source`, `ensuring`, or `failed`; Runtime-confirmed canonical readiness
removes the task instead of introducing a completed state.

Runtime exposes two source operations. Probe accepts one rolling window of at
most ten targets and returns exactly one Project-path-keyed result per target: ready,
needs-source, or failed. Probe does not extract a frame. Ensure accepts one
target and its exact Probe-owned Canonical Preview Source Identity, and returns
ready, source-changed, or failed. One registry has at most one Probe window and
one Ensure request in flight. A source-changed result returns the target to
Probe. There is no automatic retry; the node-local Retry action restarts the current target at
Probe.

One invalid target does not cancel a Probe window; its stale result is rejected
while the remaining results settle independently. An obsolete Ensure is
actively cancelled when its own target becomes ineligible or changes identity.
Camera movement and priority changes do not cancel in-flight work. Whole
Project, provider, or connection invalidation cancels its scoped
requests.

Cache identity includes Project path key, Source Revision, and
Canonical Preview Source Identity. The source directory contains one extracted
JPEG; width-specific JPEG variants add the same Raster Preview Engine Version
used by image and text:

```text
~/.debrute/cache/roots/<rootKey>/canvas/canvas-video-previews/
  <path-key>/<source-revision>/<canonical-source-identity>/
    source.jpg
    raster-engine-v<version>/
      preview-w<width>.jpg
```

When the requested width reaches the source's intrinsic width, Runtime returns
`source.jpg` directly rather than decoding and encoding an equal-width JPEG.
This creates no equal-width variant and consumes no Raster Preview Pool slot.

The requested width uses the same raster-preview width model as Canvas images.
After Ensure produces `source.jpg`, video uses the same Runtime raster-variant
service as image and text. Video contributes its JPEG output policy and
source-current validator; it does not own separate width validation, locking,
resize, cache-publication, or response-file logic.
Cache paths are derived state and are excluded from Project-visible content.
Superseded source revisions and source identities do not participate in current
lookup. Under the current source identity Runtime reads and writes only the
exact current Raster Engine path; it neither enumerates nor removes sibling
engine-version directories. It retains requested width variants without a byte
quota, LRU, TTL, or compatibility cleanup path.

## Player Metadata And Raw Media

Video dimensions and duration come from the configured media integration
runtime. A missing duration does not make a video unavailable when dimensions
are readable; missing required dimensions do. Same-directory, same-basename
`.vtt` companions are projected as subtitles, captions, chapters, or thumbnail
metadata. A single subtitle or caption track is the default; multiple language
tracks are not auto-selected.

Runtime's revisioned raw-file endpoint serves video, audio, and WebVTT MIME
types and supports single byte ranges. A complete response returns `200`; a
valid range returns `206` with range headers; an unsatisfiable range returns
`416`. A stale revision returns its typed error and retains the requested
revisioned URL.

## Error Ownership

Missing or unreadable source media is node availability. Probe and Ensure are
Video producer errors; variant load and decode failures are shared raster
presentation errors.
Browser loading, play, and initial-seek failures are player errors. A terminal
content, load, decode, or playback failure preserves Node Selection, ends
Content Activation, marks the medium as not playing, and replaces the Content
Region with an inactive error surface saying it may be clicked to retry.
Buffering and temporary stalls do not enter this state. The title bar and Node
Manipulation Region show no error or retry control, and there is no separate
Retry button. Preview Retry restarts that node at Probe. Player Retry discards
the failed media element and constructs a fresh player; successful video retry
applies its click's one playback action, while audio retry restores controls
without autoplay. Source selection has no alternate path.

Node-availability and media-load error titles and messages use the same
Canvas-scaled semantic presentation as other Canvas text. They remain attached
to node geometry and grow or shrink with the Canvas; they are not screen-fixed
badges. Available image and video pixels remain in their native media
presentation and are not multiplied by that text scale.

## Executable Authorities

- Media classification, projection, MIME types, dimensions, video presentation,
  preview sources, cache paths, and frame extraction:
  `apps/runtime/src/project/media.rs` and `apps/runtime/src/project/previews/`.
- Playback and feedback declarations and browser presentation values:
  `packages/canvas-core/src/`.
- Raw revisioned media and range responses:
  `apps/runtime/src/workbench/project_routes.rs`.
- Player, hotkeys, Video canonical-source runtime, shared raster presentation,
  audio presentation, and media feedback overlays:
  `apps/web/src/workbench/canvas/`.
- Browser-free coverage: colocated Canvas tests and
  `apps/runtime/src/project/tests.rs`.
