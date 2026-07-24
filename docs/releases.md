# Releases

Debrute publishes Desktop installers and Runtime-consumed complete Product
archives on GitHub Releases.

macOS Desktop builds are signed and notarized by Apple before publication.
Windows Desktop and Product binaries are Authenticode-signed. The complete
release targets are macOS arm64, macOS x64, and Windows x64.

The Desktop installer contains one versioned Product seed: signed Rust Runtime
and `debrute` CLI binaries, official Skills and model documentation, Web
workbench resources, declared native workers, the target's pinned Raster
Preview native libraries, and a strict Product manifest. Bootstrap validates
the seed, installs it under the user's Product root, and retargets stable
Runtime and CLI entrypoints to that version.

Settings under **General** and `debrute update` both call the same runtime product update capability. A product update keeps Desktop, runtime, CLI, and official Skills on the same product version.

Runtime updates select the Desktop asset that matches the current platform and architecture from the release asset contract below. If a newer release does not contain a matching Desktop asset, Debrute reports an update error instead of treating the product as up to date.

## Product Assembly And Materialization

The root package version, Cargo workspace, Desktop and plugin packages, Product
manifest, and every official Skill metadata version form one release-version contract.
`scripts/validate-release-version-contract.mjs` and release preflight reject a
tag whose `vX.Y.Z` value or packaged component versions disagree.

Desktop assembly creates one strict Product seed containing Runtime and CLI,
declared native workers, the target's checksum-pinned libvips payload, official
model documentation, official Skills, Web assets, and their hashes. On macOS,
the Runtime executable and the Product's single libvips payload live inside an
`LSUIElement` Runtime application bundle; both Runtime and the adjacent CLI load
that signed library. Windows keeps its DLLs beside the Runtime and CLI
executables. Bootstrap installs an exact
validated version under
`~/.debrute/products/versions/<version>` and selects it through `current`;
macOS Runtime and CLI wrappers live under `~/.debrute/bin/`. Windows keeps the
stable Runtime at `~/.debrute/products/current/runtime/debrute-runtime.exe` and
the CLI wrapper at `~/.debrute/bin/debrute.cmd`. Both launch surfaces supply
that exact Runtime path explicitly, and
official Skills are materialized under `~/.agents/skills/`. Runtime exposes any
validation or materialization failure through product status and doctor.

The Product seed is the only packaged owner of Workbench Web assets. Desktop
assembly consumes the complete current `apps/web/dist` output directly and
places it under `product-seed/web`; the Electron application does not carry an
independent `dist` copy. Assembly replaces its destination instead of merging
with an earlier output. Release coverage preloads a preexisting hashed Web asset
and proves that it is absent from both the assembled and archived seed.

The complete Product archive is a Runtime input, not a user installer. The CLI
and Skills are not independent GitHub Release downloads and do not have
independent installers, update streams, PATH editors, or checksum manifests.
They move with the Desktop/runtime product version. The accepted ownership
decision is recorded in
[`0006-product-version-is-runtime-owned.md`](./adr/0006-product-version-is-runtime-owned.md).

## Update Lifecycle

The General Settings page reads runtime product state, explicitly checks for an
update, and applies an available update. `debrute update` calls the same apply
operation; when no release is cached, apply performs a check first. Debrute does
not use Electron `autoUpdater`, updater YAML/blockmap files, release channels,
background polling, or a second Desktop-only update service.

The runtime reads GitHub's latest-release response only to locate the named
manifest and detached signature. It enforces small download limits, verifies the
exact manifest bytes with the compiled Ed25519 public key, rejects unsupported
fields and duplicate targets, then accepts only the fixed Debrute GitHub URL and
asset name for the selected platform and architecture. The installer download is
streamed to disk while enforcing the signed byte count and SHA-256 digest.

Before replacement, macOS additionally mounts the DMG read-only and opens only
the fixed `Debrute.app` directory at the mount root; it does not inventory or
choose among application bundles. Runtime requires that exact path to be a real
directory rather than a symbolic link, then verifies its application bundle id,
code signature, Gatekeeper assessment, and stapled notarization ticket. Runtime
stages and validates both the matching Desktop
installer and complete Product archive. Product Quit accepted before the
durable update commit boundary wins; after commit begins, replacement wins.
Runtime installs Desktop, advances `current`, and starts the exact target
Runtime without asking Workbenches for unload decisions or migrating live
connections, terminals, or Project Uses. The running Runtime commit path and
installed-Desktop pending recovery use one target-Runtime update launch
contract containing the verified target executable, selected Product version
and directories, stable Runtime entrypoint, and completion mode. macOS enters
the exact target application bundle through LaunchServices; Windows executes
the exact verified target binary. Ordinary first launch is not routed through
this update handoff. A missing input or native launch error fails explicitly;
neither update caller assembles a partial command, chooses another entrypoint,
or retries through the ordinary launch path. The target Runtime waits for the
old Control owner to exit, reports Ready, finalizes stable entrypoints and
official Skills, cleans the old version, and restores only the initiating
Desktop, browser, CLI, or bootstrap surface. No cross-platform replacement
helper, automatic update retry, or background polling is used. A crash leaves
one forward-only pending transaction that the target Runtime or installed
Desktop seed can continue. If native
Desktop installation fails before its durable boundary, the still-current
Runtime exposes an explicit apply error and only a new user-initiated Apply or
`debrute update` continues that same signed transaction; bootstrap does not
retry it automatically. Update failures remain explicit runtime product error
states and do not silently report the product as current.

