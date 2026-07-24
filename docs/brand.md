# Debrute Brand

Debrute's product identity is built around one complete, deliberately awkward
mascot. Brand expression adapts to platform constraints while preserving the
character's whole-body composition.

This document defines the implemented identity, its canonical artwork, allowed
renditions, placement, and color anchors. Workbench UI styling is defined in
[the design system](./design-system.md), while asset generation and publishing
are defined in [releases](./releases.md).

## Language

**Debrute Mascot**:
The complete square-headed character, including its orange top block,
asymmetric ears, offset cream facial features, teeth, tiny orange body, arms,
legs, and feet.
_Avoid_: Head mascot, mascot face

**Complete Mascot Mark**:
A rendition of the entire Debrute Mascot used as Debrute's identifying mark.
It never crops to the head, removes the tiny body, or recomposes the character.
_Avoid_: Head mark, partial mascot, extracted face

**Product Icon**:
A platform-specific rendition of the Complete Mascot Mark used for product
identity in Web, Desktop, Dock, and Runtime tray surfaces.
_Avoid_: Project Logo, Project Icon

## Canonical Artwork

`assets/brand/debrute-mascot.svg` is the only human-edited identity source. Its
pale-peach paper background is independently addressable, while every visible
part of the Debrute Mascot belongs to one complete foreground composition. The
SVG preserves the artwork's rough edges and grain instead of smoothing the
mascot into precise geometric shapes.

The SVG uses a 2048 by 2048 view box and exposes exactly two
consumer-addressable top-level groups: `paper` and `mascot`. The `mascot` group
contains the vector paths, masks, and fills needed to render the character, but
publishes no independently consumable head, face, body, limb, or feature group.
It embeds no raster image, links no external resource, and has baked transforms
so every derivative reads stable bounds.

The canonical artwork preserves the approved silhouette, asymmetry, color-block
boundaries, feature placement, tiny-body proportion, and handmade edge rhythm.
Its edges are not auto-smoothed; its ears, face, nose, mouth, teeth, and body are
not regularized or optically reconstructed.

The approved 2048px raster reference lives at
`assets/brand/reference/debrute-mascot-approved.png` for fidelity tests. Release
tests rasterize the canonical SVG and compare its charcoal and clay color-block
silhouettes, including the lower tiny-body region, against that reference. The
reference is evidence for the canonical vector, not a consumable logo source.

Consumers may render the complete mascot with the paper background or over
transparency. Web, PNG, ICNS, ICO, Dock, and Runtime tray outputs are
deterministic derivatives of the canonical SVG.

## Responsive Icon Scaling

The mascot's internal proportions are fixed, while its complete composition
occupies progressively more of the available canvas as output size decreases.
Application profiles use 88% occupancy at 1024px, 90% through 512px, 92% at
128px, and 94% at 64px and below. The favicon uses 92%; tray foregrounds use
91% inside their platform-safe content bounds.

Every profile scales and optically centers the whole character as one unit. It
does not enlarge the head or face independently and does not crop the tiny body,
limbs, or feet. The profiles are verified at 16px, 32px, Dock, macOS tray, and
Windows tray sizes.

## Tray Renditions

The macOS template rendition maps the complete mascot silhouette to the system
monochrome foreground. Cream eyes, nose, brow shape, and teeth become transparent
negative space so the menu-bar background preserves the face. Their geometry is
fixed, and every body part remains present.

The Windows tray rendition uses the complete full-color mascot over
transparency. Neither platform uses a head-only or simplified mascot.

## Platform Icon Containers

The Complete Mascot Mark remains identical while its surrounding paper container
adapts to the consumer. README uses the broad pale-peach square composition. The
Web favicon uses a pale-peach square paper field with restrained handmade edges.
macOS application and Dock output use the platform-safe rounded silhouette,
filled with textured pale-peach paper without gradients or dimensional
highlights. Windows application output uses a squarer, mildly irregular paper
field with transparent outer safe area.

macOS and Windows tray renditions have no paper container. Platform differences
are limited to background presence, paper silhouette, corner treatment, and safe
area; they never alter the complete mascot.

## Identity Invariants

- Every brand and product-icon rendition contains the complete Debrute Mascot.
- Variants may change dimensions, transparency, background treatment, file
  format, and platform-required color treatment.
- Vector or raster conversion preserves the character as one composition and
  does not expose body parts as independent marks.
- Small-size legibility is solved without a head-only or face-only symbol.
- Platform-required monochrome output is the only color-treatment exception.

## Identity Placement

The Complete Mascot Mark appears in README identity, the Web favicon, Electron
application and Dock icons, ICNS and ICO output, and Runtime tray icons. It does
not appear in title bars, empty states, panels, buttons, notifications, Canvas
nodes, Terminal content, or other product UI positions.

Operating-system, browser, and Photoshop host chrome remain host-owned. Product
UI uses the mascot's palette and visual character through the design-system
tokens and primitives, not by adding mascot artwork to interface surfaces.

## Brand Color Anchors

**Brand Clay** (`#D76522`):
The mascot's clay orange and Debrute's primary identity color. It may mark a
small number of high-intent primary actions, but it is not a universal accent or
status color.
_Avoid_: Global accent, warning orange

**Brand Ink** (`#282825`):
The mascot charcoal used for light-theme typography and major collage blocks.
_Avoid_: Cold technology gray

**Brand Ink Deep** (`#171714`):
The deepest identity underlayer and broad night field.

**Brand Paper** (`#F9E8D4`):
The pale-peach paper carried by the mascot artwork and platform containers.
_Avoid_: Pure white surface

**Brand Cream** (`#FFF0DC`):
The warm light paper used for raised identity fields and highlights.

## Palette Derivation

The canonical artwork preserves its charcoal, clay orange, cream, and
pale-peach relationship. Product surfaces do not recolor the mascot for local UI
state. Light and night UI palettes derive accessible tonal ramps from the brand
anchors by adjusting lightness and chroma.

Primary action, selection, keyboard focus, warning, danger, information, and
Canvas feedback are independent semantic roles. Brand Clay pairs with Brand Ink
Deep for primary-action text; cream on clay is not an accepted normal-text pair.
The full light, night, and semantic token tables live in the
[design system](./design-system.md#reference-palette).

## Source And Verification

The asset generator reads `assets/brand/debrute-mascot.svg`; generated consumer
assets are not edited by hand. The executable output matrix, sync command,
packaging paths, and publishing rules live in [releases](./releases.md).

Release tests verify canonical group structure, full-body silhouettes, raster
fidelity, deterministic generated artifacts, responsive occupancy, platform
containers, tray color treatment, and consumer ownership.
