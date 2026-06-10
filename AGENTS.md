# Agent Instructions

This repository is public.

Except for LLM text models, all other generated file assets (images, videos, audio, and similar outputs) are implemented per model, with no provider concept.

Do not create private design docs, implementation plans, notes, or generated Superpowers documents under `docs/`.

When using Superpowers in this project, save generated documents under:

- `debrute-docs-private/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- `debrute-docs-private/superpowers/plans/YYYY-MM-DD-<feature-name>.md`

`debrute-docs-private/` is a separate private Git repository.

For Debrute Canvas performance, interaction, image-loading, virtualization, render scheduler, stage DOM write, or trace/debug work, use the existing focused Canvas tests before broad verification. Run:

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

Prefer `pnpm exec vitest run <files>` over `pnpm test -- <files>` for focused verification.

Do not run real browser tests or real browser diagnostics unless the user explicitly asks for them.

For real browser Canvas diagnostics in a dev/test workbench, use `window.__debruteCanvasPerf.startCapture()` before the interaction and `window.__debruteCanvasPerf.stopCapture()` after it, then inspect `trace.events`, `trace.sessions`, `counterTotals`, and `canvas`.
