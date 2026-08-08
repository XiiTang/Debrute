# Canvas generic-node geometry and content interaction implementation record

Status: implementation complete and verified on 2026-08-07.

Durable product contracts live in ADR 0010, ADR 0011, `docs/canvas.md`, and
`docs/canvas-media.md`. This file is the single version-controlled implementation
record for how those contracts were realized in the current codebase. It is an
implementation map, not a second product specification.

## Outcome

The Canvas change delivers four results:

1. Automatic generic nodes use one continuous intrinsic-width rule with fixed
   minimum and maximum bounds, independent of camera zoom.
2. Canvas Node Selection, Canvas Content Activation, and node manipulation use
   distinct state and pointer contracts.
3. Text, video, and audio expose an upper Node Manipulation Region and a lower
   Content Region, with direct first-click behavior and consistent error
   handling.
4. Obsolete Feedback Frame, dynamic interaction zones, native audio controls,
   and Canvas-owned video shortcuts are removed rather than retained beside the
   new architecture.

There is no tldraw Store migration, feature flag, compatibility mode, Canvas
state schema change, or automatic migration of Manual Layout rectangles.

## Former Debrute, tldraw, and implemented Debrute comparison

The first column records the pre-change implementation that motivated this
work. The last column is the current Debrute contract.

| Dimension | Former Debrute | tldraw reference | Implemented Debrute |
| --- | --- | --- | --- |
| Authoritative identity | Project-relative path plus Project Tree | Store-owned Shape ID and records | Keep Project-relative path and Project Tree |
| Geometry | Workbench projection, but generic width mixes Canvas2D estimates with CSS box behavior | `ShapeUtil.getGeometry`; box shapes store explicit width/height | Workbench projection with one DOM-matched generic geometry module |
| Editing/activation | Separate mutable content path and state-dependent DOM zones | Separate selected shape IDs and `editingShapeId`; edit transition selects the shape | Separate Selection and Content Activation with one invariant and atomic commit |
| Pointer state | CanvasSurface plus Runtime, with component-local exceptions | Editor state machine and shape utilities | Keep Debrute Runtime; add one pure pointer policy and stable regions |
| Content rendering | React node content with preview/editor/player handoffs | Shape utility component distinct from geometry | Keep Debrute content components and lifecycle handoffs |
| Screen-space chrome | Inverse-zoom border partly participates in layout | Indicators/overlays use geometry plus inverse zoom; overlay manager owns overlay hit testing | Non-layout CSS paint and existing Canvas overlays; no new overlay registry |
| Media | Native Audio, Media Chrome Video, Canvas-owned video hotkeys | No Debrute Project media lifecycle equivalent | Media Chrome for Audio/Video; library-local shortcuts; Debrute lifecycle retained |
| Persistence | Sparse Canvas State tied to Project paths | tldraw Store/document records | Unchanged sparse Canvas State; no shape-store duplication |
| Migration cost/risk | N/A | Full adoption would replace identity, state, tools, history, and rendering ownership | Borrow only geometry/content/chrome separation |

The useful tldraw ideas are the separation between shape geometry and rendered
content, distinct editing versus selection state, and screen-space overlays.
Its Store, Shape IDs, complete tool state machine, ShapeUtil registry, and
OverlayManager would duplicate Debrute authorities and are explicitly rejected.

## Verified former causes and removed paths

The implementation audit found and removed these exact former paths:

- `CanvasScene.ts` measures only label glyphs through Canvas2D, adds the magic
  `54`, clamps to `120..360`, and caches by label under a hard-coded
  `LABEL_FONT`.
- `canvas.css` paints the non-image default frame with a zoom-compensated CSS
  border. The border participates in the content box, so low zoom reduces the
  inner width while scene geometry remains unchanged. This produces the
  inconsistent ellipsis that looks like width tiers.
- `CanvasDomInteractionAdapter.ts` publishes state-dependent `activate`,
  `passive`, `move`, and `interaction-island` zones.
- `CanvasSurface.tsx` sets Selection and Content Interaction separately and
  captures inactive content until pointer-up.
