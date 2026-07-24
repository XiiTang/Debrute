# Local Test System

Debrute has one complete local Vitest system. `pnpm test` runs unit, DOM,
contract, system, and release projects with bounded deterministic
parallelism. Test layout and resource cleanup are executable contracts, not
conventions maintained only in prose; wall-clock timing remains diagnostic.

## Project Discovery And Test Classes

The root `vitest.config.ts` is an aggregator. It discovers and sorts app,
package, and root test project configs; it does not own feature-specific aliases,
file inventories, environments, or lifecycle setup.

Tests are classified by their owning boundary:

| Class | Location and suffix | Purpose |
| --- | --- | --- |
| Node unit | colocated `*.test.ts` | one source-owned unit without real persistent process boundaries |
| DOM unit | Web-colocated `*.dom.test.tsx` | React and browser behavior in the shared jsdom project |
| Contract | `tests/contracts/**/*.contract.test.ts` | public shapes, assets, architecture, and repository contracts |
| Release | `tests/release/**/*.release.test.ts` | packaging, manifests, installers, assets, and release scripts without publication |

`pnpm test:layout` proves that each test belongs to exactly one named project,
directory and suffix agree, project names/configs are unique, and no top-level
`tests/*.test.*` files or file-level environment directives remain. Committed
skip, todo, conditional-run, and retry syntax is rejected.

## Scheduling And Performance

The shared worker policy reserves two logical CPUs, caps unit work at four
workers, caps DOM work at two, and serializes release
projects. `DEBRUTE_TEST_WORKERS` may lower the parallel-safe worker ceiling with
a positive integer; it does not change test selection or serial-project rules.

Projects execute in ordered groups:

| Group | Projects | Pool | Workers | Diagnostic threshold |
| --- | --- | --- | ---: | ---: |
| 1 | Node units and contracts | forks | up to 4 | 20 seconds |
| 2 | Web DOM | threads | up to 2 | 20 seconds |
| 3 | Release | forks | 1 | 20 seconds |

The default file order is shuffled with seed `104729`, so ordinary runs remain
reproducible. The reporter compares runs with a 90-second total threshold, the
group thresholds above, and per-case slow thresholds of 250 ms for
unit/contract, 500 ms for DOM, and 5 seconds for release. These wall-clock
measurements identify work worth profiling but never change the test exit code,
because local machine load cannot distinguish a code regression from external
contention. Timeouts remain separate hung-test limits: 5, 5, and 30 seconds
respectively.

## Resource Ownership

Release tests own every temporary payload, package, and manifest they create
and remove them through awaited teardown. They do not publish or replace an
installed product.

Rust integration tests own isolated Control endpoints, homes, Project roots,
loopback listeners, workers, and child processes. Runtime shutdown closes
Workbench connections and their Project Uses, Global/Project streams,
WebSockets, Photoshop discovery, PTYs, and HTTP sockets, then joins its owned
workers. Cleanup errors remain visible instead of being converted into
successful teardown. Tests that exercise process-global native initialization,
including libvips startup, use an isolated Runtime process; they do not call a
native shutdown function and attempt to reinitialize it in the same test
process.

The resource-ownership rationale is recorded in
[`0013-tests-own-their-external-resources.md`](./adr/0013-tests-own-their-external-resources.md).

## Raster Preview Engine Acceptance

Raster Preview Engine tests observe the Runtime Project-preview services and
Product native-payload boundary. Native integration fixtures cover JPEG, PNG,
WebP, AVIF, and TIFF decode and derived dimensions; focused fixtures prove EXIF
orientation is applied before sizing, alpha input remains alpha-preserving PNG,
and derived metadata is stripped. Loader tests reject HEIC, unknown BMFF brands,
and extension/signature disagreement. These checks assert the stable pixel and
format contract rather than byte-identical encoder output across platforms.

Route-level tests prove that quantized derived widths create the requested
variant, a browser-displayable source at intrinsic width is returned directly
without an equal-width cache file, and TIFF remains derived. They also prove
that the shared Raster Preview Pool admits at most three active jobs,
equivalent requests share one job, consumerless queued work is removed, active
native work has no request timeout or force-cancel path, and a stale source or
engine identity cannot publish its temporary output. Cache tests exercise the
current Source Identity, Source Version, Raster Preview Engine Version, and
Variant Key only; no test preserves a retired cache shape, quota, LRU, TTL,
migration, compatibility reader, fallback renderer, or automatic retry.

