# Releases

Debrute publishes Product Installers and Runtime-consumed complete Product
archives on GitHub Releases.

macOS Product Installers are signed and notarized by Apple before publication.
Windows Product Installers and Product binaries are currently not
Authenticode-signed, so Windows may show an **Unknown Publisher** or SmartScreen
warning. The complete release targets are macOS arm64, macOS x64, and Windows
x64.

The Product Installer contains one versioned Product seed: Rust Runtime and
`debrute` CLI binaries, official Skills, Web workbench resources, declared
native workers, the target's pinned Raster Preview native libraries, and a
strict Product manifest. Runtime-owned
installation validates the seed,
installs it under the current user's Product root, publishes stable Runtime and
CLI entrypoints, exposes the CLI in the user's command environment, replaces
the complete official `debrute-*` Skill namespace, and starts Runtime. Desktop
first launch never performs installation.

On macOS, the DMG contains only `Install Debrute.app`; Setup installs Desktop at
`~/Applications/Debrute.app` without elevation and reports success only after
the whole Product is Ready and `debrute` resolves from a fresh login shell. On
Windows, assisted NSIS installs Desktop at
`%LOCALAPPDATA%\Programs\Debrute`, completes the same current-user Rust
installation transaction, and offers to launch Desktop only after success.

Runtime discovers Product updates. An available update exposes the same direct
Install action in the Workbench title bar and **Settings > General**. Either
button is the user's final authorization: Debrute immediately prepares the
complete update, installs it, and restarts without a second confirmation. A
Product update keeps Desktop, Runtime, CLI, Web assets, official Skills, model
definitions and manuals compiled into Runtime, and declared native workers on
the same Product version.
Photoshop plugins are separately packaged and are not replaced by this Product
update.

Runtime updates select the Product Installer asset that matches the current
platform and architecture from the release asset contract below. If a newer
release does not contain a matching installer asset, Debrute reports an update
error instead of treating the Product as up to date.

## Product Assembly And Materialization

The root package version, Cargo workspace, Desktop and plugin packages, Product
manifest, and every official Skill metadata version form one release-version
contract.
`scripts/validate-release-version-contract.mjs` and release preflight reject a
tag whose `vX.Y.Z` value or packaged component versions disagree.
Release preflight also runs `pnpm check:rust:all`, so tests and examples remain
inside the exhaustive Clippy contract even though daily `pnpm verify` limits
Clippy to product libraries and binaries. Developers and agents run
`pnpm verify:all` once after review before starting release work.

Product assembly creates one strict Product seed containing Runtime and CLI,
declared native workers, the target's checksum-pinned libvips payload, official
Skills, Web assets, and their hashes. Model definitions and
manuals are compiled
into Runtime rather than copied into a separate packaged documentation tree. On
macOS, the Runtime executable and libvips payload live
inside an `LSUIElement` Runtime application bundle; both Runtime and the
adjacent CLI load the signed libvips library. Windows keeps its libvips DLLs
beside the Runtime and CLI. Product installation materializes an exact validated version under
`~/.debrute/products/versions/<version>` and selects it through `current`;
macOS Runtime and CLI wrappers live under `~/.debrute/bin/`. Windows keeps the
stable Runtime at `~/.debrute/products/current/runtime/debrute-runtime.exe` and
the CLI wrapper at `~/.debrute/bin/debrute.cmd`. Both launch surfaces supply
that exact Runtime path explicitly, and
official Skills are fully replaced under the direct-child
`~/.agents/skills/debrute-*` namespace. Unrelated Skills are preserved. Runtime
also removes stale exact `.debrute-projection-<canonical-uuid>` transaction
directories before publication; all other Skill names are preserved. Runtime
exposes any validation or materialization failure through Product status.

The Product manifest schema is version 3. Its closed root declares Product
identity, platform, architecture, entrypoints, and the complete hashed file
inventory. It has no runtime-dependency object: browser video decoding is part
of the packaged Workbench engine, while libvips remains an inventoried native
Product file rather than an executable dependency declaration.

The Product seed is the only packaged owner of Workbench Web assets. Desktop
assembly consumes the complete current `apps/web/dist` output directly and
places it under `product-seed/web`; the Electron application does not carry an
independent `dist` copy. Assembly replaces its destination instead of merging
with an earlier output. Release coverage preloads a preexisting hashed Web asset
and proves that it is absent from both the assembled and archived seed.

The complete Product archive is a Runtime update input, not a user installer.
The CLI and Skills are not independent GitHub Release downloads and do not have
independent installers, update streams, PATH editors, or checksum manifests.
They move with the one Product version. The accepted ownership
decision is recorded in
[`0006-product-version-is-runtime-owned.md`](./adr/0006-product-version-is-runtime-owned.md).

