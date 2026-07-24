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

A test must execute production behavior or inspect a produced artifact or
boundary. A file that only constructs values annotated with production types,
asserts its own literals, or casts an empty object to an interface is not a
test. Production TypeScript declarations and their real consumers are checked
by `pnpm check`; Vitest does not duplicate that responsibility with type-only
fixtures.

Each repository-wiring fact has one owning assertion. Release projects may
inspect a workflow or build script when that boundary cannot be executed
locally, but another test does not repeat the same source-spelling assertion;
artifact and behavior tests remain separate evidence.

Root `pnpm test` runs `pnpm test:layout` before Vitest, so verification and
release preflight cannot bypass repository layout validation. The focused
`pnpm test:layout` command proves that each test belongs to exactly one named project,
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
successful teardown. Project-use lifetime tests end ownership through the same
drop or owner-removal path used by Workbench, requests, Terminals, Transfers,
and Photoshop links. An injected final-session cleanup failure must close root
admission, make the next open return the exact failure, and remain visible to
Registry shutdown; tests do not call a special fallible Project Use release API
that production owners bypass. Tests that exercise process-global native
initialization, including libvips startup, use an isolated Runtime process; they
do not call a native shutdown function and attempt to reinitialize it in the
same test process.

The resource-ownership rationale is recorded in
[`0013-tests-own-their-external-resources.md`](./adr/0013-tests-own-their-external-resources.md).

## CLI Registry Acceptance

The final public command-matrix test keeps the closed CLI inventory explicit.
Parser behavior tests cover each distinct syntax form: positional bounds,
required and duplicate options, flags, repeatable values, simple allowed-value
sets, Project positional and option path resolution, unknown options, and the
`canvas.reset-layout` cross-option rule. They do not copy one canonical argv
form for every command or inspect parser source for command-name switches; the
registered syntax is the parser's input.

## Workbench UI Acceptance

DOM tests exercise the current rendered state and the action a user can perform.
Settings coverage verifies the current navigation groups and default page, and
Product update behavior by invoking the visible action and observing its result
or exact failure. It does not enumerate
retired navigation keys, button labels, commands, or page counts as a blacklist,
and it does not inspect source text to prove that an old UI path is absent. Once
a pre-release UI path is removed, its removal-only assertions are removed too;
absence assertions remain only when absence is itself part of the current state
being exercised, such as hiding ready content while a resource is loading.

## Model Generation Acceptance

Catalog-validation tests prove that Doubao Seed TTS 2.0 accepts omission and
each documented integer `sample_rate`, while fractional, negative, and
unsupported values fail before the transport receives a request. Adapter tests
prove that omission sends `24000`, an explicit supported rate is preserved in
the upstream body, and PCM output writes that same rate into its WAV header.
There is no invalid-value coercion or default fallback to preserve with a test.
Exact-adapter fixtures also dispatch TTS, music, and sound-effect through the
shared internal audio execution family and verify their distinct Artifact
Roles. Tests do not preserve empty per-Kind forwarding modules through source
text or file-existence assertions.

## Workbench HTTP Acceptance

Revisioned-file route tests verify `200` for a complete file, `206` plus exact
range headers for a satisfiable single range, and `416` for an unsatisfiable
range. Service-error tests verify the typed status selected at error creation is
the status returned by the adapter. Tests exercise those outcomes; they do not
inject impossible numeric statuses or preserve an invalid-status fallback.

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
Variant Key only. They do not manufacture a retired engine-version directory or
test cleanup of one; no test preserves a retired cache shape, quota, LRU, TTL,
migration, compatibility reader, fallback renderer, or automatic retry.

Native-payload contract and release tests verify the repository lock's URL,
SHA-256, target, enabled format surface, and libvips 8.18.4 identity. Missing,
altered, wrong-target, and wrong-version payloads fail preparation or Product
assembly. Product tests inventory license and notice files and native libraries,
validate the fixed platform layout, and release workflow contracts require
macOS library code signing.

Requested live acceptance runs on macOS arm64 in both a real browser and
Electron. `pnpm verify:browser` owns an isolated Project with a large raster,
text document, and real video plus explicit poster. Its browser context uses a
Retina-equivalent device pixel ratio of 2. It requires image, inactive text, and
inactive video previews to decode, then observes every media kind switch from
the initial tier to a lower tier, a higher tier, a repeated lower tier, and a
restored higher tier. Each settled DOM image must report the requested `w`
value as both its `naturalWidth` and declared preview width. Project-specific
regressions may additionally be checked against their real Project, but those
user-local files are not presented as a committed fixture.

The Runtime HTTP integration suite also opens two ordinary-browser Workbench
connections under one cookie, binds them to different Projects, and proves that
each connection can still issue commands and read its own passive media after
the other connection opens. Closing either connection must not revoke the
other; closing the final connection retires the browser session so a retained
cookie cannot recover it.

The reusable live Workbench acceptance sequence is:

`pnpm verify:browser` checks functional browser behavior without enabling the
Canvas performance probe. When a requested live diagnostic needs
`window.__debruteCanvasPerf`, start the Workbench with either
`pnpm dev -- --canvas-perf` or `pnpm dev:electron -- --canvas-perf` before
opening the final Project route. Starting without the flag keeps development
Canvas instrumentation off, and production builds do not expose the probe.
The instrumentation implementation is likewise absent from the production
Workbench bundle: it contains no performance monitor, browser adapter, debug
bridge, or registration effect. A development process without `--canvas-perf`
also creates none of those objects; the flag is the single boundary that admits
the diagnostic chain.

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
and closing the last Desktop window leaves Runtime alive. Desktop adapter tests
prove that a non-final close reports its window key, while the final close sends
no redundant window request, closes Control, and exits Electron without an
acknowledgement or timeout path. Automated checks use that startup gate. Shared
TypeScript and Rust Control-client tests use injected
short budgets to prove that a responsive Control endpoint which remains
`Starting` ends as `runtime_ready_timeout`, sends no activation, and does not
restart its absolute deadline after endpoint acquisition or handshake. The
timeout closes only the test client and sends neither Product Quit nor a second
launch; separate CLI coverage proves that `runtime stop` sends Product Quit to
an existing `Starting` owner without a readiness wait. Release
acceptance additionally checks the icon and its menu visually because macOS
does not expose every third-party status item through a stable test API.
Required macOS arm64, macOS x64, and Windows x64 release jobs run one shared
packaged-product smoke check against the signed unpacked Electron Builder
application. It requires Runtime `Ready`, the native tray, a loopback-only CDP
page target with the packaged Workbench shell and preload API, and no
`workbench-connection-ended` state. The CDP launch switch belongs only to that
CI process; the smoke check adds no public Runtime inspection field or product
test hook. It then requires the bundled CLI's single Product Quit request to
succeed, Runtime to become stopped, and Desktop to exit on its own. An exact
failure-cleanup kill of the spawned Desktop process tree cannot turn a failure
into success; each CLI/CDP probe is bounded, and there is no ignored quit result
or Runtime-wide process-name kill. These live checks remain explicit
diagnostics rather than part of ordinary `pnpm verify`.

Desktop lifecycle tests also issue Command-Q before Control acquisition
finishes. They prove that Desktop opens no window, completes only the existing
acquisition, registers the Product event path, and sends exactly one Product
Quit request; it never performs an early Desktop-only exit or starts another
connection.

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
