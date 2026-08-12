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

Validation has three scopes:

- **Affected validation** runs the smallest Vitest files, Cargo packages or test
  targets, type checks, architecture checks, and live diagnostics that establish
  the changed behavior. This is the default during development and ordinary
  handoff.
- **Repository verification** runs the complete local repository gate with
  `pnpm verify`. Committing, merging, pushing, or handing off work does not by
  itself select this scope. Use it when explicitly requested, when test or build
  infrastructure or root workspace contracts change, or when a genuinely
  cross-cutting high-risk change needs repository-wide evidence.
- **Release verification** uses `pnpm verify:all` plus the applicable platform,
  packaging, signing, and smoke checks. `pnpm verify:all` is also available when
  exhaustive all-target Rust lint is explicitly required, but it is not a
  default handoff step.

Ordinary GitHub CI provides the repository-level safety net that complements
affected local validation. It uses only standard GitHub-hosted runners available
to the public repository; paid larger runners are outside the ordinary CI
contract. It runs for pull requests targeting `main` and for direct pushes to
`main`; pushing an ordinary development branch without a pull request does not
start it. A newer commit to the same pull request or branch cancels an obsolete
in-progress run so only the latest code completes validation. Changes confined
to Markdown and `docs/` do not start code validation; source, test, script,
configuration, lockfile, workflow, or product-resource changes do. Ordinary CI
checks the development toolchain, generated Control contract and TypeScript
graph, product-target Rust formatting and Clippy, TypeScript and Rust tests, and
architecture boundaries. Production artifact builds, exhaustive all-target
Clippy, real-browser and Electron diagnostics, native-watcher acceptance,
signing, notarization, and platform packaging remain affected-development or
release checks rather than ordinary CI work. Shared
TypeScript and architecture checks run once; product-target Rust checks and Rust
tests run on standard macOS and Windows runners so both supported Desktop
platforms compile their host-specific paths. Linux is not an ordinary CI target
while Debrute does not ship a Linux product. Two jobs run in parallel: macOS
performs the shared checks and macOS Rust validation in one workspace, while
Windows performs the Windows Rust validation. The initial workflow caches pnpm
and Cargo dependency downloads but does not persist `target/` or install
`sccache`. Each platform reports its Rust wall-clock duration and final `target/`
size; compiled-output caching is reconsidered only from that evidence and the
repository cache limit. The workflow composes the existing check and test
commands directly; it does not add a `verify:ci` package script that agents might
mistake for an ordinary local handoff command. Initial CI results are advisory:
they do not enable branch protection or prohibit direct pushes to `main` until
the new workflow has demonstrated stable execution and useful feedback. Each
job has a 45-minute hang timeout. Stage durations are diagnostic evidence rather
than a pass/fail performance budget until repeated hosted-runner measurements
establish a normal range.

Every Git worktree owns its own Cargo `target/` directory so concurrent builds,
tests, binaries, and packaging cannot observe another worktree's final
artifacts. Developers may opt into reuse of eligible Rust dependencies and
compilation units with a shared local `sccache` cache by configuring a Rust
compiler wrapper and normalizing each checkout root with `SCCACHE_BASEDIRS` or
sccache `basedirs`; Cargo metadata, linker work, incremental workspace crates,
and other non-cacheable invocations remain worktree-local. The standard
uncached Cargo path remains the complete public development contract. Worktrees
do not share `CARGO_TARGET_DIR`, and creating one does not prewarm it with a
speculative build.

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

Whole-repository verification has a separate sequential timing report.
`pnpm verify` generates Control bindings and runs the complete TypeScript check
once, lints Rust product libraries and binaries, runs every TypeScript and Rust
test, checks architecture, and builds production artifacts without repeating
generation or type checking. Explicit exhaustive or release verification with
`pnpm verify:all` selects all-target Clippy instead of product-target Clippy; it
does not run both. A failed stage stops the pipeline and the summary retains the
completed and failed-stage durations.