- `CanvasEditorRuntime.ts` exposes independent `setSelection` and
  `setContentInteraction` writes; `beginNodeMove` changes Selection on
  pointer-down.
- Audio is a native `<audio controls>` element, is inert while inactive, and
  renders its caption below the player.
- Video always disables Media Chrome hotkeys and reimplements them through
  `CanvasVideoHotkeyController.ts` plus a window listener and target registry.
- `CanvasFeedbackFrame.tsx` still renders a node-wide feedback border and
  suppresses ordinary hover/selection outlines.
- Content errors still have separate Retry buttons in several content paths.

## Implemented single-owner architecture

| Concern | Sole owner | Explicitly not an owner |
| --- | --- | --- |
| Generic intrinsic width, bounds, and rounding | `CanvasGenericNodeGeometry` | `CanvasScene`, mounted nodes, CSS, Canvas2D |
| Shared scene/presentation scale | `CanvasNodePresentationGeometry` | `CanvasScene`, CSS literals |
| Automatic hierarchy placement | `CanvasScene` | DOM components, Runtime |
| Manual rectangles | persisted Canvas State | automatic bounds, geometry measurer |
| Stable DOM hit regions | `CanvasDomInteractionAdapter` | component activation state |
| Pointer decision table | pure `CanvasInteractionPolicy` | node components, Workbench panels |
| Atomic Selection and Activation commit | `CanvasEditorRuntime` | `CanvasSurface`, focus events |
| Browser gesture tracking and one-time handoff | `CanvasSurface` | Runtime state model, node-local ad hoc routers |
| Text caret behavior | CodeMirror adapter | Canvas synthetic click replay |
| Audio/video controls and local shortcuts | Media Chrome | Canvas global media hotkeys |
| Video residency | `CanvasVideoNodeContent` lifecycle | Selection, viewport culling, global player registry |
| Content errors | affected Content Region | title bar, Node Manipulation Region, Feedback Frame |
| Selection/Activation/hover paint | screen-space CSS chrome | layout border, Feedback state |

## Work package 1: replace generic-node sizing at its source

### Add one deep geometry module

Add `apps/web/src/workbench/canvas/CanvasGenericNodeGeometry.ts` with the only
generic-node geometry constants and algorithms:

- presentation height: `48` px;
- automatic minimum width: `120` px;
- automatic maximum width: `360` px;
- scene conversion through the shared `CANVAS_NODE_PRESENTATION_SCALE = 10`;
- `ceil(intrinsicIdentityRowWidth)` before `clamp(120, value, 360)`;
- batch production measurement and a deterministic injected test measurer.

Remove `INTERNAL_SCALE`, `GENERIC_HORIZONTAL_CHROME`, `LABEL_FONT`,
`labelContext`, `labelWidthCache`, and `measureCanvasLabelWidth` from
`CanvasScene.ts`. Rename `CanvasTextPresentationGeometry.ts` to
`CanvasNodePresentationGeometry.ts`, retain text geometry there, and make its
`CANVAS_NODE_PRESENTATION_SCALE` the shared source. Set the corresponding CSS
custom property from that TypeScript value at the node/surface boundary and
remove the literal `10` from `canvas.css`.

### Measure the rendered identity row, not an estimate

The production measurer must:

1. receive all unique generic-node labels for a projection as one batch;
2. reuse the exact identity-row classes used by `CanvasGenericNodeContent`;
3. create an offscreen, hidden, width-max-content container containing the icon
   slot, gap, label, and horizontal padding for every uncached label;
4. append the batch once, read all widths after that single DOM write, then
   remove the specimens;
5. cache only successful complete-row measurements by exact label;
6. execute only after Workbench shell fonts are ready; fail loudly if that
   precondition or DOM measurement is unavailable;
7. never fall back to Canvas2D, character counts, the old `+54`, or a second
   formula.

Using an icon slot with the exact rendered fixed dimensions is sufficient;
different generic icons do not get different width algorithms.

`CanvasScene` continues to choose which resources use generic geometry:
Project root, directories, unknown files, and images without required intrinsic
dimensions. Text and audio retain their fixed sizes, available image and video
retain intrinsic sizing, and unavailable video uses a `3200 × 1800` fallback
so its Content Region is not compressed into generic-node height.