## Whole-Product Removal

General Settings exposes the same one-confirmation Product removal action in a
Desktop-hosted or browser Workbench. Windows Apps & Features presents one
equivalent native NSIS confirmation. Agents and terminals use
`debrute product uninstall --yes [--keep-config]`. Every surface commits the
same Runtime-owned transaction; there is no Desktop-only uninstaller.

Removal deletes Desktop, the complete materialized Runtime Product, stable CLI
entrypoints and PATH projection, exact login-start registration, official
`debrute-*` Skills, Electron state, Windows Apps & Features registration and
Start Menu shortcut, the unused NSIS installer cache, and all other
`~/.debrute` state. Exact stale Skill projection transaction directories are
removed with the official Skills. The default-off preservation option keeps only
`~/.debrute/config/global_settings.json` and
`~/.debrute/config/secrets.json`, including saved API keys. Project contents,
including Project-local `.debrute` data, remain outside the removal scope.

Runtime validates and stages the closed plan before admitting removal, copies
its manifest-validated execution closure outside Product-owned paths, drains
admitted work, exits Desktop, and lets that detached closure perform
self-removal. Finder moving `Debrute.app` to Trash cannot trigger code and thus
cannot run this transaction; the browser frontend or managed CLI can still
remove remaining Product components while Runtime and CLI remain installed.

## Update Lifecycle

Packaged Runtime performs one discovery check after becoming Ready and schedules
the next check at a fixed 24-hour interval through its existing supervision
loop. Each due check uses one bounded, short-lived worker; there is no permanent
updater thread. Transient automatic discovery failures preserve the previous
state without surfacing an error, while signature, manifest, and release-contract
failures remain visible. Manual checks report all failures. Source-development
Runtime has no Product update service.

The title bar and General Settings read the same Runtime-owned Product state and
call the same apply operation. The CLI has no Product update command. Debrute
does not use Electron `autoUpdater`, updater YAML/blockmap files, release
channels, or a second Desktop-owned discovery/update service.

Runtime reads GitHub's latest-release response only to locate the named
manifest and detached signature. It enforces small download limits, verifies the
exact manifest bytes with the compiled Ed25519 public key, rejects unsupported
fields and duplicate targets, then accepts only the fixed Debrute GitHub URL and
asset name for the selected platform and architecture. The installer download is
streamed to disk while enforcing the signed byte count and SHA-256 digest.

Before replacement, macOS additionally mounts the Product Installer DMG
read-only and opens only the fixed nested
`Install Debrute.app/Contents/Resources/Debrute.app`; it never runs Setup during
an in-product update and does not inventory or choose among application bundles.
Runtime requires both application directories to be real rather than symbolic
links, then verifies Desktop's bundle id, code signature, Gatekeeper assessment,
stapled notarization ticket, and embedded Product identity. It copies and
verifies a UUID-named staged application before retiring the
installed application and moving the staged application into its place. A
failed move first restores the retired application; only a successful restore
permits staged cleanup. If restoration fails, both recovery paths are retained
and reported. Failures from the primary operation, staged or retired cleanup,
installer descriptor restoration, and DMG detach are reported together; once a
mount is known, detach is attempted exactly once even when installation or
descriptor restoration failed. Windows passes the exact pending transaction id
to silent NSIS. Before it mutates Desktop, NSIS asks the stable installed
Runtime to verify that ID against the read-only staged pending record. Its
electron-builder old-version removal path recognizes `--updated`, removes only
the previous Desktop payload, and never invokes whole-Product removal. NSIS then
installs Desktop but skips the ordinary whole-Product completion hook; the
already-running Runtime continues the same commit. An arbitrary non-empty flag
cannot enter this mode.

Acceptance of either GUI Install action immediately places
Runtime in `Preparing`: Product replacement wins over a concurrent Product Quit,
new mutating Workbench and CLI requests and new Photoshop transfers are rejected,
already admitted mutations and Photoshop transfers drain, and
observation/progress connections may remain open. Runtime
then stages and validates both the matching Product Installer and complete
Product archive. A failure before the durable transaction
returns Runtime to Ready; after the durable transaction begins, the update is
forward-only. Runtime installs Desktop, advances `current`, and starts the exact
target Runtime without asking Workbenches for unload decisions or migrating live
connections, terminals, or Project Uses. The running Runtime commit path and
installed-Desktop pending recovery use one target-Runtime update launch
contract containing the verified target executable, selected Product version
and directories, stable Runtime entrypoint, and completion mode. macOS enters
the exact target application bundle through LaunchServices; Windows executes
the exact verified target binary. Ordinary first launch is not routed through
this update handoff. A missing input or native launch error fails explicitly;
neither update caller assembles a partial command, chooses another entrypoint,
or retries through the ordinary launch path. The target Runtime waits for the
old Control owner to exit, reports Ready, and finalizes stable entrypoints and
official Skills. It durably records `RuntimeReady` before attempting the
initiating Desktop/browser continuation or old-version cleanup. Those
post-Ready conveniences cannot revoke Ready; cleanup remains retryable on the
next launch. No cross-platform replacement helper or automatic install retry is
used. A crash leaves one forward-only pending transaction that the target
Runtime or installed Desktop seed can continue. If native
Desktop installation fails before its durable boundary, the still-current
Runtime exposes an explicit apply error and only a new user-initiated Apply or
Install action continues that same signed transaction; Product installation
does not retry that reversible phase automatically. Update failures remain explicit Runtime
Product states and do not silently report the Product as current.

