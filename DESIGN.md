---
version: alpha
name: Debrute Front-End Design System
description: Project-level front-end design constraints for Debrute.
colors:
  dark:
    canvas: "#181818"
    surface-1: "#1f1f1f"
    surface-2: "#262626"
    surface-3: "#303030"
    terminal: "#0c0e10"
    text: "#ffffff"
    border: "#3a3a3a"
    selection: "#ffffff"
  light:
    canvas: "#eef0f3"
    surface-1: "#ffffff"
    surface-2: "#eef0f3"
    surface-3: "#e2e5e9"
    terminal: "#f8f9fb"
    text: "#111827"
    border: "#c9cdd3"
    selection: "#111827"
  warning: "semantic state token"
  danger: "semantic state token"
  info: "semantic state token"
  success: "semantic state token"
typography:
  ui-xs:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  ui-sm:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  ui-md:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  ui-lg:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: 0
spacing:
  1: 4px
  2: 6px
  3: 8px
  4: 10px
  5: 12px
  6: 14px
  7: 16px
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  pill: 9999px
components:
  control-xs:
    height: 24px
  control-sm:
    height: 28px
  control-md:
    height: 32px
  button-default:
    height: "{components.control-md.height}"
    rounded: "{rounded.md}"
  icon-button:
    size: "{components.control-md.height}"
    rounded: "{rounded.md}"
  input:
    height: "{components.control-sm.height}"
    rounded: "{rounded.md}"
  panel:
    rounded: "{rounded.lg}"
  card:
    rounded: "{rounded.lg}"
---

# Debrute Front-End Design System

## Overview

Debrute is a browser-first local creative production workbench. Its UI should feel like a durable creative tool: a theme-aware compact creative production workbench built for repeated daily use. It should not look like a marketing site, a generic SaaS dashboard, or an enterprise admin surface.

The main product chrome follows the restraint of Raycast and Linear: neutral surface ladder, 1px hairlines, compact controls, very little color, and the product UI itself as the visual subject. Canvas and creative-object surfaces borrow the object clarity of Miro and Figma: nodes, selections, feedback marks, previews, and review state can use stronger affordances than ordinary panel chrome.

These references guide method, not brand imitation. Debrute does not adopt Raycast red stripes, Linear lavender, Miro marketing yellow, Figma color blocks, large landing-page typography, or decorative gradients.

## Colors

The core palette is a neutral theme-aware surface ladder:

```text
canvas -> surface-1 -> surface-2 -> surface-3
```

Dark theme keeps the original Debrute neutral ladder:

```text
dark.canvas: "#181818"
dark.surface-1: "#1f1f1f"
dark.surface-2: "#262626"
dark.surface-3: "#303030"
dark.terminal: "#0c0e10"
dark.text: "#ffffff"
dark.border: "#3a3a3a"
dark.selection: "#ffffff"
```

Light theme uses the same roles with light neutral values:

```text
light.canvas: "#eef0f3"
light.surface-1: "#ffffff"
light.surface-2: "#eef0f3"
light.surface-3: "#e2e5e9"
light.terminal: "#f8f9fb"
light.text: "#111827"
light.border: "#c9cdd3"
light.selection: "#111827"
```

The implementation maps this ladder to `--db-*` tokens in `apps/web/src/workbench/ui/styles/tokens.css`. General product chrome uses neutral surfaces, text hierarchy, borders, selection, and semantic tones.

- Use `canvas` for application and Canvas viewport foundations.
- Use `surface-1`, `surface-2`, and `surface-3` for panel, control, hover, and active layers.
- Use `terminal` only for the Terminal tab row and emulator background when they need a Zed-like work-surface distinction from ordinary panels.
- Use 1px borders as the default hierarchy mechanism.
- Use `selection` for selected, pressed, and focus-associated states.
- Use warning, danger, info, and success only for semantic state.
- Do not add a project-wide accent color for ordinary button chrome.
- Do not use decorative gradients, orbs, bokeh, or atmospheric backgrounds.
- Keep creative-object colors scoped to Canvas objects, feedback marks, media annotations, and review affordances.

## Typography

Debrute uses one compact sans UI voice for product chrome:

```text
Inter -> ui-sans-serif -> system UI stack
```

