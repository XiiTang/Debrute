---
version: alpha
name: Debrute Front-End Design System
description: Project-level front-end design constraints for Debrute.
tokenSource: apps/web/src/workbench/ui/styles/tokens.css
designStatus: current
implementationStatus: implemented
---

# Debrute Front-End Design System

## Overview

Debrute is a browser-first, project-scale local visual workbench for working with AI Agents in browser and Electron pointer-and-keyboard environments. The UI is compact, theme-aware, expressive, and built for repeated daily use. Phone and touch-first layouts are outside the product contract.

This document defines the current implemented visual system. Executable tokens,
shared primitives, generated brand assets, and the source-owned platform styles
are authoritative where implementation details are required.

Current shell, state, Settings, theme, language, Explorer, and context-menu
ownership is documented in [`workbench.md`](./workbench.md).

## Product Language

Workbench chrome uses Debrute's warm, flat, handmade collage language: large
charcoal, clay-orange, cream, and peach color fields; deliberate asymmetry; and
controlled roughness rather than polished glass, conventional gradients, or
decorative three-dimensional light. This language is expressed in both light
and dark/night themes. Dense production workflows, readable typography, layout
geometry, text baselines, and interaction hit targets remain precise.

Brand colors and semantic colors are separate roles. Warning, danger,
information, selection, focus, and explicit completion remain distinguishable;
quiet ready, connected, configured, and up-to-date states do not become orange
merely to display the brand color.

Canvas regions used to judge creative content remain functionally neutral and
high-clarity. Terminal uses a warm-neutral field and a coordinated ANSI palette
that preserves distinct semantic hues and text contrast. Their surrounding
panels, bars, menus, and controls use the Debrute brand language. Canvas objects
and media annotations may use stronger local affordances when required for
visibility over creative content; those affordances do not define general
product chrome.

The Canvas viewport uses a low-chroma peach-paper field in light mode and a warm
charcoal field in dark mode. Its exact low-contrast grid, node selection,
connections, handles, and feedback accents derive from the same clay, cream,
ochre, and muted folk-color families as the surrounding interface. Paper grain,
irregular masks, offset ornament, decorative shadows, and display typography do
not enter the viewport because they would interfere with judging creative
content, transparency, edges, and texture.

Workbench chrome is limited to the product's defined pages, panels, controls,
and overlays. Logo placement, mascot placement, and product-icon artwork follow
[`brand.md`](./brand.md). Paper layering and texture are surface treatments, not
additional content or decorative modules.

Workbench density and layout are compact and stable. Control heights, panel and
tree geometry, text wrapping, scrolling, drag boundaries, and minimum sizes do
not expand or reflow for visual treatment. Large color fields use the surfaces'
own fills and layers. Only optical corrections required by font metrics, icon
weight, or cut-edge masks may affect paint.

The visual system is static. It defines no mascot animation, ambient animation,
or extra animated states. Product motion uses the durations and easing in the
token source, and reduced-motion behavior remains available.

## Surface Coverage

The visual system applies to the shared Web/Electron Workbench, Desktop's native
first frame, and Debrute-owned content and controls in the Photoshop UXP panel.
Product artwork and platform icon containers are governed by
[`brand.md`](./brand.md); generation and publishing are governed by
[`releases.md`](./releases.md).

Operating-system, browser, and Photoshop host chrome remain host-owned. UXP
responds to Photoshop appearance and maps Debrute panel content to the
corresponding light or dark product theme.

## Theme Ownership

**Workbench Theme** is the unified front-end visual system applied across every
Project and Workbench window. Changing Projects does not select, persist, or
override it; `Project Theme` is not a product term. It owns semantic colors,
surface treatment, shared-control presentation, the Canvas editor palette, and
syntax styling. Canvas Text Appearance remains a separate Canvas-owned input for
the typography of Project text, and the rendered editor and its derived preview
compose both inputs without either owning the other.