## Resource Ownership

Release tests own every temporary payload, package, and manifest they create
and remove them through awaited teardown. They do not publish or replace an
installed product.

Rust integration tests own isolated Control endpoints, homes, Project roots,
loopback listeners, workers, and child processes. Runtime shutdown closes
Workbench connections and their Project Uses, Global/Project streams,
WebSockets, the Photoshop gateway, PTYs, and HTTP sockets, then joins its owned
workers. Cleanup errors remain visible instead of being converted into
successful teardown. Project-use lifetime tests end ownership through the same
drop or owner-removal path used by Workbench, requests, Terminals, Transfers,
and Photoshop transfers. An injected final-session cleanup failure must close root
admission, make the next open return the exact failure, and remain visible to
Registry shutdown; tests do not call a special fallible Project Use release API
that production owners bypass. Tests that exercise process-global native
initialization, including libvips startup, use an isolated Runtime process; they
do not call a native shutdown function and attempt to reinitialize it in the
same test process.

Project-session tests inject a deterministic backend at the native watcher
creation seam. They still execute the production Project watcher worker,
filtering, path-local coalescing, publication barrier, rescan handling, and
session lifecycle, but do not make unrelated Registry contracts depend on an
operating-system watcher. The separate `pnpm test:rust:native-watcher` command
builds the production watcher probe without a time limit on compilation, then
gives the probe process 15 seconds to create four recursive watchers through the
Runtime's default watcher factory and `ProjectFileWatcher` worker, observe a
real file change through each worker, and close. A deadline kills only that
exact probe process and fails explicitly with the notify-rs/notify#942
diagnostic on macOS; the command does not retry or select another backend. It
remains outside ordinary `pnpm verify` and is required by every Product release
matrix target. Ordinary Runtime integration composition always selects the
deterministic backend; the separate probe is the sole test command for
production native watcher wiring and host delivery.

Development-launcher contract tests execute the shared direct-child stop
boundary and verify that both launchers attempt all cleanup, always close their
Control connection, and aggregate failures. The Windows contract additionally
spawns a real parent and grandchild, terminates them through the production
`taskkill /T /F` path, and requires both PIDs to disappear. The test uses the
host's real `WINDIR`; production and teardown contain no guessed Windows path or
direct-child success fallback.

The resource-ownership rationale is recorded in
[`0013-tests-own-their-external-resources.md`](./adr/0013-tests-own-their-external-resources.md).

## CLI Registry Acceptance

The public command-matrix test keeps the closed CLI inventory explicit.
Parser behavior tests cover each distinct syntax form: positional bounds,
required and duplicate options, flags, repeatable values, simple allowed-value
sets, root and file path resolution, unknown options, and the mutually exclusive
JSONL/direct Model Request sources. They do not copy one canonical argv form for
every command or inspect parser source for command-name switches; the registered
syntax is the parser's input.

## Workbench UI Acceptance

DOM tests exercise rendered state and the action a user can perform. Settings
coverage verifies the navigation groups and default page; Integrations coverage
waits for both authoritative resources, renders all four Photoshop states and
their exact diagnostics, keeps the switch projection-controlled, and disables
only that switch during a transfer. Context-menu coverage proves that the whole
Photoshop submenu requires an open live Document while retaining disabled
format-incompatible Documents once any target exists. Product update coverage
exercises both direct Install buttons: General Settings and the title bar.
Workbench coverage also requires the global blocking surface for
`preparing` and `committing`; the Desktop probe tests the closed native failure
record used when Runtime never becomes Ready. Absence assertions are used when
absence is part of the rendered contract, such as hiding ready content while a
resource is loading.

## Model Request Acceptance

Catalog-validation tests prove that Doubao Seed TTS 2.0 accepts omission and
each documented integer `sample_rate`, while fractional, negative, and
unsupported values fail before the transport receives a request. Adapter tests
prove that omission sends `24000`, an explicit supported rate is preserved in
the upstream body, and PCM output writes that same rate into its WAV header.
Exact-adapter fixtures dispatch TTS, music, and sound-effect through the shared
internal audio execution family and verify their distinct request and response parsing.

