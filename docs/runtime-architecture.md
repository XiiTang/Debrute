# Runtime Architecture

Debrute runs one shared Rust Runtime per operating-system user. Runtime is the
authority for Project files, global settings and secrets, model generation,
integrations, product updates, Workbench connections, Photoshop links, and
terminal processes. Web Workbench, Desktop, plugins, and the `debrute` CLI are
clients; none owns a parallel backend or a copy of authoritative state.

The downloaded Product has already selected macOS or Windows. Each native
release job builds matching Workbench assets with one closed `darwin` or
`win32` constant, so Runtime bootstrap does not transport a second platform
value for renderer behavior. Workbench never infers the Product target from
browser platform or User-Agent values.

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
The complete acquire-or-connect, optional launch, handshake, and `Starting`
polling sequence has one absolute fifteen-second deadline. Reaching Control or
completing the handshake does not restart that budget. Expiry closes the
launcher connection, reports `runtime_ready_timeout`, and sends no activation;
it does not terminate or replace the Runtime owner, start a competing Runtime,
or use another frontend. A Runtime which still reports `Starting` retains its
independent lifecycle. `debrute runtime stop` is the explicit termination path:
it connects only to an existing owner and requests Product Quit without a
`Ready` wait.
Runtime has no idle exit and no dependency on a frontend remaining open.
Closing the final Desktop window exits Electron but leaves Runtime and its tray
running. Runtime exits only after Product Quit, product replacement,
operating-system termination, or an unexpected process failure. An
unrecoverable fault in a required in-process native component is such a process
failure; it is not isolated in a helper process and does not trigger an
automatic restart. A later explicit Desktop, CLI, or development launch starts
a new Runtime normally.

Expected operational failures are typed `Result` values and fail only their
owning request or work item. An unexpected panic is a code defect and
terminates Runtime immediately, before the process can continue with possibly
inconsistent in-memory authority. Runtime does not catch a panic to fabricate a
normal work failure, recover the inner value of a poisoned authoritative lock,
advertise a degraded status, or run a panic-specific graceful-shutdown path.
The ordinary Product Quit path remains only for controlled shutdown.

The monotonic Global event revision and integration-projection generation remain
ordering counters, not recoverable capacity budgets. Exhausting either counter
means Runtime can no longer publish one authoritative ordered state, so it is a
process-fatal invariant failure. Runtime does not preserve a successful command
result while dropping its settled projection, return a degraded success, or
continue with Workbenches observing different Global state.

Control owns one internal lifecycle state: `Starting`, `Ready`, update
preparation with its transaction id, `Exiting`, or replacement with its
transaction id. The four public Runtime statuses are projections of that state;
update preparation remains publicly `Ready`. The supervision loop observes the
same state to begin controlled shutdown. A terminal state cannot be overwritten
by later startup completion. Operating-system termination ends the process
directly.

The tray exposes Runtime status, explicit Desktop and browser entry points,
Start at Login, and Product Quit. It does not expose update controls, recent
Projects, diagnostics, restart, or copied launch URLs. macOS activation opens
the menu; Windows primary activation opens Desktop and secondary activation
opens the menu. A tray creation failure exits Runtime before services start or
`Ready` is published, and the launcher reports the startup failure. There is
no trayless fallback, retry loop, or degraded Runtime status.

The Start at Login check item reflects the exact operating-system login
registration last confirmed by Runtime. A user change performs one registration
write using the selected check state. A successful write confirms that state;
a failed write restores the previously confirmed check state and places the
exact operating-system error in that menu item's label. Runtime does not leave
an optimistic state, silently downgrade the failure to a log message, or retry
through a different registration path.

The login registration always names the explicit stable Runtime entrypoint
provided by the Product or source-development launcher. That non-empty absolute
path is required before Runtime creates its tray or publishes `Ready`. Runtime
does not substitute its current version-selected or build-output executable;
missing or invalid stable-entrypoint input is a startup failure rather than a
degraded tray or fallback registration.

Product replacement has one target-Runtime launch contract shared by the
running Runtime's commit path and installed-Desktop recovery. It binds the
manifest-verified target executable, selected Product version and directories,
stable Runtime entrypoint, and update-completion mode before native launch.
macOS launches the exact target application bundle through LaunchServices;
Windows launches the exact verified target executable. Missing launch input,
native launch failure, or target argument rejection fails the update handoff;
neither caller reconstructs a partial command or selects another entrypoint.
Ordinary first launch remains a separate stable-entrypoint acquisition path.

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