Canvas Text Appearance supplies the base font weight. Workbench Theme syntax
rules may override font weight or font style for individual tokens, but they do
not override Canvas Font, font size, line height, letter spacing, or ligatures.
Token-specific weight requests follow the same managed-face matching contract
as the base weight. Canvas text rendering disables font synthesis: when a Theme
requests a weight or style for which the selected Canvas Font has no real
managed face, it uses the closest real face and never fabricates bold or
oblique outlines. The initial normal-face-only catalog may therefore render an
italic token upright.

The current product provides one Workbench Theme with light and dark modes. The
`system`, `dark`, and `light` preference selects the resolved mode rather than a
theme identity. Theme presets, a theme schema, theme import, and theme-selection
UI are outside the current product contract.

Settings presents these composed inputs on a dedicated **Appearance** page in
the general navigation group. Its **Workbench Theme** section owns the existing
mode preference, while its **Canvas Text Appearance** section owns the global
font, font size, line height, font weight, letter spacing, and ligature controls.
Font selection is a closed catalog control and never accepts an arbitrary
family name, path, or user-entered identifier. It lists the five catalog display
names without a specimen, per-option font rendering, editable search, or
temporary preview. Language, product-information, and update controls remain on
the separate General page. Valid control changes update the real Canvas text
surfaces immediately.

## Theme Language

Light mode uses cream and pale peach as its broad paper field, with charcoal
blocks and clay-orange identity accents. Dark mode is the same collage world at
night, not a mechanical inversion: deep warm charcoal forms the broad field;
coal black, warm black, and fired-brown blocks establish layer hierarchy; cream
carries primary text and key graphics; and peach or cream appears as a local
paper patch rather than a full-screen surface. Dark mode does not fall back to
cold blue-gray technology neutrals.

Texture, rough edges, and offset composition persist across both themes. The
`system` preference continues to resolve to light or dark from the operating
system appearance.

## Material And Layering

Surface hierarchy is expressed as layered paper: broad color contrast, overlap,
offset placement, exposed underlayers, and short unblurred paper-edge shadows.
Panels, menus, labels, and floating bars should read as pieces placed over one
another rather than glass planes suspended in space.

Decorative gradients, large soft shadows, backdrop blur, and glass-like
translucency are outside the product language. A thin technical edge is valid
only where a field boundary, keyboard focus, Canvas visibility, or another
functional requirement needs it. Functional elevation remains legible in both
themes without recreating conventional three-dimensional lighting.

Decorative perimeter borders and divider lines are outside the product
language. Workbench chrome separates adjacent regions with solid color blocks,
spacing, cut-paper masks, and exposed offset underlayers. Compact controls and
fields use a 2px lower-right underlayer instead of a four-sided line frame;
panels, menus, cards, modals, status labels, section headers, and active tabs
likewise carry no decorative perimeter or underline.

Paper depth has two fixed offsets: 2px for compact controls and labels, and 4px
for panels, menus, and large blocks. Both use zero blur and an opaque or
near-opaque underlayer. Dense fields, tree rows, Canvas content, and Terminal
content do not receive a decorative shadow. Generic corner-radius tokens resolve
to zero; fixed cut-edge masks, rather than rounded rectangles, provide the
visible silhouette. Platform icon containers and intrinsically circular
controls remain explicit exceptions.

## Static Material Resources

One shared implementation kit provides surface materials: one transparent
paper-grain alpha mask tinted by light/night theme
tokens, three fixed SVG rough-edge or clipped-corner masks spanning large,
medium, and small surface roles, and a small finite set of paper-offset
templates. Light and dark themes reuse the same structural resources.

The kit is centralized and consumed through shared tokens and UI primitives.
Features do not own independent texture systems. Runtime noise generation,
per-render randomization, and per-control decorative assets are outside the
design system.

The broad-surface grain has a maximum rendered opacity of 5% in light mode and
3.5% in night mode. Compact controls have a maximum of 2.5%. Grain is omitted
from Canvas and Terminal content fields and from any dense text surface where it
would reduce legibility. The large, medium, and small edge masks may deviate by
at most 2px, 1.5px, and 1px respectively at their intended render size. Masks
clip only paint; they do not change layout, hit targets, focus geometry, or
scroll bounds.

## Control Geometry

