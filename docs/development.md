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
subsystem. macOS and Windows pass the closed host-platform check; Linux and
other hosts fail explicitly because they have no current source-development or
Product build contract.

Exact dependency versions live in package manifests and the lockfile, not in a
historical upgrade guide. Current build contracts that depend on those versions
remain executable:

- Web and Photoshop Vite builds emit license artifacts; Photoshop configs use
  `build.rolldownOptions` for their fixed output contract.
- Each macOS or Windows Product build injects its closed `darwin` or `win32`
  Workbench constant into that target's Web assets. Source development injects
  the current supported host. Web code does not inspect browser platform or
  User-Agent values, and another host fails the entrypoint rather than compiling
  fallback behavior.
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

- `apps/web` - Vite/React browser Workbench. It uses the page's required
  `fetch`, `WebSocket`, and `location` globals for Runtime HTTP, SSE, and
  WebSocket transports; production transport factories do not expose
  test-only injection or a fabricated fallback origin.
- `apps/desktop` - trayless Electron window host for native windows, menus, folder picking, and Product packaging.
- `apps/runtime` - single-process Rust Runtime, native tray, Control/Workbench/Photoshop transports, domain services, Product updater, and external Agent-facing `debrute` CLI.
- `apps/photoshop-uxp-plugin` - Photoshop UXP plugin surface.
- `apps/photoshop-cep-plugin` - Photoshop CEP plugin surface.
- `packages/canvas-core` - Canvas domain declarations and the browser-safe presentation values named by current production consumers. Authoritative Canvas document validation, projection, reconciliation, layout, feedback mutation, and persistence remain in Rust Runtime Project services.
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
and inspect imports, package dependencies, TypeScript references, and Vite
aliases. They enforce current ownership rather than maintaining empty export
frameworks or a denylist of retired names.

Build-tool dependencies follow the same ownership rule. The Web workspace owns
Vite and its React plugin; the Desktop workspace owns esbuild and
electron-builder. The root package orchestrates those workspace scripts and
does not repeat their direct dependencies, while Desktop does not declare a
private Vite copy for the Web development server.

The principal dependency directions are:

- domain and runtime packages do not import application implementations;
- `app-protocol` owns cross-application shapes without Node, React, orchestration,
  or Runtime execution;
- Project cache helpers and Canvas core stay independent of application
  and renderer layers;
- Web Workbench is browser-safe and does not own Runtime execution, Electron, or
  production Node filesystem APIs;
- Web feature code consumes the Workbench UI surface rather than importing a
  parallel third-party visual framework, and the Web package does not declare
  those unsupported UI systems;
- Electron remains a native host and Control client rather than a backend or
  domain service host; and
- Capability execution, Project filesystem and text classification, Canvas Map
  expansion, and authoritative Runtime and CLI Project semantics remain in Rust
  instead of being duplicated in TypeScript packages.

Runtime composition follows the same closed direction internally. Core
authorities do not own their CLI or Product adapters. The Workbench router owns
the required CLI adapter and the launch-mode-fixed optional Product adapter;
those adapters receive their exact current dependencies before the listener
starts. Runtime does not use mutable service-installation slots or manual
shutdown-time cycle breaking.

## Current-State Contract

Debrute is prelaunch, so internal persisted documents and implementation APIs
describe one current shape. Removed fields, paths, services, command aliases,
and UI state do not receive compatibility readers, migrations, fallback success
paths, transitional re-exports, or dedicated historical rejectors. Invalid
current data fails its owning current-shape validation.

TypeScript package roots export only declarations and values named by current
production consumers. A declaration used solely to compose an exported current
contract remains module-private; generated or handwritten leaf types are not
separately re-exported without such a consumer. Removing an accidental public
name is an immediate compile-time break: packages do not retain transitional
re-exports, deprecated aliases, or dedicated rejection shims for old imports.
A test-only import does not make a name part of the package-root contract.
Tests may exercise an internal current behavior through its owning source module,
but a helper with no production path is removed together with tests that only
preserve that helper.
Workbench visual primitives follow the same consumer-owned rule. A variant,
layout mode, slot, CSS branch, or primitive test exists only when a current
production surface uses it; a primitive's self-test is not a consumer and does
not preserve speculative design-system breadth.

An absent internal settings file means the current state has not yet been
created and may use the current first-launch defaults. Once a file exists, every
object is closed and every value must already be canonical: readers do not trim,
filter, deduplicate, truncate, repair, or discard unknown fields. Partial
mutation inputs likewise accept only their declared fields and must express at
least one mutation. Repeating a valid current value is an idempotent no-op;
empty objects and unknown-only inputs are invalid requests.

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
errors remain visible. A rejected tab-local Workbench view snapshot is likewise
reported and discarded as one disposable presentation value before current
first-open defaults are used; its fields are never salvaged or rewritten as a
migration. Expected Runtime failures use typed results; an
unexpected panic terminates the Runtime process instead of being caught as an
ordinary work failure, recovered through a poisoned lock, or represented as a
degraded service state.

Cross-surface trust boundaries are documented in
[`security.md`](./security.md). Local test classification, scheduling,
performance, and resource ownership are documented in
[`testing.md`](./testing.md).

## Project State And Documents

Runtime owns Project identity, path safety, visible file operations, and
`.debrute/project.json` through `apps/runtime/src/project/`. The descriptor list
in `documents.rs` is the executable authority for structured documents committed
through the Project Document transaction, including their roles, path patterns,
and allowed service writers. The TypeScript core packages retain browser-facing
value shapes and pure renderer algorithms, not persistence authority.

