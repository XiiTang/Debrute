# Runtime Coordinates Platform-Specific Product Replacement

The Rust Runtime owns update discovery, download, signed-manifest and platform
verification, staging, the update commit race, Desktop shutdown, and the
planned relaunch intent. macOS performs verified application replacement and
Windows runs the held, signed NSIS installer through Runtime-owned platform
adapters after Desktop exits. Neither platform needs a replacement helper:
Runtime executes from an immutable versioned Product directory, so the old
Runtime never replaces its own live executable. It selects the new `current`
target and starts that target in a bounded Control-owner handoff mode. The
running Runtime commit path and installed-Desktop pending recovery share one
target launch contract that binds the held manifest-verified executable,
selected Product identity and directories, stable Runtime entrypoint, and
completion mode before the platform adapter launches it. macOS enters the exact
target bundle through LaunchServices; Windows executes the exact verified
binary. Ordinary first launch remains a separate stable-entrypoint acquisition
path. The new Runtime completes Ready, cleanup, and surface restoration. The
platform/update owner launches the selected replacement target directly;
Debrute does not add a helper layer required only by a different installation
layout. Update authenticity remains governed by
[ADR 0008](./0008-signed-manifest-authenticates-product-updates.md).

The Windows filesystem boundary is the in-process
`packages/windows-product-fs` safety capsule. It is the sole workspace crate
permitted to contain reviewed `unsafe` Windows API calls, limited to junction
creation and in-place retargeting, file identity, and durable directory/reparse
flushes. The crate inherits the workspace's current Clippy policy explicitly;
all release trust and transaction authority remain in the safe Runtime crate.
The Windows release job executes the Rust workspace tests on a Windows host so
the junction and locked-handle contracts are exercised against real reparse
points, not only cross-compiled. Every product transaction also reclaims only
its exact UUID-named staging, installer, and temporary-pointer artifacts while
holding the product lock; unrelated product-root entries remain untouched.
