# Runtime Architecture

Debrute runs one shared Rust Runtime per operating-system user. Runtime is the
authority for Project files, global settings and secrets, model generation,
integrations, product updates, Workbench connections, Photoshop links, and
terminal processes. Web Workbench, Desktop, plugins, and the `debrute` CLI are
clients; none owns a parallel backend or a copy of authoritative state.

## Discovery And Lifecycle

Runtime owns the native single-instance endpoint. macOS uses a current-user
Unix-domain socket and owner lock; Windows uses a current-user-SID named pipe,
mutex, peer verification, and DACL. The handshake fixes protocol version and
the public `launcher` or `cli` role before a connection gains commands. Desktop
uses a launcher connection and is promoted internally when it activates the
Desktop host; `desktop_host` is not a public wire role.

Starting Desktop, the CLI, or a source-development command first connects to
Control; only an absent owner may start Runtime. The same Runtime process owns
the macOS menu-bar item or Windows notification-area icon; Desktop owns no tray.
Runtime has no idle exit and no dependency on a frontend remaining open.
Closing the final Desktop window exits Electron but leaves Runtime and its tray
running. Runtime exits only after Product Quit, product replacement,
operating-system termination, or an unexpected process failure. An
unrecoverable fault in a required in-process native component is such a process
failure; it is not isolated in a helper process and does not trigger an
automatic restart. A later explicit Desktop, CLI, or development launch starts
a new Runtime normally.

The tray exposes Runtime status, explicit Desktop and browser entry points,
Start at Login, and Product Quit. It does not expose update controls, recent
Projects, diagnostics, restart, or copied launch URLs. macOS activation opens
the menu; Windows primary activation opens Desktop and secondary activation
opens the menu. A tray creation failure exits Runtime before services start or
`Ready` is published, and the launcher reports the startup failure. There is
no trayless fallback, retry loop, or degraded Runtime status. Linux tray
behavior is outside the supported product design.

On macOS, Runtime is packaged and launched as an `LSUIElement` application so
the status item has a stable native application identity without a Dock icon.
The bundle contains the same single Rust Runtime executable; it is not another
process or a Supervisor. Runtime selects the accessory activation policy and
owns the `tao` main-thread native event loop required by the status item.
Runtime services and the blocking Control accept loop run on owned worker
threads. Product shutdown wakes the blocking native endpoint, joins it, and
then lets the native event loop remove the status item as the process exits.
Initial launch and target-version replacement both enter this bundle through
LaunchServices; replacement may start the target bundle while the old process
still owns Control, but only the target Rust process waits to claim that same
single-instance endpoint.

Product Quit is immediate product-level shutdown. Runtime rejects new work,
notifies Desktop to close, stops accepting Workbench HTTP connections, ends
every live Workbench stream and credential, terminates owned operations and
terminals, releases native endpoints and workers, removes its tray, and exits.
It does not ask Workbenches to save or submit state and has no blocker or
confirmation protocol. Unsaved text and feedback are already protected by
Runtime Working Copies. In-process native components receive no separate drain
or shutdown phase; process exit owns their final termination.

Source development runs the same Rust Runtime plus Vite. Vite proxies relative
Workbench HTTP and WebSocket traffic to the exact Runtime origin; it does not
host privileged services or persist a discovery credential. Packaged Runtime
serves the version-selected Web assets itself.

Before publishing `Ready`, Runtime initializes and validates every required
in-process native component, including the exact packaged Raster Preview
libvips version. Required-component failure is a Runtime startup failure and is
reported by the launcher or bootstrap; Runtime does not become ready with a
lazy first-use failure or an alternate backend. Such components initialize
once for the Runtime process lifetime and are never stopped and reinitialized
inside that process.

## Role-Partitioned Transport

Native Control is a narrow lifecycle and activation channel. Its request set is
limited to activation, inspection, CLI authorization, source-development
origin registration, one-use Desktop window tickets, Desktop-window close, and
Product Quit. Recent Projects and Desktop open/focus/exit instructions are its
only events. Project, Canvas, settings, generation, file, and terminal work
does not travel over Control.

Runtime exposes one dynamic loopback Workbench origin. A browser launch creates
an HttpOnly, host-only, SameSite-Strict session. Desktop instead receives a
one-use in-memory launch ticket over Control and passes it from Main to the
renderer through one narrow preload call; the BrowserWindow loads a stable URL
with no credential in its URL. A ticket has no disk persistence or timer-based
lifetime and is removed atomically when consumed.

