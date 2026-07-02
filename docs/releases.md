# Releases

Debrute publishes Desktop installers as the public product assets on GitHub Releases.

macOS Desktop builds are signed and notarized by Apple before publication. Windows may show SmartScreen. Linux AppImage builds may require `chmod +x`.

The Desktop installer contains the runtime host, daemon, managed CLI payload, official Skills payload, Web workbench resources, product manifest, and replacement helper. On first launch, the runtime materializes the matching `debrute` CLI and official Skills under the user's Debrute-managed runtime state.

Settings under **General** and `debrute update` both call the same runtime product update capability. A product update keeps Desktop, runtime, CLI, and official Skills on the same product version.

Runtime updates select the Desktop asset that matches the current platform and architecture from the release asset contract below. If a newer release does not contain a matching Desktop asset, Debrute reports an update error instead of treating the product as up to date.

## Public Assets

Each `vX.Y.Z` release includes these public asset names:

```text
debrute-desktop-X.Y.Z-macos-arm64.dmg
debrute-desktop-X.Y.Z-macos-x64.dmg
debrute-desktop-X.Y.Z-windows-x64.exe
debrute-desktop-X.Y.Z-linux-x64.AppImage
debrute-update-manifest.json
debrute-update-manifest.json.sig
```

## macOS Signing

macOS Desktop release jobs require these GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

`CSC_LINK` contains the base64-encoded Developer ID Application `.p12` certificate. `APPLE_API_KEY` contains the App Store Connect `.p8` key material; the release workflow writes both credentials to temporary files before invoking Electron Builder and `notarytool`.

## Signed Manifest Verification

The product updater trusts only `debrute-update-manifest.json` after its detached Ed25519 signature in `debrute-update-manifest.json.sig` verifies against the public update key compiled into Debrute.

The signed manifest lists the expected `sha256` and `sizeBytes` for each Desktop installer. For manual downloads, compare the local hash output with the matching manifest entry before installing:

```sh
shasum -a 256 debrute-desktop-X.Y.Z-macos-arm64.dmg
```

On Linux, use:

```sh
sha256sum debrute-desktop-X.Y.Z-linux-x64.AppImage
```