Square and cut-paper silhouettes are the default for panels, menus, buttons,
fields, tabs, labels, tags, status chips, and feedback items. Generic rounded
rectangles and capsule geometry are outside these roles. A small stable
vocabulary of clipped corners, notches, and asymmetric paper-label shapes
provides their silhouettes.

Dense fields and tree rows stay geometrically quiet even when their corners are
square. Circular geometry remains only where the control or visualization has
an intrinsic circular role. Visible asymmetry never changes layout dimensions
or the interaction hit area.

## Interaction States

Keyboard focus uses a precise, solid, high-contrast 2px square or cut-corner
technical frame. The frame has its own semantic role and never depends on paper
texture, shadow, glow, or Brand Clay alone.

Ordinary selection uses an exposed underlayer, side label, or selected surface
rather than a luminous outline. Hover changes the paper surface or layer cue,
pressed state uses a darker block, and disabled state reduces contrast and
material strength without sacrificing label legibility. Canvas selection and
feedback retain their independent functional rules.

## Controlled Roughness

Roughness is intentional, tiered, and reproducible. Empty states, section
titles, primary actions, and major interface blocks carry the strongest
handmade texture and irregular edges. Panels, menus, and labels use a moderate
finite set of rough edges, offsets, and exposed underlayers. Dense fields, tree
rows, and toolbars retain only a restrained material trace.

Canvas geometry, drag boundaries, code, Terminal content, text baselines, and
interaction hit areas remain precise. Visible shapes may be irregular while
their hit areas remain predictable rectangles. Runtime-random distortion is not
part of the design system; texture, edge-mask, and offset variants are stable so
screens do not jitter and visual verification remains reproducible.

## Typography

The design system has three typographic roles. Expressive display type is
reserved for sparse large text such as empty states, section titles, and brand
labels. It uses a heavy, slightly square woodcut sans-serif character. Stable
outlines may suggest uneven ink, but glyph skeletons remain clear; casual
handwriting, connected script, childish doodling, and retro display serifs are
outside this role. A warm, highly legible sans-serif carries menus, fields,
trees, settings, status text, and other dense production UI. A professional
monospace face carries code, paths, logs, and Terminal content.

The accepted display face is Smiley Sans 2.0.1. Its WOFF2 build is used only for
sparse display text at `--db-font-lg` or larger: empty-state titles,
section titles, and brand labels. It does not enter panel rows, menus, fields,
buttons with long labels, body copy, code, paths, or Terminal content. The
display stack uses the bundled Noto Sans SC as its explicit missing-glyph face;
it never falls through to an arbitrary system font. The
accepted functional face is Noto Sans SC 2.004 in static WOFF2 Regular 400,
Semibold 600, and Bold 700 builds. The accepted technical face is Noto Sans
Mono CJK SC 2.004 in static WOFF2 Regular and Bold builds. One family handles
its Chinese and Latin coverage; Debrute does not draw custom glyphs or define a
separate wordmark.

Workbench functional text uses the unitless
`--db-line-height-functional: 1.45` ratio. Compact single-line labels inherit
that ratio so each font size receives sufficient vertical glyph space while
control, title-bar, and panel geometry remains fixed. Horizontal truncation is
owned by the leaf that renders the text through `overflow`, `white-space`, and
`text-overflow`; a vertically clipped leaf must not combine that truncation
with `line-height: 1` or an undersized fixed-pixel line height. Icon-only
content, badges, and other content that is not vertically clipped may define a
different explicit line height when their geometry requires it.

Web and Electron load these files from the packaged product rather than a
network or operating-system font lookup. Static builds are required; the CFF2
variable builds are not part of the product contract. Font files, source
versions, OFL license text, and modification or subsetting notices live together
under `assets/fonts/`. Photoshop UXP is the explicit exception because it
cannot load packaged `@font-face` resources: UXP uses the Photoshop host font
and carries the brand through palette, geometry, and iconography instead of
pretending to provide cross-host metric parity.