### Overflow and migration

- Automatic labels ellipsize only when the measured identity row exceeds 360.
- A row below 120 uses width 120 without ellipsis.
- Manual Layout continues to ellipsize according to its stored rectangle.
- Existing automatic nodes recalculate immediately because their geometry is
  derived.
- Existing Manual Layout rectangles keep x, y, width, and height exactly,
  including widths inherited from the old automatic implementation.
- Reset Layout deletes the Manual Layout rectangle and opts the node back into
  the current automatic rule.
- Add no state version, migration marker, or width-origin field.

## Work package 2: make all Canvas chrome non-layout and delete Feedback Frame

### Fix the border defect

In `canvas.css`, replace the default non-image node border with inset paint or a
pointer-transparent pseudo-element. It must:

- consume zero layout space;
- remain one screen pixel through the existing inverse-zoom chrome scale;
- preserve geometry and label content width at every supported camera zoom from
  `0.01` through `9.99`;
- have no low-zoom hide/clamp branch.

Hover, Selection, Content Activation, resize handles, and feedback geometry are
also paint/overlay only. None may enter the node box model. Content-owned chrome
inside a fixed `×10` presentation uses the shared inverse presentation scale
before inverse-camera compensation, keeping the inner ring and feedback marks
at the same screen thickness as native-size media.

### Remove Feedback Frame completely

Delete:

- `CanvasFeedbackFrame.tsx`;
- `CanvasFeedbackFrame.test.tsx`;
- its `CanvasNodeShell` import and render;
- `canvasFeedbackEntryHasFeedback`, `canvas-node-has-feedback`, and the
  feedback-dependent outline suppression;
- `.canvas-feedback-frame` and related CSS;
- tests and documentation that expect the frame.

Keep Feedback Bar, Capsules, marks, pins, rectangles, and their pointer
precedence. Do not replace Feedback Frame in this change.

### Independent visual states

- node hover: weak neutral outer outline;
- Canvas Node Selection: persistent stronger orange outer outline;
- activatable Content Region hover: weak teal inner affordance;
- Canvas Content Activation: teal inner ring within the Content Region;
- Node Manipulation Region hover: highlighted title bar and `grab` cursor;
- active node movement: `grabbing` cursor;
- resize: existing directional handles/cursors;
- selected and content-active: orange outer outline plus teal inner ring.

Exact token values remain tunable. All these effects use `pointer-events:none`
paint where an overlay is introduced.

## Work package 3: centralize pointer decisions without importing tldraw

### Stable hit-test vocabulary

Replace state-dependent zone values with these stable values:

- `content`;
- `manipulation`;
- `action`;
- `resize`;
- `feedback`;
- `content-island`.

Region identity never changes when Activation changes. Precedence is:

1. feedback;
2. resize;
3. content-island;
4. content, including controls nested inside it;
5. title-bar action;
6. manipulation;
7. node default or blank Canvas.

Media time and volume ranges additionally publish one stable
direct-manipulation hint so they can activate on pointer-down without Canvas
capturing their gesture. This hint is not another region or state-dependent
zone.

Delete `activate`, `passive`, `move`, and `interaction-island`, along with
`data-canvas-node-default-zone` and activation-dependent region attributes.

### One pure interaction policy

Add a browser-free, table-driven `CanvasInteractionPolicy.ts`. Its input is the
current Selection, current Activation, resolved target, modifiers, and
completed gesture kind. Its output contains only:

- the next Selection/Activation command;
- whether Canvas begins move, resize, marquee, or no gesture;
- whether the content adapter receives a text-caret or video-toggle handoff.

It does not know React components, DOM selectors, media elements, Workbench
panels, or persisted Canvas State.

### One atomic Runtime commit path

In `CanvasEditorRuntime`, create one private commit that writes Selection and
Content Activation together, validates that Activation points to a projected
text/video/audio node, enforces sole Selection, invalidates one snapshot, and
notifies each changed subscription once.

Retain semantic public operations only:

- set Selection while preserving Activation only when the same node remains the
  sole selection;
