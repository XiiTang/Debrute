# Repository Guidelines

## Project Structure & Module Organization

Debrute is a pnpm TypeScript monorepo with a Cargo workspace for the Rust Runtime and agent-facing `debrute` CLI. Main apps: `apps/web` Vite/React Workbench, `apps/runtime` Rust Runtime and CLI, `apps/desktop` trayless Electron window host, and `apps/photoshop-*` plugins. Shared TypeScript libraries live in `packages/*`; tests are under `tests/`; colocated TypeScript tests use `*.test.ts` or `*.test.tsx`, and Rust integration tests live under each crate's `tests/`. Public docs live in `docs/`, standard agent skills in `skills/`, and static assets in `assets/`.

## Build, Test, and Development Commands

- `pnpm install` installs the workspace.
- `pnpm doctor` checks local tooling.
- `pnpm dev` starts or reuses the Workbench runtime and prints its launch URL.
- `pnpm dev:electron` starts or attaches Electron to the shared Rust Runtime. Source-development Web is launched by `pnpm dev` or `pnpm dev:electron`; Vite proxies relative Workbench traffic to the exact Runtime origin without a token file or second backend.
- `pnpm check` runs TypeScript project references.
- `pnpm check:rust` checks Rust formatting and runs Clippy with warnings denied.
- `pnpm test` runs the Vitest suite; use `pnpm exec vitest run <file>` for focused tests.
- `pnpm test:rust` runs the Cargo workspace test suite.
- `pnpm lint:arch` validates package boundary rules.
- `pnpm build` builds TypeScript, assets, and desktop output.
- `pnpm verify` runs doctor, type checking, tests, architecture lint, and build.

## Coding Style & Naming Conventions

Use strict TypeScript ESM with `.js` extensions in relative imports that compile to JavaScript. Follow existing formatting: two-space indentation, single quotes, semicolons, `camelCase` functions/variables, `PascalCase` classes/types/components, and `UPPER_SNAKE_CASE` only for true constants. Prefer `@debrute/*` workspace aliases over deep cross-package imports. Keep package boundaries aligned with `packages/architecture-rules`.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts`, `packages/**/*.test.ts`, `apps/**/*.test.ts`, and `apps/**/*.test.tsx`. Add tests near changed behavior or in top-level `tests/` for cross-package contracts. For Canvas performance, interaction, image loading, virtualization, render scheduler, stage DOM write, or trace/debug work, start with:

```bash
pnpm exec vitest run \
  apps/web/src/workbench/canvas/CanvasPerfDebugBridge.test.ts \
  apps/web/src/workbench/canvas/CanvasPerfMonitor.test.ts \
  apps/web/src/workbench/canvas/CanvasPerfBrowserAdapter.test.ts \
  apps/web/src/workbench/canvas/CanvasImageNodeAsset.test.ts \
  apps/web/src/workbench/canvas/CanvasRenderCoordinator.test.ts \
  apps/web/src/workbench/canvas/runtime/CanvasStageRuntime.test.ts \
  apps/web/src/workbench/canvas/CanvasSurface.test.tsx \
  apps/web/src/workbench/canvas/canvasVirtualization.test.ts

pnpm check
```

Do not run real browser tests or diagnostics unless explicitly requested. For requested live Canvas diagnostics, start the development Workbench with `pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf`, use `window.__debruteCanvasPerf.startCapture()` before the interaction and `window.__debruteCanvasPerf.stopCapture()` after it, then inspect `trace.events`, `trace.sessions`, `counterTotals`, and `canvas`.

## Commit & Pull Request Guidelines

Recent history mostly uses `feat:`, `fix:`, and `docs:` prefixes with specific summaries. Keep commits scoped to one logical change. PRs should explain the user-visible change, list verification commands, link issues, and include screenshots for UI, Canvas, Electron, or Photoshop plugin changes.

## Agent skills

### Issue tracker

Work is tracked as synchronized Markdown under `.scratch/work/<feature>/` in a
separate private repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` states. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a multi-context layout rooted at `CONTEXT-MAP.md`, with context-owned `CONTEXT.md` files and ADRs. See `docs/agents/domain.md`.

## Agent-Specific Instructions

This repository is public. Publish durable, source-backed product and technical knowledge through `docs/README.md`, the Context Map and context glossaries, or a qualifying ADR. Current product and technical documentation states the current contract directly; decision history belongs only in a qualifying ADR. Keep implementation plans and working notes under `.scratch/work/`; they are synchronized but disposable workflow state rather than product documentation. Other `.scratch/` content remains local build or tooling state. `debrute-docs-private/` is a separate private Git repository for genuinely sensitive assessments and compact permanent audits, not a parallel product-design knowledge base. Generated file assets are implemented per model, with no provider concept.
