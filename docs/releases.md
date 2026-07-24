# Releases

Debrute publishes Desktop installers and Runtime-consumed complete Product
archives on GitHub Releases.

macOS Desktop builds are signed and notarized by Apple before publication.
Windows Desktop and Product binaries are Authenticode-signed. Linux is a
best-effort extra distribution only: product design, implementation, updater
support, and acceptance do not target Linux.

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
stable entrypoints live under `~/.debrute/bin/`, and
official Skills are materialized under `~/.agents/skills/`. Runtime exposes any
validation or materialization failure through product status and doctor.

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

Before replacement, macOS additionally mounts the DMG read-only and verifies the
application bundle id, code signature, Gatekeeper assessment, and stapled
notarization ticket. Runtime stages and validates both the matching Desktop
installer and complete Product archive. Product Quit accepted before the
durable update commit boundary wins; after commit begins, replacement wins.
Runtime installs Desktop, advances `current`, and starts the exact target
Runtime without asking Workbenches for unload decisions or migrating live
connections, terminals, or Project Uses. The target Runtime waits for the old Control owner to exit,
reports Ready, finalizes stable entrypoints and official Skills, cleans the old
version, and restores only the initiating Desktop, browser, CLI, or bootstrap
surface. No cross-platform replacement helper, automatic update retry, or
background polling is used. A crash leaves one forward-only pending transaction
that the target Runtime or installed Desktop seed can continue. If native
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

`debrute-desktop-X.Y.Z-linux-x64.AppImage` is uploaded only when its
best-effort matrix job succeeds. It is not required for publication and is not
part of the signed Runtime update manifest.

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

`CSC_LINK` contains the base64-encoded Developer ID Application `.p12` certificate. `APPLE_API_KEY` contains the App Store Connect `.p8` key material; the release workflow writes both credentials to temporary files before invoking Electron Builder and `notarytool`.

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

On Linux, use:

```sh
sha256sum debrute-desktop-X.Y.Z-linux-x64.AppImage
```

## Release Workflow

The tag-triggered workflow first validates versions and runs doctor, type
checking, tests, and architecture lint. Required matrix jobs build both macOS
architectures and Windows x64. A tolerated Linux x64 job may add an AppImage,
but its failure cannot block publication. macOS jobs require signing and
notarization credentials and must pass the repository signing verifier before
their artifacts can reach the publish job.

The publish job requires three macOS/Windows Desktop installers, three complete
Product archives, and the signed manifest pair. It accepts the one known Linux
AppImage when available, rejects any other unexpected or duplicate name, and
does not sign Linux into the update manifest. A missing required eight-file
contract prevents publication.