- set Selection and explicitly end Activation;
- atomically sole-select and activate one content-capable node;
- end Activation while preserving Selection.

Remove the unconstrained `setContentInteraction(path)` API. Projection changes
prune Selection and Activation through the same atomic path. Returning later to
a sole selection never restores old Activation.

### Correct pointer timing

- Ordinary clicks mutate state only after successful pointer release on the
  matching target.
- Pointer-down in a Node Manipulation Region records a pending gesture only.
- Below the four-screen-pixel threshold, release commits the ordinary click.
- Crossing the threshold atomically selects, ends Activation, and begins move.
- Resize is explicit direct manipulation and commits Selection/end-Activation
  on pointer-down.
- Audio/video time or volume drag activates on pointer-down and the same native
  range gesture continues without Canvas pointer capture.
- Pointer cancellation restores the pre-gesture state.
- Inactive text press-drag beyond the click threshold cancels; it does not move,
  pan, or synthesize a CodeMirror selection.

### Workbench boundary, context menu, focus, and Escape

Add one thin completed-click boundary at the Workbench shell:

- successful primary clicks outside CanvasSurface end Activation but preserve
  Canvas Selection;
- a `content-island` belonging to the active node preserves Activation;
- CanvasSurface continues to own blank/node selection results;
- pointer-down, cancelled clicks, window blur, and focus changes do nothing.

Do not add a global Workbench state machine or `focusin` listener.

Context-menu invocation itself is not click-away. Keep current context
selection rules: active node preserves; another unselected node becomes the
selection and therefore ends old Activation; blank Canvas clears Selection.

Retain only the existing Escape command route: local components may consume it
first; otherwise an active Canvas gesture cancels, then Activation ends, then a
later Canvas-owned Escape may clear Selection. Do not add focus movement or new
keyboard navigation machinery.

### Wheel ownership

- focused active CodeMirror owns ordinary wheel scrolling;
- scroll boundaries use `overscroll-behavior: contain` and never move Canvas;
- ordinary wheel elsewhere on Canvas pans Canvas;
- Command/Control-wheel and trackpad pinch zoom Canvas even over focused
  CodeMirror;
- audio/video controls gain no wheel bindings.

Adjust the existing global-wheel predicate rather than adding another wheel
listener.

## Work package 4: preserve exactly-once content handoff

### Text

Replace `CanvasPreviewActivationRequest` with a scoped, one-shot content handoff
request whose text variant carries request id, path, and original client
coordinates.

On a successful inactive Text Content Region click:

1. Runtime atomically sole-selects and activates the text node;
2. the editor mounts or reuses the still-mounted retirement instance;
3. CodeMirror focuses and resolves the original coordinates to one valid caret
   position;
4. the request is consumed once.

No synthetic second click, cross-handoff `dblclick`, or inactive press-drag
selection is supported. A stale/cancelled request cannot later focus the
editor. Failure preserves Selection, ends Activation, and shows the inactive
Content Region error surface.

### Reversible preview retirement

Text editor-to-preview and paused-video-to-preview handoffs keep the old
instance until the preview commits. Video retirement also requires the
projected Playback Position to match the latest player boundary, so an old
visible preview cannot retire a player while persistence is still in flight.
This is the only retirement mechanism:

- reactivation before commit invalidates the retirement token and reuses the
  existing instance;
- a late preview may remain cached but cannot replace reactivated content;
- only a completed retirement causes a later activation to create a new
  instance;
- add no duplicate-player pool or restoration branch.

## Work package 5: unify audio and video controls through Media Chrome

### Audio

Extract an explicit `CanvasAudioNodeContent` and
`CanvasAudioPlayerAdapter` instead of keeping audio in the generic image/audio
branch.

Structure:

- 32 px upper `CanvasNodeTitleBar` as Node Manipulation Region;
- lower fixed-size Content Region;
- Media Chrome controller in `audio` mode with native
  `<audio slot="media" preload="none">`;
- project-styled rectangular controls: play, time range, time display, mute,
  and volume;
- no native `controls` attribute, browser pill, semicircular ends, captions,
  fullscreen, picture-in-picture, playback-rate UI, or shortcut dialog.