- `ui-md` at 13px is the default Workbench UI size.
- `ui-sm` at 12px is used for dense toolbars, tree rows, tabs, labels, and metadata.
- `ui-xs` at 11px is reserved for secondary metadata and compact status text.
- `ui-lg` at 15px is rare and only used for important scan targets, such as empty-state headings, primary object labels, and settings group titles.
- Letter spacing is 0 for normal UI.
- Do not use viewport-scaled type, landing-page hero type, serif display faces, or decorative type treatments in product surfaces.
- Terminal, code editor, and text-editor surfaces may use specialized mono or editor fonts, but their surrounding chrome remains Debrute UI.

## Layout

Debrute layout is dense but scannable.

- Standard Workbench controls use 24px, 28px, or 32px heights.
- Floating Workbench panels render a compact low-contrast title inside their 18px top interaction band. The band stays transparent, owns the panel drag and top-edge resize interactions, and separates the scrollable feature body from the panel top edge without rendering a visible strip, divider, or header row.
- Titlebar chrome stays compact, generally around 32px.
- Panel padding generally stays between 8px and 14px.
- Repeated cards or settings form groups may use 16px padding when scanability requires it.
- Avoid page sections styled as floating cards.
- Avoid nested card layouts.
- Settings, Inspector, Terminal, and Explorer are work surfaces, not marketing sections.
- Photoshop bridge plugins must work in narrow host panels without overflow.

## Elevation & Depth

Depth is built from tonal layers, hairline borders, transparent floating surfaces, blur where it serves legibility, and a small shadow vocabulary.

- Normal panels and cards use surface color plus 1px border.
- Menus, context menus, floating bars, detached panels, and detached text editor windows may use compact shadows.
- Ordinary cards do not use heavy drop shadows.
- Titlebar blur and floating-surface blur are functional hierarchy, not a glass visual theme.
- Canvas overlays may use high-contrast halo or outline treatments when they sit on top of media.

## Shapes

Debrute uses small-radius product chrome.

- Standard controls use 4px or 6px radius.
- Cards, panels, and floating bars use 8px radius at most.
- Pills are reserved for status, badges, compact filters, and comment entry affordances.
- Do not introduce 12px, 16px, or 24px card rounding for general product chrome.
- Canvas handles, pins, badges, and resize affordances may be circular when that shape communicates manipulation.

## Components

The existing Workbench UI package is the component authority:

```text
apps/web/src/workbench/ui/
  Button.tsx
  IconButton.tsx
  CloseButton.tsx
  Field.tsx
  Input.tsx
  Select.tsx
  Textarea.tsx
  Switch.tsx
  Card.tsx
  Panel.tsx
  Toolbar.tsx
  Menu.tsx
  Tabs.tsx
  StatusPill.tsx
  EmptyState.tsx
  cx.ts
  index.ts
```

- Repeated controls use these primitives.
- Repeated structures use `workbench-patterns.css`.
- Component family comes first: components with the same role use the same primitive or named pattern.
- Components in the same family share size, spacing, radius, surface, border, shadow, text, icon, hover, pressed, disabled, and focus rules.
- Allowed component-family differences are limited to semantic state, established size tiers, placement geometry, content constraints, and narrow Canvas/media visibility needs.
- Icon-only buttons require accessible labels.
- Status UI uses `StatusPill` or a named pattern.
- Quiet successful/default states should not be persistently rendered as green success badges.
- Cards are for repeated items, local tool surfaces, and notifications. They do not wrap full pages or ordinary layout sections.

## Front-End Surfaces

### Workbench

`apps/web` is the primary execution surface. It must follow `DESIGN.md` most strictly.

- `apps/web/src/styles.css` remains an import hub.
- `apps/web/src/workbench/ui/styles/tokens.css` implements the root token language using `--db-*`.
- `apps/web/src/workbench/ui/styles/workbench-patterns.css` owns reusable Workbench structures.
- `apps/web/src/workbench/styles/*.css` owns feature placement, layout, Canvas geometry, and surface-specific rendering.
- Feature CSS does not define a second button, icon-button, input, card, menu, panel, status, floating-bar, notification, terminal-tab, nav-row, diagnostic-row, Canvas-node, or Canvas overlay chrome system.

