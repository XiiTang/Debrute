# Photoshop Bridge

Photoshop Bridge connects paired Photoshop plugin instances to open Debrute
Projects through the local Rust Runtime. It is a closed Photoshop protocol with
thin UXP and CEP host adapters; it is neither a second Project service nor a
general plugin platform.

## Runtime State And Discovery

The persisted Photoshop Bridge enabled preference belongs to Runtime-global
settings. Pairing public keys live in a separate bounded registry. Discovery
availability, connected clients, Project links, HTTP bearers and transfer
history are memory-only live state. Disabling the Bridge clears outstanding
pairing codes, sessions and links, revokes bearers, and fails active transfers.

Plugin clients discover the current Runtime through a loopback-only HTTP server
on `127.0.0.1:32124` at `/adobe-bridge/discovery`. Its versioned response names
the dynamic Workbench HTTP and WebSocket endpoints and whether the feature is
enabled. The listener accepts only the exact numeric Host, loopback peers and
the fixed UXP/CEP Origins. Discovery returns no credential and enables no CORS
credentials; its dynamic-location response is never cacheable.

Each plugin instance creates a P-256 key in host secure storage. First pairing
requires both a signature over a fresh five-second Runtime challenge and the
one-use twelve-character code shown by the Workbench. The code belongs to one
browser session, expires after five minutes and is invalidated after five
addressed failures. Runtime persists only the public key. Later connections
prove that key against a fresh challenge; a successful socket receives a
random, memory-only HTTP bearer bound to that live session.

## Links And Trust Boundary

A Project and a live paired Photoshop instance must be explicitly linked before
either transfer direction is allowed. A link owns a typed `photoshop-link`
Project Use and
exists only while the plugin session exists. The Photoshop-scoped state includes
only the requesting instance, its links and transfers, the names of open
Projects, and directory trees only for Projects to which it is linked.

Plugins receive neither browser/CLI credentials nor absolute Project paths.
The session bearer authorizes only the Photoshop route group and derives the
plugin identity; callers cannot assert a client id. Plugins address files and
target directories with Project-relative paths. Project-to-Photoshop content
uses a short-lived, random, one-use token plus the bearer;
consumption rechecks the current Project link and returns the already verified
open file handle.
Photoshop-to-Project uploads pass through the linked session and exact Project
revision boundary. The rationale is recorded in
[`0009-photoshop-bridge-uses-link-scoped-protocol.md`](./adr/0009-photoshop-bridge-uses-link-scoped-protocol.md).

## Transfers

Debrute can send visible Project PNG, JPEG, WebP, and PSD files to a linked
Photoshop client, which places the downloaded file as a Smart Object. Photoshop
can export selected top-level layers as PNG files to a visible Project
directory. Uploads are limited to 100 MiB, written atomically, and named from a
sanitized layer name; conflicts receive numeric suffixes such as `Layer 2.png`.

Protected or internal Project paths are never offered as destinations. Uploads
must have an exact declared length, PNG media type and PNG signature. A transfer
has one five-minute deadline and owns a typed Project transfer lease until it is
terminal. The live view retains a bounded recent terminal history and exposes
explicit disabled, offline, unlinked, unsupported, expired, size, placement,
and timeout failures. Runtime never retries or replays a transfer.

## UXP And CEP Clients

`packages/photoshop-bridge-plugin-core` owns discovery, key storage and signing,
the WebSocket client, Project tree and selection state, and transfer
orchestration without importing Photoshop APIs. Both plugin applications use
this core and the same Runtime messages. `clientRuntime` is a closed `uxp` or
`cep` identity fixed at pairing, not a caller-defined protocol fork.

The UXP adapter uses Photoshop UXP imaging and action APIs to export selected
top-level layers and place received files. The CEP adapter performs the same
host operations through CEP filesystem APIs and a small explicit ExtendScript
bridge. Host-specific code does not own links, Project access, or transfer
state.

Unexpected disconnect revokes the bearer, links and active work. There is no
automatic reconnect loop. A planned product replacement may send one bounded
`runtime_replacing` notice so the plugin can rediscover after shutdown; the new
Runtime proves the persisted key into a fresh session and does not migrate links
or transfers.

## Packaging And Publication

Run `pnpm package:photoshop-uxp-plugin` to create
`debrute-photoshop-uxp-X.Y.Z.ccx`, `pnpm package:photoshop-cep-plugin` to create
`debrute-photoshop-cep-X.Y.Z.zip`, or `pnpm package:photoshop-plugin` for both.
The packaging scripts build each plugin and validate required archive entries.
Plugin package and manifest versions participate in the repository release
version contract.

These package artifacts are not currently part of the GitHub Release public
asset contract. The tag-triggered release workflow publishes only the four
Desktop installers plus the signed update manifest and signature described in
[`releases.md`](./releases.md).

## Executable Authorities

- Runtime discovery, pairing, session, link and transfer authority:
  `apps/runtime/src/photoshop/`.
- Dynamic HTTP and WebSocket composition: `apps/runtime/src/workbench/`.
- Project filesystem and exact-revision mutation authority:
  `apps/runtime/src/project/`.
- Workbench settings and send dialog:
  `apps/web/src/workbench/settings/adobe-bridge/` and
  `apps/web/src/workbench/adobe-bridge/`.
- Shared plugin behavior: `packages/photoshop-bridge-plugin-core/`.
- Host adapters: `apps/photoshop-uxp-plugin/` and
  `apps/photoshop-cep-plugin/`.
- Package creation: `scripts/package-photoshop-uxp-plugin.mjs` and
  `scripts/package-photoshop-cep-plugin.mjs`.