Each loaded Workbench opens one POST SSE connection at
`/api/workbench/connection`. Its first frames establish an in-memory connection
credential, the complete Global snapshot, and either a Project binding or an
explicit open failure. Commands send the credential in a same-origin header.
There are no split Global/Project event streams, reconnect window, heartbeat,
unload release, or automatic request replay. Unexpected connection end is a
terminal page state; refreshing creates a new connection.

Passive Project media GETs remain authorized by the live browser session.
CLI authorization and Photoshop pairing use separate, route-limited sessions
and cannot be substituted for a Workbench connection.

## Global And Project State

Runtime's global store is the sole persistence boundary for Workbench
preferences, recent Project roots, model overrides and API keys, and Photoshop
bridge settings. Recent Projects persist only the mapping from stable Project
id to canonical root. Non-secret settings and secrets use separate atomic
files; public projections expose only whether a key is set and a non-secret
preview. Global events carry an ordered `globalRevision` independent of Project
state.

The public stable Project identity is `.debrute/project.json.project.id`.
Runtime rejects invalid or duplicate stable ids instead of deriving aliases
from roots or generating compatibility identities. A loaded Project session
owns one canonical root, snapshot, monotonic `projectRevision`, serialized
mutation authority, watcher, terminals, and typed Project Uses. The use kinds
are Workbench, request, operation, running terminal, transfer, and Photoshop
link. Releasing the final use closes the session immediately; there is no idle
retention, grace period, reservation worker, or fixed session cap.

Opening from an unbound Workbench and replacing from a bound Workbench are the
only binding operations. Target validation finishes before an atomic replace;
opening the current target is a no-op. Each Project has at most one Workbench.
Opening an already-open Project from another Desktop window focuses the
existing window. When Web owns the Project, an ordinary Desktop open stays on
the root surface and requires **Open Here**; it does not silently take
ownership. A Web Workbench, or an explicit Desktop **Open Here** action,
preempts the current Workbench. A preempted Desktop window stays open on the
unbound topology route, while its renderer preserves the last Project
presentation as a read-only detached surface with **Open Here**. It is not
closed, silently rebound, or allowed to retain Project command authority.

Project mutations are serialized and semantically validated. Commands return
their outcome; ordered stream events carry authoritative state. A stale or
missing response is never permission to replay a state-changing command.

## Working Copies And Terminal Lifetime

Runtime persists unsaved text values and the current feedback draft as Working
Copies under its private state directory, keyed by the stable Project id.
Editing writes the complete current value; a successful matching save or an
explicit discard clears it. Working Copies have no time-to-live or arbitrary
count cap and are restored in the next Project binding. Reconstructible Canvas
camera, selection, and panel state remains frontend-local and is not a Working
Copy.

Runtime owns PTYs and holds a `running-terminal` Project Use independently of a
Workbench connection. One Project-scoped WebSocket transports terminal
topology, input, resize, output, and exit events. Unexpected socket loss is
terminal for that loaded Workbench; it is not automatically reconnected and
input is never replayed. Rebinding, preemption, or Workbench connection end
closes that socket while the Runtime-owned PTY remains alive. Project or
Runtime shutdown terminates owned PTYs.

## Product Version Ownership

Desktop, Runtime, CLI, Web assets, official Skills, and model documentation
share one Product version. Desktop embeds a complete seed for fresh install.
Runtime validates and materializes immutable versions under
`~/.debrute/products/versions/<version>`, selects `current`, and publishes stable
entrypoints. Product Quit accepted before the update commit boundary wins;
after commit begins, replacement wins. Update continuation does not migrate
Workbench connections, terminal sessions, or Project Uses. See
[`releases.md`](./releases.md).

## Executable Authorities

- Native ownership, lifecycle, and tray: `apps/runtime/src/control/`,
  `apps/runtime/src/main.rs`, and `apps/runtime/src/tray.rs`.
- Workbench sessions, connections, Working Copies, and routing:
  `apps/runtime/src/workbench/`.
- Global configuration: `apps/runtime/src/global/`.
- Project sessions, typed uses, and revisions:
  `apps/runtime/src/project/registry.rs` and `service.rs`.
- Desktop window host: `apps/desktop/src/electron/`.
- Terminal ownership: `apps/runtime/src/terminal/`.
- Product bootstrap and update: `apps/runtime/src/product/`.
- Browser client connection: `apps/web/src/api/httpWorkbenchApiClient.ts` and
  `apps/web/src/workbench/WorkbenchApp.tsx`.

`pnpm verify:browser` is an explicit development diagnostic and is not part of
`pnpm verify`. Run it only when live browser verification is intentionally in
scope.