The canonical Complete Mascot Mark generates two Runtime-owned tray images.
macOS uses one transparent monochrome template containing the whole character;
cream facial features are transparent negative space. Windows uses one
transparent full-color image of the same whole character. Runtime does not
reuse a Desktop application icon, consume Desktop build resources, retain a
partial mascot, or retain separate status-badge images. Runtime status remains
text in the tray menu.

Product Quit is immediate product-level shutdown. Runtime rejects new work,
notifies Desktop to close, stops accepting Workbench HTTP connections, ends
every live Workbench stream and credential, terminates owned operations and
terminals, releases native endpoints and workers, removes its tray, and exits.
It does not ask Workbenches to save or submit state and has no blocker or
confirmation protocol. Unsaved text and not-yet-accepted Canvas Feedback values
are already protected by Runtime Working Copies; accepted Canvas Feedback is
Runtime state, while composition without non-empty text is disposable. In-process
native components receive no separate drain or shutdown phase; process exit
owns their final termination.

An early Desktop Command-Q is still Product Quit. Desktop finishes its one
in-progress Control acquisition and submits the request once before opening a
window; it does not reinterpret the action as frontend exit, cancel or restart
Runtime startup, or establish a second connection.

Source development runs the same Rust Runtime plus Vite. Vite proxies relative
Workbench HTTP and WebSocket traffic to the exact Runtime origin; it does not
host privileged services or persist a discovery credential. Packaged Runtime
serves the version-selected Web assets itself.

Runtime finishes its in-process service composition before the Workbench HTTP
listener starts. The immutable router state owns one required CLI adapter and,
for a packaged Product, one Product adapter alongside the core Runtime
authorities. Core services do not retain those adapters, and each adapter
receives only the current authorities it calls. There are no late CLI/Product
installers, temporarily empty service slots, adapter-to-container ownership
cycles, or shutdown-time cycle breaking.

Product capability is fixed by the process launch mode. A packaged Runtime
starts with Product routes and Product state; a source-development Runtime
starts without them and does not register Product HTTP routes. That absence is
not a degraded or temporarily unavailable Product service. The required CLI is
present in both modes, while its Product Update command reports the explicit
source-development capability error rather than a service-availability error.

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
origin registration, one-use Desktop window tickets, non-final Desktop-window
close, and Product Quit. Closing the Desktop host connection unregisters that
host and drains its complete remaining window topology; the final native window
does not need a separate close request. Recent Projects and Desktop
open/focus/exit instructions are Control's only events. Project, Canvas,
settings, generation, file, and terminal work does not travel over Control.
Publishing a new recent-Projects projection updates Runtime's ordered state and
fans the event out to current Desktop hosts without returning a delivery result
to the Global publisher. Failure to enqueue closes that Control connection under
the existing outbound transport contract; it does not roll back the projection,
fail Runtime composition, or retry through another connection.
Runtime initializes this projection from Global state before becoming Ready; a
launcher cannot become the Desktop host before that initialization. Control does
not synthesize an empty revision-zero projection when the required snapshot is
absent.

Runtime exposes one dynamic loopback Workbench origin. One ordinary browser
storage partition creates and reuses an HttpOnly, host-only, SameSite-Strict
session across its concurrent tabs. Desktop instead receives a one-use
in-memory launch ticket over Control together with the current Runtime-owned
Workbench theme preference. The preference is a launch-time presentation
snapshot, not a general settings API or Desktop-owned state. Main resolves it
against Electron's native system theme before creating the window and passes
only the ticket to the renderer through one narrow preload call; each
BrowserWindow has an isolated storage partition and loads a stable URL with no
credential in its URL. Missing or invalid launch presentation fails the window
launch rather than falling back to another theme. A ticket has no disk
persistence or timer-based lifetime and is removed atomically when consumed.

Each loaded Workbench opens one POST SSE connection at
`/api/workbench/connection`. Its first frames establish an in-memory connection
credential, the complete Global snapshot, and either a Project binding or an
explicit open failure. A browser session may contain multiple document
connections; commands send one connection's credential in a same-origin header
and Runtime validates the cookie and credential together. There are no split
Global/Project event streams, reconnect window, heartbeat, unload release, or
automatic request replay. Unexpected connection end is a terminal page state;
refreshing creates a new connection.

That initial snapshot and the subsequent ordered Global change events are the
Workbench's sole projections of Global settings, Integration settings, and
packaged Product state. A connected Workbench does not issue a second read to
initialize the same state. Mutating and action commands return only their
closed command outcome and any action-specific diagnostic; they do not return
another complete state for the initiating Workbench to apply. Command progress
is local interaction state and ends with the command response, while displayed
authoritative state changes only when its Global event is applied. Runtime does
not add a command-response revision wait or use response state as a fallback if
the event connection fails; unexpected connection end remains terminal for the
page.

