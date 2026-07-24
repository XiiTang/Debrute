# Canvas Media Presentation

This page records the current image, audio, and video presentation contracts on
Canvas. Canvas document membership and layout are documented in
[`canvas.md`](./canvas.md); shared raster scheduling and image resources are
documented in [`canvas-rendering.md`](./canvas-rendering.md); feedback over media
is documented in [`canvas-feedback.md`](./canvas-feedback.md).

## Media Classification And Projection

Canvas classifies visible Project files as image, video, audio, text, or
unknown from their current Project path. Available nodes carry a revisioned raw
file URL and MIME type. Images and videos require intrinsic dimensions for
automatic layout; audio uses a fixed Canvas size.

Image nodes use the derived raster-preview lifecycle in
[`canvas-rendering.md`](./canvas-rendering.md). Audio nodes use a native audio
element with controls, no preloading, a fixed presentation size, a file caption,
and an explicit retry surface for media-load errors. Audio playback state is not
stored in the Canvas Document.

An available video projection must include intrinsic width and height, optional
duration, and discovered WebVTT text tracks. Poster data is deliberately absent
from the projection: static video images belong to the video-preview pipeline,
not the player metadata contract.

## Video Playback Position

Playback Position is persisted Canvas state because it controls the still frame
shown after a player is unloaded or Workbench is reopened. The Canvas Document
stores only a non-negative timestamp on video file nodes. Positive timestamps
are normalized to millisecond precision; zero removes the stored playback
field.

Workbench writes Playback Position at playback boundaries such as pause, ended
playback, player unload, Canvas switch, and Project close. It does not persist
continuous `timeupdate` events. Volume, mute, playback rate, captions,
fullscreen, picture-in-picture, loading state, errors, player mounting, and
one-shot play requests remain transient browser or Workbench state.

## Inactive Preview And Active Player

An inactive available video settles to one derived preview image and no player.
A selected, explicitly requested, or playing video settles to one real player.
A shortcut aimed at a selected inactive video first requests that player's
mount. A playing video remains mounted if selection changes; a paused inactive
video returns to its preview.

Clicking an inactive preview selects the node, mounts the player, and issues one
play request. Inside the mounted player, media-chrome owns pointer gestures and
controls while Debrute keeps keyboard ownership at the selected-Canvas-node
boundary. The centralized shortcuts cover play/pause, small or large seek,
mute, captions, playback-rate adjustment, fullscreen, and picture-in-picture.
Focused text inputs and media controls keep their native keyboard behavior.

The preview-to-player handoff keeps the current preview visible until the
player has displayable data and any persisted initial seek has completed. The
player-to-preview handoff keeps the player visible until the target image has
loaded, decoded, and crossed the paint handoff gate. Both layers may coexist
briefly while switching, but only one is visible and successful settled states
retain only the target layer. Source path, raw URL, revision, or availability
changes reset node-local handoff state so stale media cannot satisfy readiness.

## Video Preview Sources

Video previews have two source kinds:

- `initial-poster` when Playback Position is zero;
- `playback-frame` for the exact positive Playback Position.

For an initial poster, Runtime checks one ordered same-directory,
same-basename chain: `name.poster.*`, then `name.*`, then automatic extraction
at zero seconds when no candidate exists. A selected explicit candidate is
copied into the preview cache before variants are produced. If an existing
candidate is broken or is not a regular file, that source is an error; the
service does not continue down the chain.

A positive Playback Position always targets an extracted playback frame. An
out-of-duration timestamp, extraction failure, stale revision, missing source
key, variant failure, or image load failure is surfaced as a preview error. It
does not fall back to the initial poster, a Generated Asset last frame, another
timestamp, or the raw video.

Source readiness is returned as a Project-path-keyed record with exactly one
entry per requested video target; it is not an ordered array. A missing or
identity-mismatched entry is a preview protocol error rather than an empty
preview. The first current, visible preview may publish immediately. Later
width changes share the image/video preview start scheduler, which pauses
deferred starts during interaction, rejects stale work, and retains current
culled work until visibility changes. Active and culled videos are not new
preview targets.

Cache identity includes Canvas ID, Project path key, video revision, source
kind, and source key. The source key includes the `Canvas Video Preview Source
Version` together with the selected poster or frame-extraction inputs. The
source directory contains one cached source; width-specific JPEG variants add
the same `Raster Preview Engine Version` used by image and text variants:

```text
.debrute/cache/canvas-video-previews/
  <canvas>/<path-key>/<revision>/<source-kind>/<source-key>/
    source.<ext>
    raster-engine-v<version>/
      preview-w<width>.jpg
```

When the requested width reaches the selected source's intrinsic width,
Runtime returns `source.<ext>` directly rather than decoding it and encoding an
equal-width JPEG. This applies to both explicit/automatic initial posters and
positive Playback Position frames, creates no equal-width variant, and consumes
no Raster Preview Pool slot.

The requested width uses the same raster-preview width model as Canvas images.
Cache paths are derived state and are excluded from Project-visible content.
Runtime removes superseded video revisions and source identities that no longer
match the persisted Playback Position or selected initial poster. Under the
current source identity it reads and writes only the exact current Raster Engine
path; it neither enumerates nor removes sibling engine-version directories. It
retains requested width variants without a byte quota, LRU, or TTL.

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
`416`. These are closed route outcomes rather than numeric statuses repaired by
a fallback. Stale revisions remain errors rather than being replaced with a
newly invented URL.

## Error Ownership

Missing or unreadable source media is node availability. Preview discovery,
frame extraction, variant, and preview-image failures are preview errors.
Browser loading, play, and initial-seek failures are player errors. During a
handoff, failure leaves the current visible layer intact and places the target
layer's error above it. Retry reloads only the current player source; there is no
alternate-source or compatibility path.

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
- Player, hotkeys, preview runtime, node-local handoff, audio presentation, and
  media feedback overlays: `apps/web/src/workbench/canvas/`.
- Browser-free coverage: colocated Canvas tests and
  `apps/runtime/src/project/tests.rs`.