Workbench floating panels use one shared shell for Explorer, Inspector, Problems, Settings, and Terminal.

- The shared shell owns placement, dimensions, z-index, the transparent drag hit area, close button placement, eight-direction resize hit areas, body container, and overflow mode.
- The shared shell owns each floating panel's continuous background surface through the panel content background token; feature content must not paint an alternate panel-wide background or decorative gradient.
- Floating panel names such as `Explorer`, `Inspector`, `Problems`, `Settings`, and `Terminal` render as compact low-contrast text at the top-left of the shared drag area.
- The 18px top interaction band is transparent interaction chrome: no visible background, border, divider, or header row. Its top 4px is the north resize hit area; the remaining area is the panel drag target.
- Feature content starts below the drag hit area so scrollable content cannot cover the only drag target.
- Floating panel and Terminal tab close controls share the same compact 14px borderless circular `CloseButton` primitive; each surface owns only placement.
- Floating panels resize from any edge or corner. All resize hit areas are invisible; no single corner owns a special visual grip.
- Feature content remains owned by the feature surface.
- Explorer uses faint always-visible indentation guides for nested tree levels.
- Terminal keeps the ordinary floating panel shell background, then uses a darker neutral `terminal` surface only for the drag-hit-area tab row and emulator content. Its compact tab strip starts to the right of the `Terminal` title, uses no rounded active pill, marks the active tab with text emphasis and a thin bottom line, and keeps the new-terminal button flat immediately after the tab strip rather than pinned to the far panel edge.
- Terminal has no restart feature in the UI, Workbench API, daemon routes, app-server facade, service layer, or terminal session view model.

### Desktop

`apps/desktop` is the native host for Workbench. It does not define a second UI system.

- BrowserWindow background matches the active Workbench theme base closely enough to avoid a visible alternate theme during loading.
- Native menu, tray, app update, and shell behavior use platform UI where appropriate.
- Desktop code does not add a separate React/CSS component system.

### Photoshop UXP Plugin

The UXP plugin is a compact Adobe-hosted bridge panel.

- The UI uses Adobe host variables where they exist.
- Layout, control density, status semantics, and hierarchy follow Debrute.
- Buttons, selection cards, drop targets, project actions, and errors have named classes with clear visual roles.
- The panel stays narrow, dense, and low-decoration.

### Photoshop CEP Plugin

The CEP plugin is a compact host panel with Debrute-compatible CSS variables.

- Base background, text, border, error, and focus colors are named through local CSS custom properties that mirror Debrute semantics.
- Button, selection-card, drop-target, project-action, and error styles are explicit and role-based.
- The plugin does not depend on unstructured hard-coded base chrome values.

### Canvas

Canvas is both a Workbench surface and a creative object space. It has stricter runtime needs than ordinary chrome.

- Canvas chrome uses Debrute primitives and patterns.
- Canvas fixed lower-left overlay controls use Canvas control patterns without floating-bar surface, border, shadow, or backdrop treatment.
- Canvas floating overlay containers use shared floating-bar chrome only when they render panel-like content, such as feedback or an expanded minimap panel.
- Canvas floating feedback bars size themselves from visible fixed-size controls, fixed row geometry, a 110px comment creator, and 3px container padding. They do not use media-type width buckets.
- Canvas feedback comment creators use compact rounded-rectangle inputs. Saved feedback item chips may remain pill-shaped.
- Fixed lower-left Canvas overlays align their first control to the top-left floating dock's 18px horizontal inset, sit 14px above the bottom edge, and use the top-left dock's compact 4px gap between adjacent fixed controls, including the Canvas card-to-add-canvas control gap.
- Canvas feature CSS owns overlay placement and intrinsic Canvas geometry only; it does not define per-control background, border, shadow, backdrop, hover, pressed, or disabled chrome.
- Canvas content can define local geometry for zoom, hit targets, resize handles, node dimensions, media previews, and overlay alignment.
- Canvas node feedback frames are single-color feedback-presence borders. Feedback type details belong in the floating feedback bar and annotation layers, not in frame colors.
- Selection, handles, region feedback, pins, and annotation overlays may use high-contrast local treatments when needed for media visibility.
- Canvas-specific values are named by purpose when they represent reusable Canvas UI, and kept local when they are intrinsic rendering math.