## Workbench HTTP Acceptance

Revisioned-file route tests verify `200` for a complete file, `206` plus exact
range headers for a satisfiable single range, and `416` for an unsatisfiable
range. Service-error tests verify the typed status selected at error creation is
the status returned by the adapter. Workbench shutdown coverage holds an
accepted Project lease past the 500 ms connection-drain boundary, proves that
the pending connection lifetime is cancelled without aborting that lease, then
releases it and requires the Runtime-owned closer to finish. HTTP integration
coverage proves live SSE streams close before listener join.

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
that an exact image-preview response is private immutable while a stale source
revision remains rejected. Text and video routes retain their revalidation
policy in the closed route implementation. Tests further prove
that the shared Raster Preview Pool admits at most three active jobs,
equivalent requests share one job, consumerless queued work is removed, active
native work has no request timeout or force-cancel path, and a stale source or
engine identity cannot publish its temporary output. Cache tests exercise the
current Source Identity, Source Version, Raster Preview Engine Version, and
Variant Key, plus structural reconciliation within the exact current engine
path.

Canvas video tests separate browser production from Runtime storage. Workbench
tests cover independent playback and Feedback Moment targets, the one serialized
capture lane, JPEG source read/save requests, browser metadata projection, retry,
player handoff, active-player capture cancellation, and collapsed-video Feedback
maintenance without an extra playback target. Runtime tests cover exact Project
leases, multiple frame times under one Source Revision, JPEG and aspect-ratio
validation, atomic cache files, raster variants, pending Feedback frames, and
maintenance-resource recovery after a collapsed Project is reopened. Product
assembly tests require schema 3 and prove that no separate video-tool payload or
runtime-dependency declaration is packaged.

Native-payload contract and release tests verify the repository lock's URL,
SHA-256, target, enabled format surface, and libvips 8.18.4 identity. Missing,
altered, wrong-target, and wrong-version payloads fail preparation or Product
assembly. Product tests inventory license and notice files and native libraries,
validate the fixed platform layout, and release workflow contracts require
macOS library code signing.

Requested live acceptance runs on macOS arm64 in both a real browser and
Electron. `pnpm verify:browser` owns an isolated Project with a large raster,
text document, and real video. Its browser context uses a
Retina-equivalent device pixel ratio of 2. It requires image, inactive text, and
inactive video previews to decode, then observes every media kind switch from
the initial tier to a lower tier, a higher tier, a repeated lower tier, and a
restored higher tier. Each settled DOM image must report the requested `w`
value as both its `naturalWidth` and declared preview width. Project-specific
regressions may additionally be checked against their real Project, but those
user-local files are not presented as a committed fixture.

`pnpm verify:browser:activity` reuses that isolated Runtime and Project but runs
only the Activity surface acceptance path. It verifies the straight paper Card,
three-card Floating Stack, transparent content-adaptive Center, remaining-height
scroll cap, scroll-anchor preservation, non-modal focus semantics, terminal
clear, empty hit area, and inert outside-pointer close at a wide light viewport
and a narrow dark viewport. It is the focused live diagnostic when unrelated
Canvas media acceptance is outside the requested change.

`pnpm verify:browser:window-gestures` reuses the isolated Runtime and Project at
a wide real-browser viewport but runs only the Workbench window gesture path.
It verifies that Settings and Terminal render in the shared Workbench window
layer, Settings dragging, every Terminal resize direction, the locked cursor
while the pointer crosses panel content, and Escape cancellation with no stale
gesture attribute or preview geometry. It is the focused live diagnostic for
Workbench panel drag, resize, hit-area, or cursor regressions.

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