Passive Project media GETs remain authorized when the live browser session has
a live connection bound to the requested Project.
CLI authorization and Photoshop pairing use separate, route-limited sessions
and cannot be substituted for a Workbench connection.

Project file plans remain transport-neutral: they express an optional byte
range, not a numeric HTTP status. The Workbench HTTP adapter maps a complete
file to typed `200 OK` and a range to typed `206 Partial Content`. HTTP service
errors likewise own a valid typed status when they are created. Runtime does not
round-trip either case through an arbitrary integer or replace an invalid status
with a successful or generic fallback response.

## Model Operation Lifetime

The current Operation subsystem is deliberately narrow. It covers only CLI-
submitted Model Requests for the five Model Kinds: image, video, TTS, music,
and sound effect. Single and Batch are two execution shapes of one Model
Operation; a Batch Item is a settled result inside its parent Operation rather
than a child Operation. Integration install/update/uninstall, Product Update,
terminal processes, Canvas preview work, and professional-tool transfers keep
their own domain lifetimes and do not enter the Model Operation registry.

Before acceptance, Runtime validates the live CLI credential, canonical
Project identity, complete strict JSONL input, Model availability, execution
options, and output paths. It reads one validated Global configuration and
secret snapshot, creates one immutable Accepted Model Binding per unique Model
ID, and validates every request against its binding. Repeated requests for one
Model share one binding. Rejection creates no Operation and starts no paid
model work. Acceptance issues one opaque UUID and linearizes the Operation
through `queued`, `running`, optional `cancelling`, and exactly one of
`succeeded`, `failed`, or `cancelled`. Independent
Operations start independently; only a Batch's own concurrency limits how many
of its Items run at once. Runtime never automatically retries a failed Model
Request.

An accepted Operation never re-resolves Model Settings. Its bindings keep each
effective route and credential atomic while later Settings changes affect only
later Operations; explicit cancellation revokes pending use in an accepted
Operation. Bindings remain private Runtime memory only while requests can use
them and are absent from serialized snapshots, logs, Project data, and retained
terminal records.

Ordinary execution failures remain typed `Result` values and settle the
Operation normally. An unexpected executor panic instead terminates Runtime; it
is not converted into a terminal `failed` snapshot. The accepted Operation is
current-process coordination state, so Runtime loss ends its observation and a
later Runtime does not reconstruct or replay it.

Submission uses authenticated `/api/cli/model-operations`. Listing,
inspection, and cancellation use the ordinary CLI request route, while one
`operation wait` command observes one Operation through the command-scoped
streaming route. A foreground request first receives and prints the accepted
snapshot, then uses that same wait contract unless `--no-wait` was requested.
Ending the waiting HTTP response or closing its credential-issuing Control
connection ends only that observer; it does not cancel accepted work. A later
CLI command obtains fresh credentials and can inspect or wait for the same
Operation while the same Runtime instance remains alive. Browser, Desktop,
Workbench, and Photoshop sessions receive no Model Operation control surface.

The registry is current-process coordination state, not Project history. It
keeps all active Operations and at most the 100 newest terminal records,
including retained Batch Item Outcomes for wait replay. It is not persisted,
reconstructed, resumed, or replayed after Runtime replacement. Successful
outputs remain durable as ordinary Project files and Generated Asset
provenance. Agent Records on CLI stdout are the single observation protocol;
callers may redirect them if they need a file copy. Product Quit terminates
active Model Operations with the rest of Runtime-owned work instead of running
a separate drain or recovery protocol.

One monotonic issued sequence orders the current Runtime's Operation listing and
cursor positions. Exhausting it is a process-fatal invariant failure, not a
recoverable submission error. Per-Operation progress counts are bounded by the
accepted Item collection; an impossible underflow or contradictory settlement
also fails the Runtime instead of saturating to a plausible value. Invalid
input, cancellation, Provider failure, and every other ordinary execution
failure retain their typed request or Operation outcomes.

Operation snapshots, execution variants, states, Artifact Pointers, Batch Item
Outcomes, and list results are Runtime-produced response values. Their Rust
types serialize outward but are not deserialization or persistence contracts.

