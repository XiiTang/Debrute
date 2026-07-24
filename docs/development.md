# Development

This page keeps the project and development details out of the public README.

## Workspace And Toolchain Contract

Debrute is a pnpm workspace whose package roots are `apps/*` and `packages/*`.
The root `package.json` pins `pnpm@11.2.2`, requires Node.js 24 and pnpm 11, and
workspace packages declare internal dependencies with `workspace:*` references.
`pnpm-workspace.yaml` is the source of truth for supported build architectures,
narrow transitive overrides, and the packages allowed to run native or binary
install scripts. `pnpm-lock.yaml` is the only dependency lockfile.

`pnpm doctor` checks the current development environment: exact Node major,
supported pnpm range, workspace install, Desktop source files, and required
Desktop build dependencies. It does not detect or manage optional user media
integrations. Product integration installation is owned by the integration
catalog and its fixed backends, not by a generic Toolchain or Tools Settings
subsystem.

Exact dependency versions live in package manifests and the lockfile, not in a
historical upgrade guide. Current build contracts that depend on those versions
remain executable:

- Web and Photoshop Vite builds emit license artifacts; Photoshop configs use
  `build.rolldownOptions` for their fixed output contract.
- Canvas raster services validate supported Project image types and decoded
  metadata through the Runtime-owned Raster Preview Engine; product packaging
  copies and validates the checksum-pinned `rs-vips` 0.7.0/libvips 8.18.4
  native payload for each supported macOS and Windows target.
- the inline Canvas text editor uses the current CodeMirror stack while durable
  scroll position remains the Canvas-owned Text Viewport described in
  [`text-files.md`](./text-files.md);
- Workbench applies its repository-owned Lucide policy and accessibility rules
  described in [`workbench.md`](./workbench.md);
- CLI and Photoshop packaging validate the generated payload or archive after
  writing it.

`pnpm verify:browser` is an explicit development diagnostic and is not part of
`pnpm verify`. Run it only when live browser verification is intentionally in
scope.

## Repository Layout

- `apps/web` - Vite/React browser Workbench. It uses Runtime HTTP, SSE, and WebSocket transports.
- `apps/desktop` - trayless Electron window host for native windows, menus, folder picking, and Product packaging.
- `apps/runtime` - single-process Rust Runtime, native tray, Control/Workbench/Photoshop transports, domain services, Product updater, and external Agent-facing `debrute` CLI.
- `apps/photoshop-uxp-plugin` - Photoshop UXP plugin surface.
- `apps/photoshop-cep-plugin` - Photoshop CEP plugin surface.
- `packages/project-core` - project identity, `.debrute/` path conventions, atomic JSON persistence, project text/binary file access, and file event normalization.
- `packages/canvas-map-core` - Canvas Map YAML parsing, path and row rule expansion, and file-tree node derivation.
- `packages/canvas-core` - Canvas documents, projected node state, derived structure edges, selection, viewport, diagnostics, and node layout operations.
- `packages/capability-core` - result and artifact value shapes shared by Debrute runtime services.
- `packages/app-protocol` - protocol types shared across the app boundary.
- `packages/runtime-control-client` - TypeScript native Control transport used by Desktop and development launchers.
- `packages/photoshop-bridge-plugin-core` - shared Photoshop bridge plugin logic.
- `packages/architecture-rules` - repository architecture lint rules.
- `skills/debrute-*` - Debrute-managed standard Skills packages for external Agents.

## Architecture Governance

`packages/architecture-rules` is the single executable source for structural
dependency rules. `scripts/check-architecture.mjs` and the architecture contract
tests call the same scanner, so command-line lint and test expectations cannot
drift into separate rule sets. Rules resolve relative imports before matching
and inspect imports, exported declarations, package dependencies, TypeScript
references, Vite aliases, and selected public barrels. They enforce current
ownership rather than maintaining a denylist of retired names.

The principal dependency directions are:

- domain and runtime packages do not import application implementations;
- `app-protocol` owns cross-application shapes without Node, React,
  orchestration, or capability execution;
- Project, Canvas Map, Canvas, and Capability core packages stay independent of
  application and renderer layers;
- Web Workbench is browser-safe and does not import capability execution,
  Electron, or production Node filesystem APIs;
- Electron remains a native host and Control client rather than a backend or
  domain service host; and
- authoritative Runtime and CLI Project semantics remain in Rust instead of
  being duplicated in TypeScript application packages.

## Current-State Contract

Debrute is prelaunch, so internal persisted documents and implementation APIs
describe one current shape. Removed fields, paths, services, command aliases,
and UI state do not receive compatibility readers, migrations, fallback success
paths, transitional re-exports, or dedicated historical rejectors. Invalid
current data fails its owning current-shape validation.

Internal Project documents and runtime state therefore do not carry a generic
`schemaVersion` merely to support old internal formats. Explicitly exchanged or
distributed contracts may remain versioned when the version is part of their
current trust or interoperability boundary: product payload/update manifests,
Adobe Bridge discovery, package and host versions, release tags, and third-party
protocols are examples.

Negative tests remain appropriate for current security, ownership, and public
contract invariants. They are not kept solely as a museum of removed
implementation names. Current fallback and error-isolation behavior belongs at
the narrow owning boundary: for example, optional cache absence and diagnostic
API failure may be isolated, while security, persistence, and required-input
errors remain visible.

Cross-surface trust boundaries are documented in
[`security.md`](./security.md). Local test classification, scheduling,
performance, and resource ownership are documented in
[`testing.md`](./testing.md).

## Project State And Documents

Runtime owns Project identity, path safety, visible file operations, and
`.debrute/project.json` through `apps/runtime/src/project/`. The descriptor list
in `documents.rs` is the executable authority for structured document roles,
path patterns, and allowed service writers. The TypeScript core packages retain
browser-facing value shapes and pure renderer algorithms, not persistence
authority.