### Runtime Host and CLI

Runtime host and CLI-only code are not front-end UI surfaces. They are covered only when they render user-visible Web or desktop UI.

## Source Ownership

Final ownership:

```text
DESIGN.md
  Project-level front-end design contract.

apps/web/src/workbench/ui/styles/tokens.css
  Workbench token implementation.

apps/web/src/workbench/ui/*.tsx
  Reusable primitive controls.

apps/web/src/workbench/ui/styles/workbench-patterns.css
  Reusable Workbench structures.

apps/web/src/workbench/shell/*
  Shared Workbench floating panel shell, floating dock, panel layout, and panel window ordering.

apps/web/src/workbench/styles/*.css
  Feature layout, placement, and surface-specific rendering.

apps/photoshop-uxp-plugin/src/styles.css
  UXP host panel styling with Debrute density and semantics.

apps/photoshop-cep-plugin/src/styles.css
  CEP host panel styling with Debrute-compatible CSS variables.

apps/desktop/src/electron/*
  Native host behavior for Workbench.
```

No other front-end source should become a new visual-system root.

## Canvas Exceptions

Canvas exceptions are intentional and narrow:

- zoom-scaled handles and hit targets
- media preview sizing and aspect-ratio behavior
- image, video, audio, text, and unknown-media preview rendering
- feedback rendered-image SVG annotation colors
- terminal emulator theme colors inside the emulator
- Adobe host-provided variables inside UXP
- native Electron, tray, and menu platform surfaces

Canvas exceptions do not allow feature-owned reusable product chrome or local overrides that add or restore floating-bar surface, border, shadow, or backdrop treatment for fixed lower-left controls.

## Do's and Don'ts

Do:

- Use the active neutral surface ladder for product chrome.
- Keep controls compact.
- Use 1px borders as the primary hierarchy mechanism.
- Keep Canvas object affordances clear and visible over media.
- Use semantic colors only for semantic state.
- Keep root `DESIGN.md` and `tokens.css` conceptually aligned.
- Use source-contract tests to enforce current ownership boundaries.

Don't:

- Do not create another component library.
- Do not introduce Tailwind, shadcn, Ant Design, MUI, Chakra, Mantine, Fluent, Bootstrap, or another full visual UI library as the Workbench foundation.
- Do not create compatibility layers for old chrome.
- Do not add transitional class aliases.
- Do not keep obsolete UI paths.
- Do not keep obsolete Terminal restart protocol, route, service, state, UI, or test paths.
- Do not use historical blacklist tests as the main enforcement model.
- Do not make ordinary Workbench screens look like marketing pages.
- Do not spread Canvas feedback colors into general panel chrome.
- Do not add per-surface `DESIGN.md` files in this version.

## Iteration Guide

When adding or changing front-end UI:

1. Start from root `DESIGN.md`.
2. Use an existing token, primitive, or pattern when the UI is repeated chrome.
3. Add a token only when the value has project-level or repeated surface value.
4. Add a pattern only when the structure repeats across features.
5. Keep feature CSS local to layout, placement, Canvas geometry, media rendering, and host-specific constraints.
6. Prefer positive source-contract tests that assert the final source shape.

## Enforcement

Enforcement is source-level and test-level in this version. Real browser visual diagnostics are not part of this specification.

Required final contracts:

- Root `DESIGN.md` exists.
- `DESIGN.md` contains canonical token frontmatter and Debrute-specific source ownership sections.
- `apps/web/src/workbench/ui/styles/tokens.css` exposes the Workbench token families required by `DESIGN.md`.
- `apps/web/src/workbench/ui/index.ts` remains the primitive export surface.
- `workbench-patterns.css` owns reusable Workbench structures.
- Feature CSS does not define reusable product chrome systems.
- Photoshop plugin CSS uses named semantic roles for base chrome and states.
- Desktop does not add a second front-end visual system.

Required tests:

- Root design contract test for `DESIGN.md` existence and required sections.
- Workbench token contract test for current token families.
- UI primitive export contract test.
- Pattern ownership contract test.
- Photoshop plugin style contract test for named role variables and classes.
