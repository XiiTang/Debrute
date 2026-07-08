# Repository Guidelines

## Project Structure & Module Organization

Debrute is a pnpm TypeScript monorepo. Main apps: `apps/web` Vite/React workbench, `apps/daemon` loopback HTTP/SSE runtime, `apps/desktop` Electron shell, `apps/app-server` services, `apps/debrute-cli` agent CLI, `apps/runtime-host` packaged runtime support, and `apps/photoshop-*` plugins. Shared libraries live in `packages/*`; tests are under `tests/`; colocated tests use `*.test.ts` or `*.test.tsx`. Public docs live in `docs/`, standard agent skills in `skills/`, and static assets in `assets/`.

## Build, Test, and Development Commands

- `pnpm install` installs the workspace.
- `pnpm doctor` checks local tooling.
- `pnpm dev` starts or reuses the Workbench runtime and prints its launch URL.
- `pnpm dev:daemon` runs the daemon surface; `pnpm dev:electron` starts or attaches Electron to the shared Workbench runtime. Source-dev Web is launched by `pnpm dev` or `pnpm dev:electron` so the server-side proxy receives the runtime token file.
- `pnpm check` runs TypeScript project references.
- `pnpm test` runs the Vitest suite; use `pnpm exec vitest run <file>` for focused tests.
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

Do not run real browser tests or diagnostics unless explicitly requested. For requested live Canvas diagnostics, use `window.__debruteCanvasPerf.startCapture()` before the interaction and `window.__debruteCanvasPerf.stopCapture()` after it, then inspect `trace.events`, `trace.sessions`, `counterTotals`, and `canvas`.

## Commit & Pull Request Guidelines

Recent history mostly uses `feat:`, `fix:`, and `docs:` prefixes with specific summaries. Keep commits scoped to one logical change. PRs should explain the user-visible change, list verification commands, link issues, and include screenshots for UI, Canvas, Electron, or Photoshop plugin changes.

## Agent-Specific Instructions

This repository is public. Do not place private design docs, implementation plans, notes, or generated Superpowers documents under `docs/`; use `debrute-docs-private/superpowers/specs/YYYY-MM-DD-<topic>-design.md` or `debrute-docs-private/superpowers/plans/YYYY-MM-DD-<feature-name>.md`. `debrute-docs-private/` is a separate private Git repository. Generated file assets are implemented per model, with no provider concept.
