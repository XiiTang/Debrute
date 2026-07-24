# Local Integrations

Integrations are optional local command-line capabilities detected and managed
by the shared runtime. They are not required for Debrute startup, are not
bundled with Debrute, and are not exposed through the `debrute` command.

## Catalog And Status

The fixed integration catalog currently contains FFmpeg (including `ffprobe`),
ImageMagick, MediaInfo, ExifTool, and `remove-ai-watermarks`. Each entry declares
its binaries, version probe, category, and one supported installation backend.
The catalog source—not UI input—is the authority for package identifiers and
commands.

The runtime resolves binaries from `PATH`, executes bounded version probes, and
reports each integration as ready, not found, or probe failed. An integration
with multiple required binaries is ready only when all are ready. Status scans
are cached for 30 seconds unless the user requests a rescan or an operation
invalidates the cache.

## Install Backends

Media integrations use Homebrew on macOS and winget on Windows. The Python CLI
integration prefers `uv` and falls back to `pipx` when `uv` is unavailable.

Available install, update, and uninstall actions are derived from the detected
integration state, backend availability, and package-manager query. The
Integrations Settings page submits only an integration id and operation. It does
not accept commands or package names and does not show or execute a user-edited
command preview.

## Operation Boundary

Runtime owns one process-wide operation lock, so only one integration
operation runs at a time. The runtime revalidates the integration, backend, and
available action before deriving the executable and argument vector from the
catalog. Commands use direct process spawning without a shell, have bounded
captured output and diagnostics, and time out rather than running indefinitely.

Once catalog execution starts, the Integration service owns it through its
settled result. Closing or reloading the initiating Workbench does not cancel
the package-manager process; a later Workbench observes the current in-flight
state through the global settings snapshot and subsequent settings changes.
Product Quit still terminates the owned child process.

The UI disables all integration actions and rescanning while an operation is in
flight. Runtime events publish the running and settled settings views. After an
attempt completes, the runtime performs a fresh status scan; expected failures
return structured diagnostics instead of being converted into successful state.
Rescan and operation command responses contain only their closed outcome and any
operation diagnostic. The initiating Workbench does not apply a second settings
view from that response: like every other open Workbench, it updates from the
ordered Global Integration event. UI command progress is independent of that
authoritative projection, with no response-revision wait or response-state
fallback.
The settled projection is part of completing the operation result: Runtime does
not return a successful command result after failing to publish that projection.
Exhausting the internal Global revision or integration generation is an
unrecoverable Runtime invariant failure rather than an Integration diagnostic;
the process exits instead of continuing with Workbenches observing different
states. A later explicit launch performs the ordinary fresh status scan.

This remains a domain-specific operation boundary. The initial Runtime
Operation initiative covers only model generation and explicitly retains this
Integration exception; it must not wrap the service in a partial generic
registry, detached-job API, or compatibility layer.

This catalog-defined execution boundary is recorded in
[`0010-integration-operations-are-catalog-defined.md`](./adr/0010-integration-operations-are-catalog-defined.md).

## Third-Party Responsibility

Third-party integrations remain independent software. Debrute detects them and
may invoke their own package-manager installation flows, but it does not bundle
or redistribute them. Users are responsible for each tool's installation terms
and license.

Adobe Bridge is a separate Debrute-to-Photoshop protocol rather than a catalog
integration. See [`photoshop-bridge.md`](./photoshop-bridge.md).

## Executable Authorities

- Catalog, probes, fixed backends, and operation ownership:
  `apps/runtime/src/integrations.rs`.
- Bounded native process execution:
  `apps/runtime/src/integration_process.rs` and `apps/runtime/src/workers.rs`.
- Settings UI: `apps/web/src/workbench/settings/integrations/`.
- Protocol shapes: `packages/app-protocol/src/index.ts`.