Canvas text editors and their derived previews resolve Canvas Text Appearance
and Workbench Theme into an exact Canvas text render profile rather than
depending on the global technical-font family name. Canvas Font selection
chooses the managed faces; the profile digest-verifies and registers their exact
assets, applies the complete Canvas typography and editor geometry, and supplies
the same faces to preview raster capture. Changing a resolved typography or
syntax-style input creates a new preview identity. Existing derived previews
therefore become invalid and ordinary Canvas maintenance generates replacements
as needed, without an appearance-specific rebuild sweep.

Display type does not enter dense controls or technical content. At 15px it is
accepted only after bilingual 100% and 125% scale review proves that Chinese and
Latin labels remain clear without changing control height or wrapping. If a
particular label fails that review, it uses the functional face; the
layout is not enlarged to preserve display styling.

## Functional Iconography

Debrute Cutout Icons are the single Workbench icon family. They use solid
paper-cut silhouettes, familiar operation metaphors, fixed 16px and 20px
construction grids, and consistent visual weight. Slight asymmetry, clipped
corners, and fixed offsets provide character without weakening recognition.

Small functional icons omit paper-noise texture that would collapse at working
sizes. Charcoal and cream are their defaults, while clay orange is reserved for
a small number of primary actions. The interface uses no Lucide-style outline
glyphs. Accessible names and predictable hit
areas remain owned by shared UI primitives rather than by icon artwork.

The family is a Debrute-owned finite SVG path set, not a runtime icon generator
or a second external icon package. `WorkbenchIconProvider` remains the single
Workbench icon mapping boundary and maps semantic icon names to
the cutout paths. Icons use `currentColor`, solid fills, fixed optical alignment,
and no embedded background. A missing semantic icon is an implementation error.
CSS loading indicators may retain their intrinsic circular geometry and motion;
functional icons have no animation.

## Reference Palette