The same controller and audio element remain mounted active and inactive.
Deactivation never pauses or unloads it. Inactive controls remain readable and
show live state. A control click activates and applies its trusted action once;
a range press activates and continues the same drag; empty player background
activates without autoplay.

### Video

Keep the current preview/player module and `playingVideoPaths` Set. Change only
the ownership boundaries:

- replace the one-shot play request with an exactly-once playback-toggle
  request;
- a mounted inactive Media Chrome button activates and acts once;
- a mounted inactive range activates on pointer-down and continues;
- media surface/background activates and toggles once;
- set Media Chrome `noHotkeys` from Content Activation instead of always true;
- remove shortcut-only methods from `CanvasVideoPlayerHandle`; keep only
  methods still required by Feedback and playback restoration;
- delete the window key listener, requested-hotkey mount path, target hotkey
  registry, and delayed key replay;
- keep Media Chrome's local mappings and video capabilities;
- ignore a key pressed during preview-to-player handoff.

Video player eligibility is exactly:

| Content active | Playing | Player residency |
| --- | --- | --- |
| yes | yes | mounted |
| yes | no | mounted |
| no | yes | mounted |
| no | no | preview handoff, then unmounted |

Any number of videos may play. Starting another does not pause the rest. Camera
culling does not unload a playing player. Leaving the Canvas projection through
ancestor collapse, deletion, Project change, or Canvas close stops and unmounts
media; do not create a background player registry.

### Content errors

For Text, Video, and Audio only:

- terminal handoff, load, decode, or playback failure preserves Selection,
  ends Activation, and marks media not playing;
- buffering and temporary stalls are not terminal errors;
- the entire Content Region shows the error plus “点击重试” and is the retry
  target;
- remove the separate Retry button and title-bar status for that failure;
- retry is a new request using the new click, never automatic replay;
- failed media elements are discarded; video retry toggles once after success,
  audio retry restores controls without autoplay;
- no custom keyboard-only retry state machine.

Image has no Content Region and keeps its existing image-preview error contract;
this change must not silently give image nodes Content Activation.

## Work package 6: delete superseded code rather than wrap it

Delete outright:

- Canvas2D label measurement and its cache;
- `+54` and duplicate generic width constants;
- layout-affecting default node border;
- `CanvasFeedbackFrame.tsx` and test;
- `CanvasVideoHotkeyController.ts` and test;
- global Canvas video key listener and hotkey-only mount request;
- dynamic node-zone values and state-dependent attributes;
- native browser audio controls and their inactive pointer suppression;
- unconstrained `setContentInteraction`;
- separate visible Retry buttons for Text/Video/Audio Content Region errors;
- tests that assert any removed contract.

Do not add adapters that translate old zones or setters to new ones. Update all
callers in the same change.

## Work package 7: verification without duplicate test matrices

### Pure and DOM tests

1. `CanvasGenericNodeGeometry.test.ts`
   - minimum, intrinsic, maximum, ceil-before-clamp;
   - 120/360 one-source constants;
   - full-row injected measurement;
   - Manual Layout display-rectangle bypass without Automatic Layout reflow;
   - text/audio/image/video explicit sizing unchanged;
   - no production fallback.
2. `CanvasScene.test.ts`
   - hierarchy positions consume the geometry module output;
   - no repeated sizing algorithm.
3. `CanvasInteractionPolicy.test.ts`
   - state-transition table from ADR 0011, including modifiers, gesture
     thresholds, content islands, and Workbench click-away;
   - cancellation restoration remains a Runtime snapshot test because it uses
     the recorded pre-gesture state rather than a fresh policy decision.
4. `CanvasEditorRuntime.test.ts`
   - atomic snapshot/notification behavior;
   - activation invariant and projection pruning;
   - pending move does not select; threshold transition does.
5. `CanvasDomInteractionAdapter.dom.test.ts`
   - stable region precedence independent of Activation;
   - nested media controls and range hint;
   - content islands.
6. Targeted component DOM tests
   - Text caret request consumed once and stale request ignored;
   - Audio stable mount and trusted button/range behavior;
   - Video toggle request, reversible retirement, multi-play residency;
   - terminal error surface and whole-region retry;
   - independent visual attributes;
   - no Feedback Frame or old zones.