Native-payload contract and release tests verify the repository lock's URL,
SHA-256, target, enabled format surface, and libvips 8.18.4 identity. Missing,
altered, wrong-target, and wrong-version payloads fail preparation or Product
assembly. Product tests inventory license and notice files and native libraries,
validate the fixed platform layout, and release workflow contracts require
macOS library code signing.
Linux is not an acceptance target.

Requested live acceptance runs on macOS arm64 in both a real browser and
Electron. `pnpm verify:browser` owns an isolated Project with a large raster and
text document. It inspects actual preview responses and the rendered image's
`naturalWidth` while zooming from a derived tier to intrinsic width, then proves
that the direct tier returns the revision-bound source without an equal-width
cache artifact. Project-specific image regressions may additionally be checked
against their real Project, but those user-local files are not presented as a
committed fixture.

The reusable live Workbench acceptance sequence is:

`pnpm verify:browser` checks functional browser behavior without enabling the
Canvas performance probe. When a requested live diagnostic needs
`window.__debruteCanvasPerf`, start the Workbench with either
`pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf` before
opening the final Project route. Starting without the flag keeps development
Canvas instrumentation off, and production builds do not expose the probe.

1. Start `pnpm dev:electron`, open a real Project in Desktop, and wait for its
   Project tree and Canvas rather than treating the initial loading shell as
   success.
2. Open the same stable Project route in a real browser. Web must take the
   Project, while the existing Desktop window stays open with its last
   presentation, becomes read-only, and exposes **Open Here**.
3. Choose **Open Here** in Desktop. Desktop must regain the Project and the Web
   page must become the corresponding detached, read-only presentation. Neither
   direction reconnects, retries, closes the other container, or loses its
   frontend-local view state.
4. Inspect representative raster `<img>` elements before and after a real
   Canvas zoom. Their `currentSrc` width and `naturalWidth` must advance when a
   higher quantized tier is needed, while the previously loaded image remains
   visible during handoff. Activating a text node must not remove raster nodes,
   and ready text/image publications must advance in bounded groups of at most
   three operations per animation frame until every current visible result is
   mounted.
5. Require a clean browser error/warning log and no React maximum-update-depth,
   failed media request, or silent placeholder state.

The Electron run also verifies that the single Rust process launched from the
Runtime's `LSUIElement` application bundle reaches `Ready` only after creating
its required `tao`-backed macOS menu-bar item. Desktop creates no second tray,
and closing the last Desktop window leaves Runtime alive. Automated checks use
that startup gate; release acceptance additionally checks the icon and its menu
visually because macOS does not expose every third-party status item through a
stable test API. Windows x64 release automation runs Rust, Product assembly,
and Electron startup smoke coverage. These live checks remain explicit
diagnostics rather than part of ordinary `pnpm verify`.

## Commands And Reports

| Command | Scope |
| --- | --- |
| `pnpm test` | complete local suite |
| `pnpm test:unit` | Node unit projects and contracts |
| `pnpm test:dom` | Web DOM project |
| `pnpm test:release` | release project |
| `pnpm test:watch` | unit, contract, and DOM watch mode |
| `pnpm test:layout` | project ownership and layout contract |
| `pnpm test:profile` | complete suite plus timing JSON |
| `pnpm test:stability` | three complete fixed-seed runs without retry |
| `pnpm test:coverage` | merged local V8 coverage for contributing projects |
| `pnpm test:canvas-text` | native `canvas-text` tag selection |

Normal runs print the resolved worker plan, group and total durations, slowest
files and cases, and exceeded diagnostic thresholds. Profile output is written atomically to
`.test-results/timing.json` and `.test-results/slow-tests.json`. Coverage lives
under `.test-results/coverage`; it is a local diagnostic without a historical
baseline or arbitrary global threshold. Generated reports and temporary homes
are not committed.

`pnpm verify:browser` remains an explicit live-browser diagnostic outside
`pnpm verify` and the normal local test suite.

## Executable Authorities

- Project aggregation: `vitest.config.ts`.
- Shared aliases, worker policy, presets, and reporter: `tests/config/`.
- Layout enforcement: `scripts/check-test-layout.ts`.
- Runtime Control, HTTP, CLI, and lifecycle coverage: `apps/runtime/tests/`.
- Runtime shutdown and process ownership: `apps/runtime/src/main.rs`,
  `apps/runtime/src/process.rs`, and `apps/runtime/src/workers.rs`.
- Command surface: root `package.json`.