Every persisted Project Document and its nested persisted values use one closed
current shape. Unknown fields fail deserialization and remain untouched on disk;
Runtime does not discard them and later rewrite the document as an implicit
migration. This strictness belongs only to persistence DTOs. Project snapshots,
projections, file listings, diagnostics, and other response-only values are not
made into persistence schemas merely because they share component types. Model
Operation snapshots, states, execution variants, Artifact Pointers, Batch Item
Outcomes, and list results likewise serialize outward only; Runtime does not
derive a synthetic input contract for values it exclusively constructs.

Ordinary service-owned multi-document writes use the Project Document
transaction boundary. It validates registered owners and participant hashes,
acquires document locks, stages writes, and restores previous content when an
ordinary commit fails. Generated Model outputs use the separate item commit from
[ADR 0055](./adr/0055-generated-results-use-in-process-item-commits.md): one
Project-rooted staged file set publishes output files, immutable provenance
records, and the Generated Asset index under the Generated Asset service lock.
Generic Project Tree mutations cannot modify protected `.debrute/`
state. Revisioned text saves may edit visible Project Documents; the normal
snapshot pipeline then exposes invalid source or pushed content as diagnostics
instead of silently repairing it.

Invalid `.debrute/project.json` prevents Project opening. An invalid Canvas JSON
is excluded while the snapshot reports `document_invalid_pushed`; an invalid
Canvas registry reports `canvas_registry_invalid`. These are the owning current
error paths, not compatibility rejectors. An explicit Canvas push or registry
repair may construct a new valid current document, but reading never repairs or
rewrites the invalid file.

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
Exact persisted document, projection, reconciliation, layout, feedback, and
stack-order behavior remains in Runtime Project services. Canvas Core supplies
the shared declarations and browser presentation values consumed by Workbench;
the Workbench Canvas runtime owns only transient interaction and rendering
state.

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

`pnpm doctor` checks the local Node/pnpm/tooling surface needed for development and supported Product packaging. `pnpm check` uses the project-reference graph to type-check packages, Web, and the Electron Desktop from its one NodeNext `noEmit` configuration. esbuild alone emits the Electron JavaScript bundle. `pnpm verify` runs doctor, that complete type check, tests, architecture lint, and the production build.

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

Prepared payloads live only at the platform-identity directory under
`.scratch/native-raster-payloads`. Production and development commands do not
select an arbitrary payload root through an environment variable. Unit tests
may pass an explicit fixture root to the validator; that injection is not a
second command-line or process-environment contract.

`pnpm dev:electron` uses the same native Control endpoint, so it attaches to the existing Runtime instead of starting a competing backend.
Its internal Desktop development bundle intentionally skips Product-seed
assembly after naming that responsibility directly; it is not a second
production build. `pnpm build` is the sole Desktop production build path and
includes the Web build, Rust binaries, Desktop type check, Electron bundle, and
complete Product seed. The package exposes no weaker build alias or unused
sourcemap switch that can produce a product-looking partial result.
On macOS the development scripts ad-hoc sign the freshly assembled Runtime app
and, only when its downloaded signature is not accepted by the host, the
unpacked Electron app with the repository's development entitlements. This is
local LaunchServices preparation for the real `.app` processes; Product and
release artifacts still use the release signing pipeline and are never
accepted on the strength of the development signature.

The macOS launcher records the exact compiled Runtime-binary identity used to
assemble the development `.app`. A missing or different identity forces
reassembly and signing even when an earlier Rust test already rebuilt
`target/debug/debrute-runtime` before `pnpm dev` began. Live browser diagnostics
therefore cannot silently reuse an older application bundle.

One Runtime can host multiple live Project sessions. The stable public Project
id comes only from `.debrute/project.json.project.id`; Runtime maps recent ids to
canonical roots and rejects duplicates. Browser tabs and Electron windows have
one live Workbench connection and at most one bound Project. Interactive users
open Projects with the Workbench `Open Project` action, which asks Runtime to
present the native directory picker. Agents and automation open an explicit
absolute path with `debrute workbench start <project> --frontend browser`; the
command sends a native Control activation and never prints an authentication
URL. Runtime acquisition, optional launch, handshake, and Ready polling share
one absolute fifteen-second deadline in development and packaged clients; a
wrapper does not add or restart another Ready timer. The root Workbench route
does not reopen the last Project.

`pnpm preview` serves the production Web build for smoke testing after `pnpm build`. Desktop assembly consumes that complete `apps/web/dist` output directly and packages it only under the Product seed's `web` directory; it does not maintain a second Desktop Web output directory. `pnpm clean` removes that current Web output together with generated Desktop, package, release, and TypeScript build artifacts. A target that does not exist is already clean; any other traversal or removal error fails the command instead of reporting a partial cleanup as successful.

`node scripts/run-cargo-with-native-raster.mjs -- build -p debrute-runtime --bin debrute`
builds the current-platform CLI against the locked native payload. Product
assembly signs and declares that binary together with Runtime, Web assets,
Skills, and model documentation.

`pnpm pack` creates an unpacked desktop app under `apps/desktop/release/`. `pnpm dist` creates distributable Desktop artifacts when run on the matching platform.

Packaged Desktop product assets are published from the public `XiiTang/Debrute` GitHub repository.

macOS arm64, macOS x64, and Windows x64 are the complete Product targets. Each
packaged Desktop contains its matching Runtime Product and participates in the
signed release and packaged-product acceptance contracts. The platform boundary
is recorded in
[`0030-product-supports-macos-and-windows.md`](./adr/0030-product-supports-macos-and-windows.md).