The pure policy suite owns the combinatorial matrix. Component tests prove DOM
wiring and exactly-once handoff only; they must not duplicate every policy row.

### Real browser verification

The existing `pnpm verify:browser` fixture and script remains the sole
Playwright entry point. It opens the four reported directory names:
`taobao-product-detail-image-test`, `taobao-product-detail-images`,
`taobao-womens-ranking`, and `womens-clothing`. At normal and extreme zoom-out
it independently measures each complete rendered identity row and asserts:

- the automatic presentation width is exactly
  `clamp(120, ceil(intrinsic row width), 360)` CSS px;
- a row below the maximum does not ellipsize;
- zoom does not change the presentation-space width.

The pure geometry and scene suites own minimum, intrinsic, maximum,
ceil-before-clamp, Manual Layout display-rectangle bypass without Automatic
Layout reflow, and explicit media sizing including the unavailable-video
Content Region fallback.
That matrix is intentionally not duplicated in Playwright.

The same real-browser flow verifies inactive Text first-click caret placement,
ordinary editor wheel versus modified Canvas zoom, Video first-click toggle and
paused-inactive retirement, mounted inactive Video local control behavior,
Audio structure and playback controls, Workbench click-away, preview handoff,
and raster decoding. Those checks remain browser-owned because they depend on
real layout, focus, trusted media events, decoding, or playback.

### Completed verification

Focused Vitest files were run throughout implementation. The final focused
Canvas matrix passed with 31 files and 314 tests, and `pnpm verify:browser`
passed the real-browser contracts above.

The first and only `pnpm verify:all` run passed Doctor, binding generation,
TypeScript checking, and exhaustive all-target Rust formatting and Clippy. Its
Vitest stage then exposed one stale `CanvasEditorScene` assertion that still
expected Selection Raise on pointer-down. The test was corrected to the settled
pending-gesture contract: no presentation update before the four-screen-pixel
threshold, then one atomic Selection Raise and geometry update when the
threshold is crossed.

After that correction, the complete remaining gate was run by stage so that
`verify:all` was not repeated:

- `pnpm test`: 202 files and 1,394 tests passed;
- `pnpm test:rust`: passed;
- `pnpm lint:arch`: passed;
- `pnpm build:artifacts`: passed.

Together with the successful pre-Vitest stages from the single `verify:all`
run, every stage of the exhaustive repository gate passed against the final
implementation. The split execution is recorded explicitly so this document
does not falsely claim that the single aggregate command itself exited zero.

## Completed implementation order

1. Add geometry module and tests; route `CanvasScene` through it; remove old
   measurement immediately.
2. Replace layout border with non-layout paint and add browser zoom regression.
3. Add pure interaction policy and Runtime atomic commit; update Runtime tests.
4. Publish stable DOM regions and correct pointer timing in `CanvasSurface`.
5. Complete Text handoff/error integration and Workbench click-away.
6. Add project-styled Audio Media Chrome adapter.
7. Simplify Video to local Media Chrome shortcuts and final residency rules.
8. Delete Feedback Frame and every remaining old zone/hotkey/retry path.
9. Run targeted review, search for forbidden legacy names, run browser checks,
   then the final repository gate.

The branch is complete only when all old and new paths no longer coexist and
the final repository gate passes.

## Final forbidden-redundancy audit

Before handoff, repository search must show no production occurrences of:

- `LABEL_FONT` in Canvas scene sizing;
- `GENERIC_HORIZONTAL_CHROME` or the sizing `+54`;
- `CanvasFeedbackFrame`;
- `CanvasVideoHotkeyController`;
- `data-canvas-node-zone="activate"`;
- `data-canvas-node-zone="passive"`;
- `data-canvas-node-zone="move"`;
- `data-canvas-interaction-island`;
- public `setContentInteraction`;
- native `<audio controls>` in Canvas;
- a Text/Video/Audio Content Region Retry button.

The final code has one geometry formula, one pointer decision table, one atomic
Selection/Activation commit path, one Media Chrome shortcut owner, one video
residency rule, and no Feedback Frame.