1. Start `pnpm dev:electron` at Root. Open a real Project through File > Open
   Project and wait for its Project tree and Canvas rather than treating the
   initial loading shell as success. The same native window must accept the
   Project; no second window may be created.
2. From that Project window, open a different Project through File > Open
   Project or Open Recent. The source window must remain the target and show the
   new Project or its failure. A source-free activation targets the sole live
   window; with zero or multiple live windows it creates one ordinary Workbench
   carrying the initial Project. On macOS, the Dock **New Window** action must
   always create a fresh Root window. Repeat the source-free check through
   Finder or a second-instance argument on the applicable platform.
3. Open the same stable Project route in a real browser. Web must take the
   Project, while the existing Desktop window stays open with its last
   confirmed presentation frozen, has no Project command authority, and exposes
   **Open Here**.
4. Choose **Open Here** in Desktop. Desktop must regain the Project and the Web
   page must retain the corresponding detached presentation in a frozen state
   without Project command authority. Neither direction reconnects, retries,
   closes the other container, or loses its frontend-local view state.
5. Inspect representative raster `<img>` elements before and after a real
   Canvas zoom. Their `currentSrc` width and `naturalWidth` must advance when a
   higher quantized tier is needed, while the previously loaded image remains
   visible during handoff. Activating a text node must not remove raster nodes,
   and ready text/image publications must advance in bounded groups of at most
   three operations per animation frame until every current visible result is
   mounted.
6. While a Canvas Project Path context menu is open, verify that right-clicking
   a selected node preserves the full selection while the clicked node remains
   the invocation target. Camera, selection, pointer-interaction, and same-ready
   resize changes must not rerender the Workbench composition root or restart
   image resource effects. Capture `window.__debruteCanvasPerf` around zoom,
   marquee, and group-move interactions and compare resource and render
   counters before and after the interaction.
7. Require a clean browser error/warning log and no React maximum-update-depth,
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
packaged-product smoke check after installing the Product. Windows runs the NSIS
installer silently. macOS mounts the DMG, validates the Product Setup container
and its nested Desktop payload, then invokes the published Setup executable in
noninteractive mode. This skips only its confirmation and completion alerts;
the smoke still exercises the same Setup preflight, Product stop, Desktop
replacement, and whole-Product installation method. The check then launches the
installed Desktop through its stable Product paths. It requires Runtime `Ready`, the native tray, a
loopback-only CDP page target with the packaged Workbench shell and preload API, and no
`workbench-connection-ended` state. The CDP launch switch belongs only to that
CI process; the smoke check adds no public Runtime inspection field or product
test hook. It then requires the managed CLI's single Product Quit request to
succeed, Runtime to become stopped, and Desktop to exit on its own. An exact
failure-cleanup kill of the spawned Desktop process tree cannot turn a failure
into success; each CLI/CDP probe is bounded, and there is no ignored quit result
or Runtime-wide process-name kill. These live checks remain explicit
diagnostics rather than part of ordinary `pnpm verify`. Each job finally issues
the default `debrute product uninstall --yes` transaction and requires the
installed Desktop, Product home, official Skills, home-level removal and
projection transactions, shell-write transactions, command PATH projection,
login item, and Windows registration, shortcut, and installer cache to be absent
while an unrelated Skill remains. macOS also requires its detached Runtime
capsule to disappear; Windows verifies the reboot-deletion scheduling primitive
in native tests because the executing capsule may remain until reboot.
Focused Runtime tests also verify that Start at Login round-trips the exact
native Runtime entrypoint, confirms native state before publishing, emits one
ordered complete Global Settings event per effective change, and never writes
the live boolean into `global_settings.json`. Settings DOM tests verify the
English and Chinese copy, accepted-only switch behavior, pending disablement,
and exact inline native failure.

Desktop lifecycle tests also issue Command-Q before Control acquisition
finishes. They prove that Desktop opens no window, completes only the existing
acquisition, registers the Product event path, and sends exactly one Product
Quit request; it never performs an early Desktop-only exit or starts another
connection.