Once replacement is forward-only, Runtime persists the first failure against
the exact transaction before launching a Desktop-native failure surface. The
installed Desktop asks the selected installed Runtime to read that closed record and shows
the target version, failure stage, message, Runtime log path, and retry guidance.
This surface does not depend on Workbench HTTP or the target Runtime reaching
Ready, so it remains available after the GUI connection has disappeared. A
release gate must still validate this real packaged Desktop handoff on macOS and
Windows; if the operating system cannot launch Desktop at all, no in-product UI
can be guaranteed.

After the target Runtime reports Ready, it durably claims the initiating-surface
continuation before opening Desktop or a browser page. Recovery therefore does
not duplicate windows or tabs. A crash between the claim and the native open can
suppress this convenience relaunch, in which case the user opens Debrute
normally; Runtime does not replay it.

## Product Icon Assets

`assets/brand/debrute-mascot.svg` is the only human-edited identity source. Its
`paper` group is independently addressable, while its `mascot` group always
contains the complete character. Run `pnpm brand:sync` to deterministically
regenerate the responsive Web favicon, Desktop PNG, ICNS, ICO, Dock, and Runtime
tray assets. The generator source is authoritative for the output matrix;
generated consumer assets are not independent design sources and are not edited
by hand. Artwork proportions, platform containers, and tray treatments are
defined in [the brand contract](./brand.md).

The Web build invokes brand asset sync before compilation, and the Desktop
Electron bundle copies the generated runtime assets from `apps/desktop/build/`.
The build requires a valid canonical SVG.

## Public Assets

Each `vX.Y.Z` release requires these public asset names:

```text
debrute-installer-X.Y.Z-macos-arm64.dmg
debrute-installer-X.Y.Z-macos-x64.dmg
debrute-installer-X.Y.Z-windows-x64.exe
debrute-product-X.Y.Z-macos-arm64.zip
debrute-product-X.Y.Z-macos-x64.zip
debrute-product-X.Y.Z-windows-x64.zip
debrute-update-manifest.json
debrute-update-manifest.json.sig
```

## Photoshop Plugin Packages

The repository can build versioned Photoshop packages independently of the
Product release assets:

```sh
pnpm package:photoshop-uxp-plugin
pnpm package:photoshop-plugin
```

Both commands create `debrute-photoshop-uxp-X.Y.Z.ccx`. The packaging script
validates the required archive entries, and the plugin package and manifest
versions must match the root release version.

These plugin packages are not currently published by the tag-triggered GitHub
Release workflow. Adding them to that workflow requires an intentional change
to `scripts/release-asset-contract.mjs` and its release-contract tests; they must
not be treated as public release assets until that contract changes. Runtime
behavior and plugin boundaries are documented in
[`photoshop.md`](./photoshop.md).

## macOS Signing

macOS Product Installer release jobs require these GitHub Actions secrets:
`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER`.

These credentials belong only to `pnpm dist` and the GitHub release workflow.
The macOS source-development commands `pnpm pack:local` and
`pnpm install:local` use verified ad-hoc signatures and do not use or configure
Apple notarization credentials. Their application is intentionally not a
publishable or notarized release.

`CSC_LINK` contains the base64-encoded Developer ID Application `.p12` certificate. `APPLE_API_KEY` contains the App Store Connect `.p8` key material; the release workflow writes both credentials to temporary files before invoking Electron Builder and `notarytool`.

Each application archive and DMG is submitted through `notarytool submit` with
`--wait --timeout 2h`. `notarytool` alone owns status polling within that fixed bound;
Debrute does not wrap `notarytool info` in an independent retry loop. Only an
`Accepted` result proceeds to staple and validate the target. Rejection,
invalid credentials, command failure, malformed output, and timeout all fail the
release step explicitly. A timeout stops the CI wait but does not cancel Apple's
server-side submission.

