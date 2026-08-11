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
orange outer outline. An inactive player retains a weak teal hover affordance,
while Content Activation adds no persistent border or ring; neither state is
encoded by dimming the controls. The control region is rectangular,
uses Debrute design tokens, and does not retain the native browser audio pill or
semicircular ends.

An available video projection carries its revisioned raw URL, MIME type, and
discovered WebVTT text tracks. Intrinsic dimensions and optional duration are
browser-decoded metadata, not Runtime Project metadata. Automatic Layout uses
the `3200 × 1800` fallback until the Workbench browser publishes metadata for
the exact Source Revision, then adopts the intrinsic aspect ratio. Manual Layout
never changes its user-owned rectangle.

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
including zero milliseconds. Its Preview Target Identity comprises the exact
Source Revision and frame time in milliseconds; there is no second producer
identity.

Workbench owns one Video Preview registry for the mounted Canvas. It tracks the
playback frame and every persisted Feedback Moment independently, including
multiple times for the same Project path. Runtime keeps the ordinary Canvas
Resource View disclosure-filtered. In parallel, its Project snapshot publishes
one lightweight `feedbackVideoResources` view containing only videos that have
persisted Feedback Moments. Runtime loads only those known paths' ancestor
directories; it does not traverse the Project or hash the video during snapshot
construction. Workbench folds these descriptors into the existing serialized
source-resolution and Video Preview lanes. A collapsed video therefore receives
only its Feedback Moment targets, never a hidden playback-at-zero target or a
visible Canvas Node.

Runtime's source-read operation accepts one ordered window of at most ten exact
targets and reports `available`, `missing`, or a target-local error for each. A
missing target enters the one serialized browser capture lane; tasks move through
source read, browser decode, capture, save, or failed. There is no automatic
retry. The node-local Retry action restarts the current playback target at source
read.

A hidden Feedback target failure has no Canvas node or Activity presentation and
does not retry automatically in the current registry. Reopening Workbench,
changing its Source Revision or Moment, or disclosing the video starts a new
attempt. Redisclosure performs that retry before any exact-time failure can be
adopted by the visible playback preview.

The capture lane creates a detached native `<video>` using the same revisioned
raw URL as the player. It waits for browser metadata and the exact seek, uses
`requestVideoFrameCallback` when available, draws one frame into a Canvas no
larger than 4096 pixels on its longest edge, and encodes PNG. One capture has a
30-second deadline. Debrute does not preflight with `canPlayType()` or infer
codec support from extension; the actual browser decode result is authoritative.
Active players keep their existing preview and defer new hidden capture work
for that path until playback no longer owns the media.

Runtime validates the exact Project lease before and after publication. It
accepts only a valid PNG of at most 64 MiB, with positive dimensions, a longest
edge of at most 4096 pixels, and an aspect ratio matching the browser metadata.
It atomically publishes each metadata and source file into the Runtime-owned cache.
The source PNG then uses the same Runtime raster-variant service and JPEG output
policy as the other preview media:

Feedback artifact rendering reads the exact cached browser frame for each
persisted Feedback Moment. A missing frame is pending derived work retained by
the Feedback artifact scheduler, not a Project diagnostic. Saving that exact
frame resumes only the matching retained artifact; this cache event does not
invent or advance a Project revision. If no Workbench is open, Runtime does not
invent a decoder or start a browser: the artifact remains pending until a later
Workbench observes the Feedback entry and supplies the capture.

```text
~/.debrute/cache/roots/<rootKey>/canvas/canvas-video-previews/
  <path-key>/<source-revision>/browser-v1/
    metadata.json
    frames/<frame-time-ms>/
      source.png
      raster-engine-v<version>/
        preview-w<width>.jpg
```

When the requested width reaches the source's intrinsic width, Runtime returns
`source.png` directly rather than decoding and encoding an equal-width JPEG.
This creates no equal-width variant and consumes no Raster Preview Pool slot.
Cache paths are derived state and are excluded from Project-visible content.
Superseded Source Revisions and frame times do not participate in current
lookup. Runtime reads and writes only the exact current Raster Engine path; it
neither enumerates nor removes sibling engine-version directories. It retains
requested width variants without a byte quota, LRU, TTL, or compatibility
cleanup path.

## Player Metadata And Raw Media

Video dimensions, optional duration, playback, and canonical still pixels all
come from the Workbench browser engine. A missing finite duration does not make
a video unavailable when the browser decodes positive dimensions. Same-directory, same-basename
`.vtt` companions are projected as subtitles, captions, chapters, or thumbnail
metadata. A single subtitle or caption track is the default; multiple language
tracks are not auto-selected.

Runtime recognizes these filename candidates and supplies their conventional
video MIME types: `mp4`, `m4v`, `f4v`, `mov`, `qt`, `webm`, `mkv`, `ogv`, `avi`,
`mpg`, `mpeg`, `mpe`, `m1v`, `m2v`, `vob`, `mts`, `m2ts`, `flv`, `wmv`, `asf`,
`3gp`, and `3g2`. This list controls Canvas classification only. It does not
promise that every codec inside those containers is decodable on every browser,
operating system, or machine.

Runtime's revisioned raw-file endpoint serves video, audio, and WebVTT MIME
types and supports single byte ranges. A complete response returns `200`; a
valid range returns `206` with range headers; an unsatisfiable range returns
`416`. A stale revision returns its typed error and retains the requested
revisioned URL.

## Error Ownership

Missing or unreadable source media is node availability. Source read and save,
browser decode, browser capture, and variant presentation remain distinct Video
preview failure stages.
Browser loading, play, and initial-seek failures are player errors. A terminal
content, load, decode, or playback failure preserves Node Selection, ends
Content Activation, marks the medium as not playing, and replaces the Content
Region with an inactive error surface saying it may be clicked to retry.
Buffering and temporary stalls do not enter this state. The title bar and Node
Manipulation Region show no error or retry control, and there is no separate
Retry button. Preview Retry restarts that node at source read. Player Retry discards
the failed media element and constructs a fresh player; successful video retry
applies its click's one playback action, while audio retry restores controls
without autoplay. Source selection has no alternate path.

Node-availability and media-load error titles and messages use the same
Canvas-scaled semantic presentation as other Canvas text. They remain attached
to node geometry and grow or shrink with the Canvas; they are not screen-fixed
badges. Available image and video pixels remain in their native media
presentation and are not multiplied by that text scale.

## Executable Authorities

- Media classification, MIME types, exact Project leases, captured-source
  validation, cache paths, raster variants, and Feedback artifact pixels:
  `apps/runtime/src/project/media.rs` and `apps/runtime/src/project/previews/`.
- Playback and feedback declarations and browser presentation values:
  `packages/canvas-core/src/`.
- Raw revisioned media and range responses:
  `apps/runtime/src/workbench/project_routes.rs`.
- Browser video metadata and capture, player, hotkeys, Video Preview runtime,
  shared raster presentation,
  audio presentation, and media feedback overlays:
  `apps/web/src/workbench/canvas/`.
- Browser-free coverage: colocated Canvas tests and
  `apps/runtime/src/project/tests.rs`.