Service-owned multi-document writes use the Project Document transaction
boundary. It validates registered owners and participant hashes, acquires
document locks, stages writes, and restores previous content when an ordinary
commit fails. Generic Project Tree mutations cannot modify protected
`.debrute/` state. Revisioned text saves may edit visible Project Documents;
the normal snapshot pipeline then exposes invalid source or pushed content as
diagnostics instead of silently repairing it.

Project snapshots aggregate metadata, visible files, Canvas documents and
projections, diagnostics, Canvas registry state, and health. Workbench protocol
views omit the absolute Project root. Shared-state mutations are serialized and
validated by their owning Runtime service. Commands return outcomes, while
ordered Project events carry the monotonic `projectRevision` and authoritative
state. Text Working Copies keep a file-specific `baseRevision` only to describe
the source value from which an unsaved buffer was created; it is not a
Project-wide optimistic write lock. `project status` uses the read-only snapshot
mode; interactive Project sessions use push mode.

## Runtime Architecture

The shared local runtime, browser trust boundary, global configuration
ownership, project-session lifecycle, multi-window rules, terminal lifecycle,
and product-version ownership are documented in
[`runtime-architecture.md`](./runtime-architecture.md). That document points to
the current executable authorities for each contract.

Electron window, preload, menu, and native-file-operation boundaries are
documented in [`desktop-shell.md`](./desktop-shell.md). Runtime-owned optional
tool detection and operations are documented in
[`integrations.md`](./integrations.md). The shared Adobe Bridge protocol and its
UXP and CEP adapters are documented in
[`photoshop-bridge.md`](./photoshop-bridge.md).

## Workbench Front-End

The current UI source hierarchy, shell and layer ownership, asynchronous state
boundaries, Settings composition, theme and language flow, Explorer interaction
model, and shared context-menu behavior are documented in
[`workbench.md`](./workbench.md). Durable visual rules remain in the root
[`DESIGN.md`](../DESIGN.md); exact token values and component behavior remain
source-owned.

## Canvas

The Canvas source/pushed/projection split, registry and identity rules,
membership expansion, automatic and manual layout, stack order, and transient
Workbench interaction model are documented in [`canvas.md`](./canvas.md).
Rendering, virtualization, image preview resources, cache reconciliation, and
development-only performance diagnostics are documented in
[`canvas-rendering.md`](./canvas-rendering.md).
Project text access, Workbench buffer saves, CodeMirror, persisted Canvas text
scroll state, and text-preview capture are documented in
[`text-files.md`](./text-files.md).
Exact document and algorithm behavior remains in Runtime Project services,
Canvas Core, Canvas Map Core, and the Workbench Canvas runtime.

## Commands

```sh
pnpm install
pnpm doctor
pnpm check
pnpm test
pnpm lint:arch
pnpm build
pnpm verify
pnpm pack
pnpm dist
pnpm dev
pnpm dev:electron
pnpm preview
pnpm clean
node scripts/run-cargo-with-native-raster.mjs -- run -p debrute-runtime --bin debrute -- project validate path/to/project
```

`pnpm doctor` checks the local Node/pnpm/tooling surface needed for development and macOS packaging. `pnpm verify` runs doctor, type checking, tests, architecture lint, and the production build.

`pnpm dev` starts or reuses the shared Rust Runtime, starts Vite, and prints the
browser Workbench URL. Opening it creates a fresh POST SSE Workbench connection.
Runtime owns the native macOS or Windows tray and remains running when the
browser closes. Use the tray's **Quit Debrute** command or `debrute runtime stop`
when an explicit Product Quit is required.

The development launcher prepares the target's repository-locked upstream
libvips archive before building Runtime and uses the same normalized library
layout as the Product seed. It does not require or discover a Homebrew or system
libvips installation. A missing download, checksum mismatch, link failure, or
Runtime version mismatch stops the launch with the native-payload diagnostic;
there is no alternate development backend.

`pnpm dev:electron` uses the same native Control endpoint, so it attaches to the existing Runtime instead of starting a competing backend.
On macOS the development scripts ad-hoc sign the freshly assembled Runtime app
and, only when its downloaded signature is not accepted by the host, the
unpacked Electron app with the repository's development entitlements. This is
local LaunchServices preparation for the real `.app` processes; Product and
release artifacts still use the release signing pipeline and are never
accepted on the strength of the development signature.

One Runtime can host multiple live Project sessions. The stable public Project
id comes only from `.debrute/project.json.project.id`; Runtime maps recent ids to
canonical roots and rejects duplicates. Browser tabs and Electron windows have
one live Workbench connection and at most one bound Project. Interactive users
open Projects with the Workbench `Open Project` action, which asks Runtime to
present the native directory picker. Agents and automation open an explicit
absolute path with `debrute workbench start <project> --frontend browser`; the
command sends a native Control activation and never prints an authentication
URL. The root Workbench route does not reopen the last Project.

`pnpm preview` serves the production Web build for smoke testing after `pnpm build`. `pnpm clean` removes generated build, release, and TypeScript build-info files.

`node scripts/run-cargo-with-native-raster.mjs -- build -p debrute-runtime --bin debrute`
builds the current-platform CLI against the locked native payload. Product
assembly signs and declares that binary together with Runtime, Web assets,
Skills, and model documentation.

`pnpm pack` creates an unpacked desktop app under `apps/desktop/release/`. `pnpm dist` creates distributable Desktop artifacts when run on the matching platform.

Packaged Desktop product assets are published from the public `XiiTang/Debrute` GitHub repository.

macOS and Windows are the product targets. Linux packaging is an incidental
best-effort distribution and is not a design, implementation, updater, or
acceptance target.
