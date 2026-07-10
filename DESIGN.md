---
version: alpha
name: Debrute Front-End Design System
description: Project-level front-end design constraints for Debrute.
tokenSource: apps/web/src/workbench/ui/styles/tokens.css
---

# Debrute Front-End Design System

## Overview

Debrute is a browser-first local creative production workbench for browser and Electron pointer-and-keyboard environments. The UI is compact, neutral, theme-aware, and built for repeated daily use. Phone and touch-first layouts are outside the product contract.

## Product Language

Workbench chrome uses neutral surfaces, 1px hierarchy, restrained shadows, small radii, dense controls, and one compact sans-serif UI voice. Product chrome is not a marketing site, dashboard card grid, or decorative glass surface. Semantic color communicates warning, danger, information, or an explicit completed operation. Quiet ready, connected, configured, selected, and up-to-date states are neutral.

Canvas objects and media annotations may use stronger local affordances when required for visibility over creative content. Those affordances do not define general product chrome.

## Token Semantics

`apps/web/src/workbench/ui/styles/tokens.css` is the only executable source for theme surfaces, text hierarchy, borders, semantic tones, spacing, typography sizes, radii, control sizes, shadows, motion, focus treatment, and z-index roles.

Feature styles consume `--db-*` tokens. A local custom property is valid only for intrinsic geometry or a domain-specific value that is not reusable product chrome.

## Component Model

`apps/web/src/workbench/ui/index.ts` is the only public primitive export surface. Primitives own size and visual variants, interaction states, accessibility, icon alignment, theme behavior, and control geometry. Feature classes may position primitives, but they do not redefine primitive chrome.

Shared layout without behavior stays a named CSS pattern. A React component exists only when it owns behavior, accessibility, or repeated markup with a stable semantic interface. A pattern is shared only when independent Workbench features use the same role. Cards represent independent repeated entities or local tool surfaces; they do not wrap pages or ordinary settings groups.

## Workbench Surfaces

The Workbench uses one Canvas and floating-panel interaction model. `FloatingPanel` owns drag and resize geometry, placement, z-order, close placement, continuous background, and body overflow. The shell renders each panel name once.

Settings uses grouped General, Models, and Integrations navigation, one title per selected page, explicit loading/error/ready content, ordinary sections for General settings, and cards only for independent repeated records.

Explorer owns tree geometry and editing. Inspector owns selection properties, metadata, and diagnostics. Terminal owns terminal tabs, sessions, status, and emulator geometry. Project Open owns one focused empty-state entry. Canvas owns node geometry, media presentation, annotations, handles, feedback, and overlay placement.

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

Canvas may own zoom-scaled handles and hit targets, media preview sizing, editor geometry, annotation colors, node layout, and overlay placement. The terminal emulator may own emulator theme colors. These exceptions do not create alternate buttons, fields, cards, menus, status components, notifications, or panel shells.

## Enforcement

Tests cover primitive behavior, page behavior, explicit resource states, controller request ordering, runtime-event ownership, and floating-shell composition. Source contracts enforce the single token source, single UI export surface, feature-style ownership, and absence of a second visual-system root. Tests do not preserve private source strings, exact pixel recipes, removed names, or historical implementation knowledge.
