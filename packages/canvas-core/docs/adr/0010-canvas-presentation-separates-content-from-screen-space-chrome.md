---
status: accepted
---

# Canvas presentation separates content from screen-space chrome

This decision supersedes the generic-node width and label-measurement rules
recorded in ADR 0008 and defines the unavailable-video presentation fallback.
That ADR continues to own Canvas membership, Automatic Layout structure, and
the remaining scene-projection contract.

Canvas retains Project Tree and Canvas State as its authoritative model, with
Workbench-owned scene projection, Automatic Layout, Manual Layout overlay,
interaction Runtime, media presentation, and persistence. It does not adopt
tldraw's Store, Shape IDs, or complete interaction engine. Workbench instead
uses a deep Canvas presentation module that separates camera-independent world
geometry and node content from screen-space chrome and interaction visuals.

Automatic node geometry, content layout, and label overflow never depend on the
camera. Screen-constant borders, selection, feedback overlays, and resize handles
may depend on camera zoom but cannot participate in the content box model or
change scene geometry. Label measurement uses rendering-matched DOM styles only
after the required fonts are ready. Shared node-frame chrome owns this rule for
all applicable node types rather than directory-specific width compensation.
Content-owned chrome inside a fixed presentation transform first applies the
inverse presentation scale and then the inverse camera scale, so its screen
thickness matches chrome on native-size media instead of being multiplied by
the presentation transform.
Every video uses that fixed content-presentation transform whether or not
browser metadata is available, so its title bar and Media Chrome controls keep
the same presentation scale before, during, and after Content Activation.
Browser metadata still owns intrinsic scene geometry and video aspect; it does
not select the CSS presentation scale. The initial contract adds no adaptive
scale or minimum-resolution branch for small videos: those sources may crowd
their content presentation until real product evidence justifies a separate
geometry rule.
Video dimensions describe the Content Region rather than the complete Canvas
Node. Automatic video width equals content width, while automatic node height
adds the fixed `32` presentation-pixel title bar (`320` scene units at the
fixed presentation scale) above content height. Default aspect-preserving
corner resize likewise scales only the Content Region and then adds the same
unscaled title-bar height, so the video aspect remains stable while the complete
node aspect changes.
The same intrinsic-width path covers every generic node presentation, including
Project roots, directories, unknown resources, and images without intrinsic
dimensions. Content-capable resources retain an explicit presentation policy:
text and audio keep their fixed sizes, available video uses its intrinsic size
for the Content Region, and unavailable video uses a `3200 × 1800` scene-unit
Content Region fallback. In both video cases the title bar is additional node
geometry rather than content consumed from those dimensions.

The Workbench completes generic-node measurement synchronously before the first
scene projection, after its required fonts are ready. Mounted node content does
not observe its own size or write geometry back into the scene. This keeps node
placement, structure edges, and minimap geometry on one projection pass and
avoids a render-measure-relayout feedback loop.

The measured intrinsic content is the stable generic-node identity row: its
icon, gap, label, and padding. Transient availability titles, error messages,
and load failures render within that geometry but never resize it. A resource
state or locale change therefore cannot move unrelated nodes in Automatic
Layout.

Automatic generic-node minimum and maximum widths have one owner and are
initially `120` and `360` camera-independent generic-presentation layout pixels.
These are tuning constants, not layout tiers. DOM
measurement and clamping happen once in that coordinate space; the resulting
width is then converted once through the fixed node-presentation scale into
scene units. CSS does not clamp it again, and camera zoom changes only its final
screen-space size. Changing either bound therefore changes one constant rather
than coordinated values in layout and presentation code.

Automatic Layout rounds the measured intrinsic width upward to a whole
presentation pixel before clamping. A generic-node label is not ellipsized when
that rounded width is within the maximum; ellipsis is permitted only when the
maximum clamps a wider identity row. A shorter row uses the minimum without
ellipsis. Manual Layout remains unconstrained and may ellipsize content at any
manually chosen width. Camera zoom never changes any of these overflow states.
Existing Manual Layout rectangles retain their complete stored geometry,
including widths inherited from an older automatic layout before a node was
moved. Reset Layout removes that rectangle and opts the node into the current
automatic rule. Automatic geometry is derived, so this change requires no
Canvas-state migration, compatibility version, or width-source field.

Default node-frame paint remains non-layout, screen-constant chrome throughout
the supported camera range, including the minimum zoom of `0.01`. The change
does not add a low-zoom hide, clamp, or alternate-border threshold. Any later
visual degradation policy belongs to screen-space chrome and cannot enter node
measurement or scene geometry.

Production has one generic-node intrinsic-width implementation: the
rendering-matched DOM measurer. It does not silently fall back to Canvas2D text
metrics, character estimates, or another sizing formula when browser
measurement is unavailable. Scene-projection tests may inject a deterministic
measurer as a test boundary, while the production measurer caches only widths
that it measured through its own complete identity-row specimen.

Regression coverage extends the existing isolated `pnpm verify:browser`
Playwright workflow rather than creating another browser-test entry point. Its
fixture includes the four originally reported directory labels and verifies
their exact rendering-matched widths, overflow, and zoom invariance at normal
and extreme zoom-out against the product DOM. Focused Vitest coverage owns pure
minimum, intrinsic, maximum, rounding, Manual Layout bypass, explicit-media
sizing and unavailable-video fallback behavior, and the supported camera-range
chrome rule.

This borrows tldraw's separation of shape geometry, content, and overlays while
rejecting a second authoritative shape model that would duplicate Project Path
identity, sparse Canvas State, and Debrute's media lifecycles. The trade-off is
an explicit distinction between world, content, and screen coordinate spaces,
plus browser-level invariance tests across camera zoom and an explicit
supported-range policy for chrome.

The migration does not introduce a Canvas-level node-chrome registry or rewrite
interaction visuals that already avoid the content box model. Existing
selection outlines, absolute resize handles, minimap presentation, and Feedback
Bar placement retain their current owners. The obsolete node-wide Feedback
Frame is removed rather than migrated. Only automatic generic-node measurement
and layout-affecting default frame paint otherwise change, avoiding a second
copy of node registration, culling, stacking, selection, or feedback state.