Windows release jobs do not currently use an Authenticode certificate. The
Windows Desktop executable, Product Installer, Runtime, and CLI are published
without a Windows publisher signature. Manual installation may therefore show
an **Unknown Publisher** or SmartScreen warning. Download manual installers only
from the official GitHub Release.

This does not weaken the in-product update trust boundary: Runtime accepts an
update only after verifying the detached Ed25519 signature on the update
manifest and the declared SHA-256 digest and byte size of both the Product
Installer and complete Product archive.

## Signed Manifest Verification

The product updater trusts only `debrute-update-manifest.json` after its detached Ed25519 signature in `debrute-update-manifest.json.sig` verifies against the public update key compiled into Debrute.

The rationale for making the signed manifest—not GitHub metadata or a plain
checksum file—the trust boundary is recorded in
[`0008-signed-manifest-authenticates-product-updates.md`](./adr/0008-signed-manifest-authenticates-product-updates.md).

The signed manifest lists the expected `sha256` and `sizeBytes` for every
Product Installer and supported complete Product archive. For a manual Product
installation, compare the local hash output with the matching manifest entry
before installing:

```sh
shasum -a 256 debrute-installer-X.Y.Z-macos-arm64.dmg
```

## Release Workflow

The tag-triggered workflow first validates versions and runs doctor, type
checking, tests, and architecture lint. Required Desktop matrix jobs build both
macOS architectures and Windows x64. macOS jobs require signing and
notarization credentials and must pass the repository signing verifier before
their artifacts can reach the publish job.

Every required macOS and Windows matrix job first installs the Product and then
runs the same packaged-product smoke check against the installed Desktop and
stable CLI. Windows runs the assisted NSIS Product Installer silently. macOS
mounts the signed DMG, verifies that it contains the real Product Setup bundle
and nested Desktop payload, then invokes the published Setup executable in its
noninteractive automation mode. That mode skips only the confirmation and
completion alerts while running the same Setup preflight, Product stop, Desktop
replacement, and whole-Product installation method as the interactive path.
The macOS job verifies the installed application signature before launch; the Windows job
exercises the intentionally unsigned Product without an Authenticode assertion.
The check requires the selected installed Runtime to reach `Ready` with its
native tray, and uses an Electron remote-debugging endpoint bound only to loopback for that
CI process to verify that one Desktop page loaded the packaged Web assets,
exposed the preload API, rendered the Workbench shell, and did not report a
closed Workbench connection. This observation surface does not add a Runtime
Control field, public diagnostic endpoint, or production test hook.

The smoke check then uses the managed CLI to request Product Quit. The command
must succeed, Runtime must become stopped, and the Desktop process must exit on
its own. A failed quit or lingering process fails the job. Failure cleanup may
terminate only the exact Desktop process tree started by the check; cleanup
never changes the failed verdict, suppresses the command result, or kills
Runtime processes by name. Every CLI invocation and CDP fetch has its own bound
inside the startup or shutdown deadline, so one hung probe cannot suspend the
job. Bounded polling waits for the one startup and the one shutdown already
requested; it does not retry either product action.

The job then invokes the public default whole-Product removal command. It
requires the accepted record to report that configuration was not preserved,
waits for the installed Desktop and `~/.debrute` to disappear, and verifies the
remaining owned projections: official Skills, home-level removal and projection
transactions, shell-write transactions, command PATH projection, login item,
Windows Apps & Features registration, Start Menu shortcut, and unused NSIS
installer cache. macOS also requires the detached Runtime capsule to disappear;
Windows deliberately schedules its executing capsule for deletion at reboot. A
deliberately unrelated Skill must survive. This closes the installed Product
lifecycle on every required macOS and Windows release target rather than
treating installation and launch alone as removal evidence.

Before building any Desktop platform target, its matrix job runs
`pnpm test:rust:native-watcher`. The command creates four real recursive notify
watchers through the Runtime's production default factory and
`ProjectFileWatcher` worker in one directly supervised probe process, writes a
change under each root, and requires a worker-delivered event from each. A
15-second probe deadline kills that exact process and fails the release job; it
does not retry or fall back to polling. On macOS, the diagnostic identifies the
FSEvents startup hang tracked by
[notify-rs/notify#942](https://github.com/notify-rs/notify/issues/942), without
converting it into success. Ordinary Runtime tests select the deterministic
watcher backend, while this native release gate retains explicit
production-wiring evidence on both macOS architectures and Windows.

The publish job requires three Product Installers, three complete Product
archives, and the signed manifest pair. It downloads only those release-artifact
namespaces and rejects any unexpected or duplicate name. A missing required eight-file
contract prevents publication. The expected eight-file list is also
the complete allowed list; release publication has no separate permissive asset
set.
