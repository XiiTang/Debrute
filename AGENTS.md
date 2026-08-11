# Repository Guidelines

## Project Structure & Module Organization

Debrute is a pnpm TypeScript monorepo with a Cargo workspace for the Rust Runtime and agent-facing `debrute` CLI. Main apps: `apps/web` Vite/React Workbench, `apps/runtime` Rust Runtime and CLI, `apps/desktop` trayless Electron window host, and `apps/photoshop-*` plugins. Shared TypeScript libraries live in `packages/*`; tests are under `tests/`; colocated TypeScript tests use `*.test.ts` or `*.test.tsx`, and Rust integration tests live under each crate's `tests/`. Public docs live in `docs/`, standard agent skills in `skills/`, and static assets in `assets/`.

## Build, Test, and Development Commands

- `pnpm install` installs the workspace.
- `pnpm doctor` checks local tooling.
- `pnpm dev` starts or reuses the Workbench runtime and prints its launch URL without opening a browser. Open that URL in the browser requested by the user; when none is specified, use the current Agent harness's built-in browser. Use `debrute workbench start [<project>] --frontend browser` only when direct system-default-browser activation is requested.
- `pnpm dev:electron` starts or attaches Electron to the shared Rust Runtime. Source-development Web is launched by `pnpm dev` or `pnpm dev:electron`; Vite proxies relative Workbench traffic to the exact Runtime origin without a token file or second backend.
- `pnpm check` generates the Runtime-owned Control bindings and runs the complete TypeScript project-reference check.
- `pnpm check:rust` checks Rust formatting and runs Clippy with warnings denied for product libraries and binaries.
- `pnpm check:rust:all` runs the exhaustive Rust formatting and all-target Clippy gate, including tests and examples.
- `pnpm test` runs the Vitest suite; use `pnpm exec vitest run <file>` for focused tests.
- `pnpm test:rust` prepares the native raster payload once, runs Runtime tests through pinned cargo-nextest with at most four test processes, then runs the small host-applicable native crates once per Cargo test binary. Runtime integration modules compile into one harness; Windows-only native targets run on Windows.
- `pnpm test:rust:native-watcher` separately verifies the production Project watcher factory and worker against the host operating-system watcher.
- `pnpm lint:arch` validates package boundary rules.
- `pnpm build` independently generates bindings, type-checks, and builds the complete Desktop product output.
- `pnpm verify` is the complete timed repository gate: doctor, one binding generation, one TypeScript check, product-target Clippy, tests, architecture lint, and artifact build.
- `pnpm verify:all` runs that same pipeline with exhaustive all-target Clippy. It is an explicit exhaustive or release gate, not a default handoff step.
- Ordinary GitHub CI supplies the broader macOS and Windows safety net for pull requests and `main`; it does not make either local repository gate an ordinary handoff requirement.

## Coding Style & Naming Conventions

Use strict TypeScript ESM with `.js` extensions in relative imports that compile to JavaScript. Follow existing formatting: two-space indentation, single quotes, semicolons, `camelCase` functions/variables, `PascalCase` classes/types/components, and `UPPER_SNAKE_CASE` only for true constants. Prefer `@debrute/*` workspace aliases over deep cross-package imports. Keep package boundaries aligned with `packages/architecture-rules`.

Rust interfaces use a seven-parameter Clippy threshold as a design signal. When an interface exceeds it, introduce an input type only when that type hides real invariants or gives callers a deeper module; do not create field-for-field parameter bags solely to satisfy Clippy. Intentional exceptions must use function-local `#[expect(clippy::too_many_arguments, reason = "...")]`, never file-level or unreasoned allowances. Function length is reviewed by cohesion, authority, and transaction or state-machine integrity rather than a fixed line count.

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

Use real-browser or Electron diagnostics when the behavior depends on actual layout, loaded fonts, media decoding or playback, browser APIs, window topology, or timing that focused automated tests cannot establish. For live Canvas diagnostics, start the development Workbench with `pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf`, use `window.__debruteCanvasPerf.startCapture()` before the interaction and `window.__debruteCanvasPerf.stopCapture()` after it, then inspect `trace.events`, `trace.sessions`, `counterTotals`, and `canvas`.

During implementation and ordinary handoff, run the smallest affected Vitest files, Cargo targets, type checks, architecture checks, and browser or Electron diagnostics that establish the changed behavior. Committing, merging, pushing, or handing off work does not by itself justify `pnpm verify` or `pnpm verify:all`. Run a repository gate only when the user requests it, the change affects test or build infrastructure or root workspace contracts, the change is genuinely cross-cutting and high-risk, or release work requires it. `build:artifacts` scripts are internal verified-pipeline composition targets; developers and agents use the standalone `pnpm build` command instead.

Run direct Runtime Cargo or nextest commands through `node scripts/run-cargo-with-native-raster.mjs -- ...`; the Runtime build requires the prepared native raster environment. `pnpm doctor` enforces cargo-nextest `0.9.140`. Rust test binaries omit embedded debug information for normal development speed; when a failing test needs debugger-quality symbols, rerun only that focused target with `CARGO_PROFILE_TEST_DEBUG=2`.

Keep each Git worktree's Cargo `target/` independent and do not prewarm new worktrees speculatively. A developer may configure a machine-local `sccache` wrapper with path normalization for each Git root to reuse eligible dependency and compilation results across worktrees; repository commands inherit that standard Cargo setting, but the public development contract does not require or install `sccache`.

## Commit & Pull Request Guidelines

Recent history mostly uses `feat:`, `fix:`, and `docs:` prefixes with specific summaries. Keep commits scoped to one logical change. PRs should explain the user-visible change, list verification commands, link issues, and include screenshots for UI, Canvas, Electron, or Photoshop plugin changes.

## Agent skills

### Domain docs

Domain documentation uses a multi-context layout rooted at `CONTEXT-MAP.md`, with context-owned `CONTEXT.md` files and ADRs. See `docs/agents/domain.md`.

## Agent-Specific Instructions

This repository is public. Publish durable, source-backed product and technical knowledge through `docs/README.md`, the Context Map and context glossaries, or a qualifying ADR. Current product and technical documentation states the current contract directly; decision history belongs only in a qualifying ADR. Keep private assessments, review artifacts, and other disposable local build or tooling state under the ignored `.scratch/` tree; do not use it as a Git repository or synchronized workflow tracker. Generated file assets are implemented per model, with no provider concept.