Identity anchors are defined in [`brand.md`](./brand.md#brand-color-anchors).
The values below are the UI visual and contrast audit anchors. Executable tokens
may encode equivalent values in another color space, but rendered sRGB output
must preserve the measured contrast role.

| Token role | Light | Night |
| --- | --- | --- |
| App background | `#F7E3D0` | `#171714` |
| Surface 1 | `#FFF0DC` | `#22201C` |
| Surface 2 | `#EAC7AE` | `#2D2923` |
| Surface 3 / underlayer | `#D7A17B` | `#3A332B` |
| Primary text | `#282825` | `#F7E7D2` |
| Muted text | `#655A50` | `#C6B6A2` |
| Subtle text / strong edge | `#6F6257` | `#918373` |
| Functional edge / control underlayer | `#6F6257` | `#8D755F` |
| Ordinary selection | `#E9B994` | `#5A3522` |
| Keyboard focus | `#276C70` | `#8BC9C6` |
| Warning | `#98660A` | `#E0A838` |
| Danger | `#A93C32` | `#E77967` |
| Information | `#2E7073` | `#73B8B5` |
| Canvas viewport | `#EFD8C5` | `#1A1815` |

Primary actions use Brand Clay with Brand Ink Deep text in both themes. Cream
text is not used on Brand Clay because it does not meet the normal-text contrast
contract. Warning, danger, and information values are foreground, icon, and
edge anchors; a filled semantic surface requires a separately audited paired
foreground token rather than assuming white or ink.

## Contrast And Accessibility

Following [WCAG 2.2](https://www.w3.org/TR/WCAG22/), normal text must meet at
least 4.5:1 contrast, large text at least 3:1, and meaningful UI component
boundaries and graphics at least 3:1 in their actual state and surrounding
surface. The anchor palette yields 11.86:1 for light primary text on the light
background, 14.81:1 for night primary text on the night background, and 4.94:1
for Brand Ink Deep on Brand Clay. Focus colors provide at least 4.86:1 against
their broad theme backgrounds.

Color is never the only carrier of warning, danger, selection, validation, or
status. Labels, icon shape, placement, and state geometry preserve meaning in
high contrast and color-vision-deficiency review. Texture is decorative and may
be removed without losing information. Keyboard focus remains visible over
every selected, hover, and pressed state, and the focus frame is not clipped by
the decorative edge mask.

## Token Semantics

`apps/web/src/workbench/ui/styles/tokens.css` is the only executable source for theme surfaces, text hierarchy, borders, semantic tones, spacing, typography sizes, radii, control sizes, shadows, motion, focus treatment, and z-index roles.

Feature styles consume `--db-*` tokens. A local custom property is valid only for intrinsic geometry or a domain-specific value that is not reusable product chrome.

Brand clay, primary action, selection, keyboard focus, warning, danger,
information, and Canvas feedback remain separate token roles. Canvas selection,
edges, feedback, and moment labels use theme-specific derivatives of the brand
clay, cream, ochre, muted teal, brick, plum, and olive families rather than a
detached generic blue/yellow palette. Warning remains warm ochre, danger remains
brick red, and information/focus remain muted blue-green.

## Component Model

`apps/web/src/workbench/ui/index.ts` is the only public primitive export surface. Primitives own size and visual variants, interaction states, accessibility, icon alignment, theme behavior, and control geometry. Feature classes may position primitives, but they do not redefine primitive chrome.

Shared layout without behavior stays a named CSS pattern. A React component exists only when it owns behavior, accessibility, or repeated markup with a stable semantic interface. A pattern is shared only when independent Workbench features use the same role. Cards represent independent repeated entities or local tool surfaces; they do not wrap pages or ordinary settings groups.

## Workbench Surfaces

The Workbench uses one continuous Canvas background and floating-panel
interaction model. Every valid Workbench page paints that background from the
top of the window through the main viewport, including while no Project is
bound, a Project is opening, or Project opening has failed. Sharing the Canvas
background does not create a Canvas domain object or enable Canvas interaction
in those states. The Not Found page remains outside the Workbench shell.

The title bar is a transparent interaction layer over the Canvas. It does not
paint a strip, gradient, texture, or duplicate Canvas background. Canvas Nodes
remain visible beneath it, while its reserved hit area continues to own window
dragging, menus, the title, and window controls. Resting title-bar chrome uses
only local text and icon contrast treatment; hover, focus, and expanded controls
may use a local control background.

`WorkbenchWindowHost` owns the Workbench panel dock, committed panel geometry,
Project layout persistence, and one z-order for panels and floating text
editors. `WorkbenchFloatingPanelShell` owns the shared panel frame, drag and
resize surfaces, close placement, continuous background, and body overflow. The
shell renders each panel name once.

Persistent Canvas controls occupy the lower Workbench region; upper
panel-launch controls belong to Workbench chrome. This is both an ownership
boundary and a stable placement convention. Mini Map, Reset Canvas Layout, and
Hierarchy Edge Visibility use the lower part of `canvas-chrome-layer`;
contextual Canvas Feedback actions remain beside their Canvas target. Explorer,
Inspector, Feedback Panel, Settings, and Terminal launch from
`workbench-dock-layer`. Moving a control for collision avoidance does not permit
crossing this semantic boundary.

Before a Project is bound, every fixed Workbench control remains visible.
Explorer, Inspector, Feedback Panel, Terminal, Mini Map, and Reset Canvas Layout
are disabled; Settings and Hierarchy Edge Visibility remain enabled because
they own Runtime-global preferences. Contextual Canvas Feedback actions do not
exist without a Canvas target. Hierarchy Edge Visibility renders `Eye` while
hierarchy edges are visible and `EyeOff` while they are hidden. The icon and
action label carry the state; this control has no persistent selected
background, while hover and keyboard focus remain visible.

Settings uses General, Appearance, Feedback, Models, Integrations, and System
navigation, one title per selected page, explicit loading/error/ready content, ordinary
sections for General and Appearance settings, and cards only for independent
repeated records. The Integrations page presents one row per Runtime-owned
Professional Application Integration, titled with the professional application's
name, with an
aggregate status and controlled switch; it does not present a platform master,
generic tool catalog, connection list, or manual Connect action. Photoshop
transfer activity disables only its row switch and uses one inline
`Transfer in progress.` message.

Explorer owns tree geometry and editing. Inspector owns selection properties,
metadata, and diagnostics. Terminal owns terminal tabs, sessions, status, and
emulator geometry. Project Open owns one focused entry rendered directly over
the Canvas background. Canvas owns node geometry, media presentation,
annotations, handles, feedback, and overlay placement.

Debrute Cutout remains the sole icon family for functional Workbench controls.
User-selected Feedback identity symbols are content decoration from the pinned
Phosphor Fill family: they appear in the Feedback settings preview, Action Bar,
and Feedback Panel, but do not replace Cutout buttons or navigation icons. An
unknown or unmapped Feedback Name uses the system-reserved question-mark symbol;
Settings does not expose that fallback as a configurable Feedback icon.

Project Open, Project opening, and failed Project opening render centered status
content directly over the Canvas background without a page, card, or
full-viewport surface. The title, Open Project action, and Recent list are
centered as one group within the main viewport below the title-bar hit area, so
adding Recent naturally places Open Project above the viewport midpoint. Recent
shows at most the first five Runtime-global MRU roots as whole-row buttons with
a folder icon, folder basename, and muted parent path. An empty list retains the
Recent heading and shows `No Recent Projects`. Clicking or keyboard-activating a
row opens it in the current Workbench through the ordinary Project-binding
lifecycle. A failed or stale root returns to Project Open with the attempted path
and error, without deleting or reordering the stored recent root. The File menu
remains the owner of the complete recent list and Clear Recent command.

A Project whose command authority was removed by preemption or an ended Runtime
connection keeps its last confirmed Canvas visible but frozen. A solid,
non-dismissible dialog blocks the Canvas, Canvas chrome,
Workbench dock and windows, title bar, and Activity surfaces without dimming or covering the Canvas.
The blocker is the highest shell layer and freezes every surface beneath it.

## Surface Application Matrix

| Surface | Visual treatment | Functional boundary |
| --- | --- | --- |
| Title bar and shell | One exact Canvas background continues behind a transparent title bar; no separate fill, texture, gradient, or edge | The title-bar hit area owns drag, menus, title, and window controls while Canvas content remains visible beneath it |
| Floating panels | Flat paper blocks with fixed cut edges and 4px hard underlayer | Drag, resize, z-order, overflow, and dimensions |
| Workbench panel dock | Compact upper-region Cutout controls with no enclosing rail | Opens Explorer, Inspector, Feedback Panel, Settings, and Terminal; never owns Canvas presentation commands |
| Menus and overlays | Opaque paper surface and 4px hard underlayer; no perimeter line | Commands, placement, keyboard behavior, and item density |
| Buttons, fields, tabs | Solid block or small fixed cut mask with 2px offset underlayer; no perimeter or active underline | Control height, label wrapping, and hit target |
| Tags, chips, status labels | Cut-paper label or rectangular underlayer; no capsule | Text, state meaning, and footprint |
| Activity Cards | Compact opaque straight-cornered paper block with restrained grain, the medium paper mask, and a 2px hard offset underlayer; no perimeter, soft shadow, hover lift, or Activity-specific radius | One identical card in the upper-right eight-second Floating Stack and the transparent Activity Center collection; Runtime-global records, active-task protection, terminal clear, and no unread or severity variants |
| Activity Center | No outer panel paint, perimeter, mask, shadow, divider, or full-height rail; its transparent title and Clear All toolbar uses the title-bar contrast shadow above a thin-scroll collection of Activity Cards | Content-adaptive right overlay capped by the remaining viewport height; only the collection scrolls, and the transparent area outside visible content never intercepts Canvas input |
| Validation | Inline semantic text within the owning form or action surface | Field or operation ownership, correction context, and persistence |
| Explorer, Settings, Inspector | Restrained grain and geometry at row scale | Information architecture and row geometry |
| Project Open | Centered title, action, error context, and up to five compact Recent rows directly over the Canvas background | Recent opens in the current Workbench; opening replaces the entry with progress; stale roots remain stored after failure; content contains no page, card, or mascot |
| Canvas viewport | Neutral audited field and exact grid; no grain | Content judgment, Canvas semantics, handles, feedback colors |
| Canvas chrome | Lower-region brand panels, bars, menus, and cut controls | Canvas geometry and media presentation; never opens Workbench panels |
| Terminal viewport | Warm-neutral field, coordinated high-contrast ANSI semantics, and precise mono typography | ANSI role distinctions; no texture, rough masks, ornament, or geometry changes |
| Terminal chrome | Panel-colored tab bar with the active tab exactly matching the Terminal viewport | Sessions, status, emulator geometry, and motion |

## Host Applications

README, Web favicon, Electron application icon, Dock icon, ICNS, ICO, and
Runtime tray output follow [`brand.md`](./brand.md). Desktop's native first
frame uses `#F7E3D0` for resolved light and `#171714` for resolved night.

UXP maps the panel to light or night from Photoshop's host appearance, keeps
host-owned chrome untouched, and uses the host font because
[UXP does not support packaged `@font-face` files](https://developer.adobe.com/photoshop/uxp/guides/uxp_guide/unsupported/).
The UXP panel preserves the shared control density and Photoshop integration
behavior without introducing a second host-specific visual system. Its
connection indicator uses only the connected treatment for `Connected` and one
shared waiting treatment for every non-ready discovery phase.

## Source Ownership

```text
apps/web/src/styles.css
  Stylesheet import hub only.

apps/web/src/workbench/ui/styles/tokens.css
  Executable design-token values.

apps/web/src/workbench/ui/*.tsx
  Reusable behavioral and accessible primitives.

apps/web/src/workbench/ui/styles/workbench-patterns.css
  Genuinely cross-feature composition patterns.

apps/web/src/workbench/shell/*
  Shared application chrome and floating shell behavior.

apps/web/src/workbench/<feature>/*
apps/web/src/workbench/styles/<feature>.css
  Feature content, feature layout, and intrinsic feature geometry.
```

Features do not use another feature's CSS classes. Reuse moves into `ui` only when independent features share the same role. File size alone does not justify a new abstraction.

## Canvas Exceptions

Canvas may own zoom-scaled handles and hit targets, media preview sizing, editor geometry, annotation colors, node layout, and overlay placement. The terminal emulator may own emulator theme colors. These exceptions do not create alternate buttons, fields, cards, menus, status components, Activity cards, or panel shells.

Canvas feedback bars use the Canvas chrome layer and shared controls. Their size is derived from the visible fixed-size actions, creator, and saved-item row rather than media-specific width buckets. Inside the Bar, the creator and editable Feedback Capsules use one Canvas-owned square technical frame rather than an offset control underlayer: a muted one-pixel idle frame becomes the shared two-pixel focus frame without changing geometry, and video-moment idle frames retain their semantic moment color. Canvas has no persistent node-wide feedback border; feedback kinds remain visible in the editing bar and media annotations.

## Enforcement

Tests cover primitive behavior, page behavior, explicit resource states,
controller request ordering, runtime-event ownership, and floating-shell
composition. Source contracts enforce the single token source, single UI export
surface, feature-style ownership, and absence of a second visual-system root.

Release tests prove that Workbench routes functional icons through one cutout
provider; Debrute-owned surfaces contain no decorative gradients, backdrop blur,
large soft shadows, generic capsules, or runtime-random roughness; and Canvas
and Terminal exceptions remain intact. Static render review covers light and
night at 100% and 125%, narrow and wide supported desktop windows, Desktop first
frame and UXP host appearances.

Visual acceptance checks bilingual truncation and baseline alignment, focus
visibility, semantic color independence, stable content geometry, defined
motion, and texture at ordinary and high-density displays. Automated contrast
checks use rendered state pairs rather than judging palette swatches in
isolation.

The executable UI acceptance contract lives in the release tests. It checks the
actual generic button boundary pairs in both themes and enforces the material,
typography, icon-provider, and host-font boundaries above. Brand asset acceptance
is defined in [`brand.md`](./brand.md#source-and-verification) and
[`releases.md`](./releases.md#product-icon-assets). Live browser diagnostics are
a separately requested workflow under the repository's development rules.
