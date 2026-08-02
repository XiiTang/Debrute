# Repository Guidelines

## Project Structure & Module Organization

Debrute is a pnpm TypeScript monorepo with a Cargo workspace for the Rust Runtime and agent-facing `debrute` CLI. Main apps: `apps/web` Vite/React Workbench, `apps/runtime` Rust Runtime and CLI, `apps/desktop` trayless Electron window host, and `apps/photoshop-*` plugins. Shared TypeScript libraries live in `packages/*`; tests are under `tests/`; colocated TypeScript tests use `*.test.ts` or `*.test.tsx`, and Rust integration tests live under each crate's `tests/`. Public docs live in `docs/`, standard agent skills in `skills/`, and static assets in `assets/`.

## Build, Test, and Development Commands

- `pnpm install` installs the workspace.
- `pnpm doctor` checks local tooling.
- `pnpm dev` starts or reuses the Workbench runtime and prints its launch URL.
- `pnpm dev:electron` starts or attaches Electron to the shared Rust Runtime. Source-development Web is launched by `pnpm dev` or `pnpm dev:electron`; Vite proxies relative Workbench traffic to the exact Runtime origin without a token file or second backend.
- `pnpm check` generates the Runtime-owned Control bindings and runs the complete TypeScript project-reference check.
- `pnpm check:rust` checks Rust formatting and runs Clippy with warnings denied for product libraries and binaries.
- `pnpm check:rust:all` runs the exhaustive Rust formatting and all-target Clippy gate, including tests and examples.
- `pnpm test` runs the Vitest suite; use `pnpm exec vitest run <file>` for focused tests.
- `pnpm test:rust` prepares the native raster payload once, runs Runtime tests through pinned cargo-nextest with at most four test processes, then runs the small host-applicable native crates once per Cargo test binary. Runtime integration modules compile into one harness; Windows-only native targets run on Windows.
- `pnpm test:rust:native-watcher` separately verifies the production Project watcher factory and worker against the host operating-system watcher.
- `pnpm lint:arch` validates package boundary rules.
- `pnpm build` independently generates bindings, type-checks, and builds the complete Desktop product output.
- `pnpm verify` is the timed daily gate: doctor, one binding generation, one TypeScript check, product-target Clippy, tests, architecture lint, and artifact build.
- `pnpm verify:all` runs that same pipeline with exhaustive all-target Clippy; use it once after review for final handoff and before release work.

## Coding Style & Naming Conventions

Use strict TypeScript ESM with `.js` extensions in relative imports that compile to JavaScript. Follow existing formatting: two-space indentation, single quotes, semicolons, `camelCase` functions/variables, `PascalCase` classes/types/components, and `UPPER_SNAKE_CASE` only for true constants. Prefer `@debrute/*` workspace aliases over deep cross-package imports. Keep package boundaries aligned with `packages/architecture-rules`.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts`, `packages/**/*.test.ts`, `apps/**/*.test.ts`, and `apps/**/*.test.tsx`. Add tests near changed behavior or in top-level `tests/` for cross-package contracts. For Canvas performance, interaction, image loading, viewport culling, render scheduler, stage DOM write, or trace/debug work, start with:

```bash
pnpm exec vitest run \
  apps/web/src/workbench/canvas/CanvasPerfDebugBridge.test.ts \
  apps/web/src/workbench/canvas/CanvasPerfMonitor.test.ts \
  apps/web/src/workbench/canvas/CanvasPerfBrowserAdapter.test.ts \
  apps/web/src/workbench/canvas/CanvasImageNodeAsset.test.ts \
  apps/web/src/workbench/canvas/CanvasResourceZoom.test.ts \
  apps/web/src/workbench/canvas/CanvasPreviewResourceScheduler.test.ts \
  apps/web/src/workbench/canvas/CanvasPreviewScheduling.test.ts \
  apps/web/src/workbench/canvas/CanvasTextPreviewCaptureFlow.dom.test.tsx \
  apps/web/src/workbench/canvas/CanvasTextPreviewRuntime.dom.test.tsx \
  apps/web/src/workbench/canvas/CanvasVideoPreviewRuntime.dom.test.tsx \
  apps/web/src/workbench/canvas/CanvasRenderCoordinator.test.ts \
  apps/web/src/workbench/canvas/CanvasCullingController.test.ts \
  apps/web/src/workbench/canvas/CanvasRenderLifecycle.dom.test.ts \
  apps/web/src/workbench/canvas/runtime/CanvasStageRuntime.test.ts \
  apps/web/src/workbench/canvas/CanvasSurface.dom.test.tsx \
  apps/web/src/workbench/canvas/canvasViewport.test.ts

pnpm check
```

Do not run real browser tests or diagnostics unless explicitly requested. For requested live Canvas diagnostics, start the development Workbench with `pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf`, use `window.__debruteCanvasPerf.startCapture()` before the interaction and `window.__debruteCanvasPerf.stopCapture()` after it, then inspect `trace.events`, `trace.sessions`, `counterTotals`, and `canvas`.

During implementation, run the smallest affected Vitest files, Cargo targets, and type checks. Complete code review before the final whole-repository gate, then run `pnpm verify:all` once. `build:artifacts` scripts are internal verified-pipeline composition targets; developers and agents use the standalone `pnpm build` command instead.

Run direct Runtime Cargo or nextest commands through `node scripts/run-cargo-with-native-raster.mjs -- ...`; the Runtime build requires the prepared native raster environment. `pnpm doctor` enforces cargo-nextest `0.9.140`. Rust test binaries omit embedded debug information for normal development speed; when a failing test needs debugger-quality symbols, rerun only that focused target with `CARGO_PROFILE_TEST_DEBUG=2`.

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