Exact CLI syntax and Agent Records are documented in [`cli.md`](./cli.md).
Model Request, timeout, output, and commit behavior is documented in
[`model-generation.md`](./model-generation.md), while the accepted lifecycle
decisions are indexed under the
[Model Operation subsystem](./adr/README.md#model-operation-subsystem).

## Global And Project State

Runtime's global store is the sole persistence boundary for Workbench
preferences, recent Project roots, model overrides and API keys, and Photoshop
bridge settings. Recent Projects persist only the mapping from stable Project
id to canonical root. Non-secret settings and secrets use separate atomic
files; public projections expose only whether a key is set and a non-secret
preview. The typed default frontend is exactly `desktop`, `browser`, or
`runtime-only`; invalid values do not enter Runtime state. Global events carry
an ordered `globalRevision` independent of Project state.

An absent global settings or secrets file uses the current first-launch
defaults. An existing file must match the one closed current shape: unknown
fields, unknown Model IDs, empty or duplicate entries, and non-canonical values
fail the read. Runtime does not trim, filter, deduplicate, truncate, or rewrite
persisted state while reading it. A settings patch may contain a declared
subset, but every present object has a closed field set and the request must
express at least one mutation. Repeating a valid current value succeeds without
publishing a change; an empty or unknown-only patch fails without writing.

The public stable Project identity is `.debrute/project.json.project.id`.
Runtime rejects invalid or duplicate stable ids instead of deriving aliases
from roots or generating compatibility identities. A loaded Project session
owns one canonical root, snapshot, monotonic `projectRevision`, serialized
mutation authority, watcher, terminals, and typed Project Uses. The use kinds
are Workbench, request, running terminal, transfer, and Photoshop link.

Project metadata, Canvas JSON, the Canvas registry, Feedback, Generated Asset
metadata, and Canvas Map source each deserialize as their one closed current
document shape. Unknown nested fields are invalid and remain unchanged on disk.
Invalid Project metadata prevents opening; invalid pushed Canvas documents and
the registry use their existing snapshot diagnostic states so other valid
Project content remains observable. Runtime does not strip unknown fields or
rewrite those files while reading them. A later explicit push or repair is a
new current operation, not an automatic migration.

Releasing the final use atomically removes the live session and closes admission
to that canonical root before cleanup begins. Project Use release itself is an
ownership transition rather than a fallible cleanup response. Successful
cleanup removes the root transition; failure is retained there, blocks reopening
for the rest of the Runtime instance, and is returned by the next open or final
Registry shutdown. It is not converted into success, retried, or wrapped in
Workbench, Terminal, Transfer, Photoshop, or request-specific cleanup results.
There is no idle retention, grace period, reservation worker, or fixed session
cap.

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

Runtime persists unsaved text values and not-yet-accepted Canvas Feedback values
as Working Copies under its private state directory, keyed by the stable Project
id. Feedback values are additionally keyed by stable Feedback Capsule identity.
Editing writes the complete current value; a successful matching save, accepted
feedback mutation, explicit discard, or feedback deletion clears only the
corresponding value. Working Copies have no time-to-live or arbitrary count cap
and are restored in the next Project binding. Reconstructible Canvas camera,
selection, and panel state remains frontend-local and is not a Working Copy.

Runtime owns PTYs and holds a `running-terminal` Project Use independently of a
Workbench connection. One Project-scoped WebSocket transports terminal
topology, input, resize, output, and exit events. Unexpected socket loss is
terminal for that loaded Workbench; it is not automatically reconnected and
input is never replayed. Rebinding, preemption, or Workbench connection end
closes that socket while the Runtime-owned PTY remains alive. Project or
Runtime shutdown terminates owned PTYs.

Every Workbench Terminal creation names its Project-relative working directory.
Runtime starts the PTY at one internal initial size, then the mounted terminal
sends its measured dimensions through the resize command. Creation does not
accept dimension overrides. Because resize replies carry terminal identity and
dimensions rather than a request identity, Web keeps at most one resize in
flight per terminal and coalesces further measurements into one latest pending
resize. Every caller settles without treating ordinary measurement replacement
as a transport failure. Every Web event subscription supplies the error handler
that owns actual transport failures.

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
- Model Operation registry, lifecycle, observation, and result shapes:
  `apps/runtime/src/model_operation.rs` and `apps/runtime/src/cli/`.
- Model execution, redaction, downloads, and output commit:
  `apps/runtime/src/generation/`.
- Desktop window host: `apps/desktop/src/electron/`.
- Terminal ownership: `apps/runtime/src/terminal/`.
- Product bootstrap and update: `apps/runtime/src/product/`.
- Browser client connection: `apps/web/src/api/httpWorkbenchApiClient.ts` and
  `apps/web/src/workbench/WorkbenchApp.tsx`.

`pnpm verify:browser` is an explicit development diagnostic and is not part of
`pnpm verify`. Run it only when live browser verification is intentionally in
scope.
