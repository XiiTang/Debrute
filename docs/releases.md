# Releases

Debrute publishes Desktop installers and Debrute CLI archives on GitHub Releases.

macOS Desktop builds are signed and notarized by Apple before publication. Windows may show SmartScreen. Linux AppImage builds may require `chmod +x`.

The Desktop app checks for application updates from GitHub Releases after startup on packaged Windows builds. Settings under **General** can also check, download, and install Desktop updates manually. macOS and Linux Desktop updates are manual downloads from GitHub Releases in this version.

## Public Assets

Each `vX.Y.Z` release includes these public asset names:

```text
debrute-desktop-X.Y.Z-macos-arm64.dmg
debrute-desktop-X.Y.Z-macos-x64.dmg
debrute-desktop-X.Y.Z-windows-x64.exe
debrute-desktop-X.Y.Z-windows-x64.exe.blockmap
debrute-desktop-X.Y.Z-linux-x64.AppImage
latest.yml
debrute-cli-X.Y.Z-macos-arm64.tar.gz
debrute-cli-X.Y.Z-macos-x64.tar.gz
debrute-cli-X.Y.Z-linux-arm64.tar.gz
debrute-cli-X.Y.Z-linux-x64.tar.gz
debrute-cli-X.Y.Z-windows-arm64.zip
debrute-cli-X.Y.Z-windows-x64.zip
debrute_SHA256SUMS
```

## macOS Signing

macOS Desktop release jobs require these GitHub Actions secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

`CSC_LINK` contains the base64-encoded Developer ID Application `.p12` certificate. `APPLE_API_KEY` contains the App Store Connect `.p8` key material; the release workflow writes both credentials to temporary files before invoking Electron Builder and `notarytool`.

## Checksum Verification

Verify manual downloads against `debrute_SHA256SUMS` from the same release tag before installing.

Filter the manifest to the asset you downloaded:

```sh
grep "  debrute-cli-X.Y.Z-macos-arm64.tar.gz$" debrute_SHA256SUMS | shasum -a 256 -c -
```

On Linux, use:

```sh
sha256sum -c --ignore-missing debrute_SHA256SUMS
```

## CLI Installation And Skills Sync

Debrute CLI is managed from Debrute Desktop Settings under **Debrute CLI**.

The Desktop app downloads the matching CLI archive from the same GitHub Release, verifies `debrute_SHA256SUMS`, installs the command as `debrute`, and runs:

```sh
debrute skills sync
```

Manual Skill commands:

```sh
debrute skills status
debrute skills sync
debrute skills sync --force
```

`debrute skills sync --force` restores all official Debrute Skills. Normal sync updates installed official Skills and adds newly introduced official Skills without restoring official Skills the user removed.