After the target Runtime reports Ready, it durably claims the initiating-surface
continuation before opening Desktop or a browser page. Recovery therefore does
not duplicate windows or tabs. A crash between the claim and the native open can
suppress this convenience relaunch, in which case the user opens Debrute
normally; Runtime does not replay it.

## Product Icon Assets

`assets/project-icon/debrute.svg` is the only human-edited product icon source.
Run `pnpm icons:sync` to deterministically regenerate the Web favicon and Desktop
PNG, ICNS, ICO, and Dock assets. The generator source is authoritative for
the current output matrix and platform profiles; generated consumer assets are
not independent design sources and should not be edited by hand.

The Web build invokes icon sync before compilation, and the Desktop Electron
bundle copies the generated runtime assets from `apps/desktop/build/`. A missing
or invalid canonical SVG is a build-time error rather than a runtime fallback.

## Public Assets

Each `vX.Y.Z` release requires these public asset names:

```text
debrute-desktop-X.Y.Z-macos-arm64.dmg
debrute-desktop-X.Y.Z-macos-x64.dmg
debrute-desktop-X.Y.Z-windows-x64.exe
debrute-product-X.Y.Z-macos-arm64.zip
debrute-product-X.Y.Z-macos-x64.zip
debrute-product-X.Y.Z-windows-x64.zip
debrute-update-manifest.json
debrute-update-manifest.json.sig
```

## Photoshop Plugin Packages

The repository can build versioned Photoshop packages independently of the
Desktop release assets:

```sh
pnpm package:photoshop-uxp-plugin
pnpm package:photoshop-cep-plugin
pnpm package:photoshop-plugin
```

The UXP command creates `debrute-photoshop-uxp-X.Y.Z.ccx`; the CEP command
creates `debrute-photoshop-cep-X.Y.Z.zip`. Both packaging scripts validate the
required archive entries, and the plugin package and manifest versions must
match the root release version.

These plugin packages are not currently published by the tag-triggered GitHub
Release workflow. Adding them to that workflow requires an intentional change
to `scripts/release-asset-contract.mjs` and its release-contract tests; they must
not be treated as public release assets until that contract changes. Runtime
behavior and plugin boundaries are documented in
[`photoshop-bridge.md`](./photoshop-bridge.md).

## macOS Signing

macOS Desktop release jobs require these GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

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

Windows release jobs require `WINDOWS_CSC_LINK` and
`WINDOWS_CSC_KEY_PASSWORD`. The workflow signs and verifies the Rust Runtime and
CLI before assembling the Product archive, then passes the same certificate to
Electron Builder for the NSIS installer.

## Signed Manifest Verification

The product updater trusts only `debrute-update-manifest.json` after its detached Ed25519 signature in `debrute-update-manifest.json.sig` verifies against the public update key compiled into Debrute.

The rationale for making the signed manifest—not GitHub metadata or a plain
checksum file—the trust boundary is recorded in
[`0008-signed-manifest-authenticates-product-updates.md`](./adr/0008-signed-manifest-authenticates-product-updates.md).

The signed manifest lists the expected `sha256` and `sizeBytes` for every
Desktop installer and supported complete Product archive. For manual Desktop
downloads, compare the local hash output with the matching manifest entry before
installing:

```sh
shasum -a 256 debrute-desktop-X.Y.Z-macos-arm64.dmg
```

## Release Workflow

The tag-triggered workflow first validates versions and runs doctor, type
checking, tests, and architecture lint. Required matrix jobs build both macOS
architectures and Windows x64. macOS jobs require signing and
notarization credentials and must pass the repository signing verifier before
their artifacts can reach the publish job.

Every required macOS and Windows matrix job also starts its signed unpacked
Electron Builder application and runs the same packaged-product smoke check.
The check requires the bundled Runtime to reach `Ready` with its native tray,
and uses an Electron remote-debugging endpoint bound only to loopback for that
CI process to verify that one Desktop page loaded the packaged Web assets,
exposed the preload API, rendered the Workbench shell, and did not report a
closed Workbench connection. This observation surface does not add a Runtime
Control field, public diagnostic endpoint, or production test hook.

The smoke check then uses the bundled CLI to request Product Quit. The command
must succeed, Runtime must become stopped, and the Desktop process must exit on
its own. A failed quit or lingering process fails the job. Failure cleanup may
terminate only the exact Desktop process tree started by the check; cleanup
never changes the failed verdict, suppresses the command result, or kills
Runtime processes by name. Every CLI invocation and CDP fetch has its own bound
inside the startup or shutdown deadline, so one hung probe cannot suspend the
job. Bounded polling waits for the one startup and the one shutdown already
requested; it does not retry either product action.

The publish job requires three Desktop installers, three complete Product
archives, and the signed manifest pair. It rejects any unexpected or duplicate
name. A missing required eight-file contract prevents publication.
The expected eight-file list is also the complete allowed list; release
publication has no separate permissive asset set.
