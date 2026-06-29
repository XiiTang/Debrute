# Development

This page keeps the project and development details out of the public README.

## Repository Layout

- `apps/web` - Vite/React browser workbench. It talks to the daemon through HTTP and SSE.
- `apps/daemon` - loopback HTTP/SSE runtime that serves the Web workbench and owns privileged project, Canvas, settings, and generated asset operations.
- `apps/desktop` - optional Electron shell for native folder picking, menus, packaging, and loading the Web workbench URL.
- `apps/app-server` - local domain service boundary for project sessions, Canvas Map pushing and sync, Canvas node projection, model settings, generated asset metadata, and explicit CLI service methods.
- `apps/debrute-cli` - external Agent interface for invoking Debrute capabilities with structured output.
- `apps/runtime-host` - runtime host bundle used by packaged CLI and runtime flows.
- `apps/photoshop-uxp-plugin` - Photoshop UXP plugin surface.
- `apps/photoshop-cep-plugin` - Photoshop CEP plugin surface.
- `packages/project-core` - project identity, `.debrute/` path conventions, atomic JSON persistence, project text/binary file access, and file event normalization.
- `packages/canvas-map-core` - Canvas Map YAML parsing, path and row rule expansion, and file-tree node derivation.
- `packages/canvas-core` - Canvas documents, projected node state, derived structure edges, selection, viewport, diagnostics, and node layout operations.
- `packages/capability-core` - result and artifact value shapes shared by Debrute runtime services.
- `packages/capability-runtime` - model catalogs, model executors, generation model settings, and Skills registry code.
- `packages/workbench-runtime` - shared local Workbench runtime discovery, locking, process control, and state.
- `packages/app-protocol` - protocol types shared across the app boundary.
- `packages/photoshop-bridge-plugin-core` - shared Photoshop bridge plugin logic.
- `packages/architecture-rules` - repository architecture lint rules.
- `skills/debrute-*` - Debrute-managed standard Skills packages for external Agents.

## Commands

```sh
pnpm install
pnpm doctor
pnpm check
pnpm test
pnpm lint:arch
pnpm build
pnpm package:runtime-cli
pnpm verify
pnpm pack
pnpm dist
pnpm dev
pnpm dev:electron
pnpm preview
pnpm clean
pnpm exec tsx apps/debrute-cli/src/index.ts project validate path/to/project
```

`pnpm doctor` checks the local Node/pnpm/tooling surface needed for development and macOS packaging. `pnpm verify` runs doctor, type checking, tests, architecture lint, and the production build.

`pnpm dev` starts or reuses the shared local Workbench runtime and prints the Web URL. It prefers daemon port `17321` and Web port `17322` when they are free, but they are not required ports. The Web workbench is the primary product surface and can be opened directly in a normal browser.

`pnpm dev:electron` participates in the same runtime registry, so it attaches to an existing healthy daemon/Web pair instead of starting a competing one.

One daemon can host multiple live project sessions, and browser tabs or Electron windows connected to that daemon attach to `/projects/:projectId` routes with daemon-issued opaque project ids. Interactive users open projects with the Workbench `Open Project` action, which asks the local runtime daemon to present the native directory picker. Agents and automation can open an explicit absolute path through `/open?path=<encoded-absolute-local-path>`. The root workbench route does not reopen the last project.

`pnpm preview` serves the production Web build for smoke testing after `pnpm build`. `pnpm clean` removes generated build, release, and TypeScript build-info files.

`pnpm package:runtime-cli` creates the current-platform managed CLI payload used inside the Desktop runtime product bundle.

`pnpm pack` creates an unpacked desktop app under `apps/desktop/release/`. `pnpm dist` creates distributable Desktop artifacts when run on the matching platform.

Packaged Desktop product assets are published from the public `XiiTang/Debrute` GitHub repository.