## Photoshop Integration Acceptance

Photoshop acceptance separates four evidence layers. Contract and unit tests
cover strict protocol shapes, session leases, destination pages, serial item
settlement, cleanup, and Workbench eligibility. Runtime tests exercise the
production gateway listener and exact route, method, Host, Origin,
authorization, stale-bearer, content-type, and error-envelope matrix; Project
tests include partial staging writes and disconnect during an admitted commit.
The built UXP `dist` is then loaded explicitly through UXP Developer Tool and
tested against the development Runtime and Workbench in the built-in browser.
Finally, a freshly packaged CCX is installed in isolation and smoke-tested after
a cold Photoshop start. Packaging or a DOM test is never host acceptance.

The real-host run records Photoshop and UXP Developer Tool versions, Runtime
port and state, plugin manifest version, `dist` and CCX hashes, exact commands,
logs, screenshots, and one PASS, FAIL, or BLOCKED result per behavior. It covers
both startup orders, enable/disable/re-enable, panel detach and reload,
Explorer-to-Photoshop and Canvas-to-Photoshop independently, exact-Document
Embedded Smart Object placement, layer and group full-canvas PNG export, alpha,
same-name collision allocation, shallow deep-directory expansion, `.debrute`
exclusion, ordinary dependency/build/gitignored directory visibility, deleted
destination invalidation, session loss before upload, session loss during
capture, unknown upload settlement, reconnection without replay, complete batch
temporary cleanup, multiple Documents, and Photoshop restart. The CCX pass
repeats cold startup, one transfer in each direction, restart without replay,
and uninstall; it does not duplicate every UDT-loaded behavioral case.

## Commands And Reports

| Command | Scope |
| --- | --- |
| `pnpm test` | complete local suite |
| `pnpm test:unit` | Node unit projects and contracts |
| `pnpm test:dom` | Web DOM project |
| `pnpm test:release` | release project |
| `pnpm test:watch` | unit, contract, and DOM watch mode |
| `pnpm test:layout` | project ownership and layout contract |
| `pnpm test:rust` | Runtime through pinned nextest plus one-pass host-native Cargo tests |
| `pnpm test:rust:native-watcher` | supervised real native Project watcher contract |
| `pnpm test:profile` | complete suite plus timing JSON |
| `pnpm test:stability` | three complete fixed-seed runs without retry |
| `pnpm test:coverage` | merged local V8 coverage for contributing projects |
| `pnpm test:canvas-text` | native `canvas-text` tag selection |
| `pnpm verify:browser:activity` | focused light/dark real-browser Activity surface acceptance |
| `pnpm verify:browser:window-gestures` | focused real-browser Workbench drag, eight-direction resize, cursor-lock, and cancellation acceptance |
| `pnpm verify` | complete timed repository gate with product-target Clippy |
| `pnpm verify:all` | explicit exhaustive or release gate with all-target Clippy |

Normal runs print the resolved worker plan, group and total durations, slowest
files and cases, and exceeded diagnostic thresholds. Profile output is written atomically to
`.test-results/timing.json` and `.test-results/slow-tests.json`. Coverage lives
under `.test-results/coverage`; it is a local diagnostic. Generated reports and
temporary homes are not committed.

`pnpm verify:browser` and its focused Activity and Workbench window gesture
variants remain explicit live-browser diagnostics outside `pnpm verify`,
`pnpm verify:all`, and the normal local test suite.

## Executable Authorities

- Project aggregation: `vitest.config.ts`.
- Shared aliases, worker policy, presets, and reporter: `tests/config/`.
- Layout enforcement: `scripts/check-test-layout.ts`.
- Runtime Control, HTTP, CLI, and lifecycle coverage: `apps/runtime/tests/`.
- Runtime shutdown and process ownership: `apps/runtime/src/main.rs`,
  `apps/runtime/src/process.rs`, and `apps/runtime/src/workers.rs`.
- Command surface: root `package.json`.
