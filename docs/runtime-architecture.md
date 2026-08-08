# Runtime Architecture

Debrute runs one shared Rust Runtime per operating-system user. Runtime is the
authority for Project files, global settings and secrets, Model Request execution,
integrations, product updates, Workbench connections, Photoshop transfers, and
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

The update-admission state rejects new mutating Workbench and CLI requests and
new Photoshop transfers while allowing observation and existing Photoshop
sessions to remain connected. Already admitted mutations and transfers retain
one Runtime work permit through completion; the forward-only Product commit
waits until those permits drain.

The tray exposes Runtime status; explicit root Desktop, browser, and Copy URL
actions; the ordered Recent Project projection under Desktop, Browser, and Copy
URL submenus; Start at Login; and Product Quit. Both primary and secondary tray
activation open this same menu on macOS and Windows. Workbench actions remain
disabled until Runtime is `Ready`. Copy URL resolves the exact current
credential-free loopback Workbench URL without opening or binding a Workbench
or changing Recent order. A tray creation or menu-rebuild failure exits Runtime
instead of keeping a stale or trayless control surface.

Browser activation resolves the exact current Runtime-owned Workbench URL and
hands it to the operating system. macOS requires `/usr/bin/open` to exit
successfully. Windows commits the handoff when `explorer.exe` starts
successfully because Explorer may exit with code 1 after passing the URL to the
registered browser; failure to spawn still rejects the activation. Runtime does
not try another browser command or reinterpret a successful Windows handoff as
an activation failure.

The CLI-only Root Workbench URL request is also Ready-gated. Runtime returns the
current packaged or registered source-development Root URL without activating a
frontend. No Project path crosses Control; the CLI may append one absolute
requested root with the shared pure route builder. URL resolution does not open
a Workbench connection, admit a Project, or change Recent Projects.

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
serves the version-selected Web assets itself. Source development never runs a
Windows Runtime directly from Cargo's `target/debug`: the launcher assembles the
executable and its closed native-raster payload into a disposable fixed
`.scratch/rust-runtime-dev/windows-runtime` directory. This keeps the running
Windows image and DLL locks away from Cargo output while retaining exact binary
and payload identity comparison. Its strict assembly identity binds the
compiled executable hash, native-raster manifest hash, and complete flat
payload inventory hash. Reuse also rehashes the actual executable and closed
payload directory, so a changed build, payload revision, missing file, extra
file, or damaged file stops the old Runtime and reassembles the directory; only
an exact current assembly reuses the existing process. The launcher does not
equate Control loss with Windows releasing the executable image and DLLs. Old
directory removal and validated-staging activation share one five-second
deadline and retry only the closed Windows contention set `EBUSY`, `EMFILE`,
`ENFILE`, `ENOTEMPTY`, and `EPERM`; every other error fails immediately. The
assembly identity is published only after staging activation succeeds. This
directory and its assembly-identity file are launcher-created repository-local
state, not developer configuration or a checked-in Product input; a fresh
checkout creates them on demand. The Vite proxy target remains fixed for that
source development session. If its Control connection loses Runtime, the
launcher stops its Vite process and any Electron development host, reports the
terminal loss, and exits; it never leaves a proxy
aimed at a retired Runtime origin or discovers a replacement backend. A new
`pnpm dev` or `pnpm dev:electron` run registers the new exact Runtime origin and
creates a fresh Workbench connection.

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
settings, Model Request, file, and terminal work does not travel over Control.
Activation responses may carry one structured Project-open failure containing
the requested root, Project error code, and message; this is an activation
outcome, not a Project service transported over Control.
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
the ticket through one narrow preload IPC method. Each BrowserWindow has an isolated storage partition and loads
a stable URL with no credential in its URL. Missing or invalid launch
presentation fails the window launch rather than falling back to another theme.
The ticket has no disk persistence or timer-based lifetime and is removed
atomically when consumed. A failed startup Project activation is shown as a
native Desktop error without creating another Workbench window.

Each loaded Workbench opens one POST SSE connection at
`/api/workbench/connection`. Its first frames establish an in-memory connection
credential and the complete Global Settings snapshot before any requested
Project binding work. The settings frame is sufficient to apply locale, theme,
and Canvas Text Appearance before React mounts. Project preparation follows in
blocking-worker work and therefore cannot delay that frame; it later yields
either a Project binding or an explicit open failure. A browser session may
contain multiple document connections; commands send one connection's
credential in a same-origin header and Runtime validates the cookie and
credential together. There are no split Global/Project connections, reconnect
window, heartbeat, unload release, or automatic request replay. Unexpected
connection end is a terminal page state; refreshing creates a new connection.

Global Settings, Integration discovery, live Photoshop state, and packaged Product
state are independent resources carried by the initial stream and subsequent
ordered Global events. The settings snapshot never synchronously probes
integrations or Photoshop. Settings activation explicitly starts Integration
discovery. Runtime applies the persisted Photoshop Integration enable choice at
composition, then Photoshop sessions publish complete live state through the
initial stream and ordered Global events. There is no settings-owned refresh or
second frontend truth. Mutating and action commands return
only their closed command outcome and any action-specific diagnostic; they do not return
another complete state for the initiating Workbench to apply. Command progress
is local interaction state and ends with the command response, while displayed
authoritative state changes only when its Global event is applied. Runtime does
not add a command-response revision wait or use response state as a fallback if
the event connection fails; unexpected connection end remains terminal for the
page.

Passive Project media GETs remain authorized when the live browser session has
a live connection bound to the requested Project.
CLI authorization and the Photoshop gateway use separate, route-limited
sessions and cannot be substituted for a Workbench connection.

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

Before acceptance, Runtime validates the live CLI credential, invocation
working directory, complete strict JSONL input, Model availability, execution
options, and each Request's output directory and basename. It reads one validated Global configuration and
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
them and are absent from serialized snapshots, logs, output files, provenance,
and retained terminal records.

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
outputs remain durable as ordinary files with Runtime-global Model Artifact
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
[`model-requests.md`](./model-requests.md), while the accepted lifecycle
decisions are indexed under the
[Model Operation subsystem](./adr/README.md#model-operation-subsystem).

## Global And Project State

Runtime's global store is the sole persistence boundary for Workbench
preferences, Canvas-global settings, recent Project roots, model overrides,
Plugin Integration enablement, and API keys. The Photoshop enable choice is a
Global Settings field; its gateway health, retry, sessions, Documents,
credentials, commands, and transfer state remain live-only. Canvas Text
Appearance persists as one complete `canvas.textAppearance` value: managed font
ID, font size, line-height ratio, requested integer weight, letter spacing, and
ligatures. `canvas.hierarchyEdgesVisible` is one boolean that defaults to
`true`. Recent Projects persist only an ordered list of canonical roots.
Non-secret settings and secrets use separate atomic files;
public projections expose only whether a key is set and a non-secret preview.
Runtime stores no default frontend. Every frontend-opening command or menu item
selects `desktop` or `browser` explicitly. Global events carry an ordered
`globalRevision` independent of Project state.

An absent global settings or secrets file uses the current first-launch
defaults. An existing file must match the one closed current shape: unknown
fields, unknown Model IDs, empty or duplicate entries, and non-canonical values
fail the read. Runtime does not trim, filter, deduplicate, truncate, or rewrite
persisted state while reading it. A settings patch may contain a declared
subset, but every present object has a closed field set and the request must
express at least one mutation. Repeating a valid current value succeeds without
publishing a change; an empty or unknown-only patch fails without writing.

The canonical absolute root is the complete Project identity. Runtime creates
one loaded Project Session per canonical root, with one snapshot, monotonic
`projectRevision`, serialized mutation authority, watcher, terminal set, and
typed Project Uses. Workbench APIs receive a temporary opaque `bindingId`; it
is capability authority rather than durable identity. The use kinds are
Workbench, request, running terminal, and transfer.

Project admission canonicalizes and validates an existing directory exactly
once, producing Runtime's `CanonicalProjectRoot` identity value. Registry,
Session, Workbench ownership, Terminal lifetime, and Photoshop transfer state
retain that value; UTF-8 strings are projections used only by wire and persisted
document formats. Project-relative input is parsed at its request seam into a
non-empty `ProjectRelativePath`, or into `ProjectDirectoryPath` when the empty
value is allowed to name the root. Filesystem Interfaces accept those admitted
values instead of reparsing arbitrary strings. On Windows, identity and
containment continue to use the canonical path, while the Terminal process
Adapter alone removes a supported verbatim prefix when constructing an
external-process working directory.

Project opening publishes root-scoped Canvas state, Project-local Feedback, and the
ordered view of one session-local `ProjectTree` module containing the real root
entry and its direct children. That module alone owns the flat path index, directory
load state, sibling ordering, and non-persistent filesystem identity. Directory
loading is a revisioned session command that asks the module to enumerate one
directory's direct children. Every loaded directory stays indexed until the
session closes; disclosure changes never unload it. The public Project snapshot
is derived output. Explorer consumes the ordered tree; Canvas
consumes a disclosure-filtered resource view. Workbench derives Canvas scene
geometry from that view.

Each directory has explicit `unloaded`, `loaded`, or `error` state.
An unloaded or failed directory is never represented as empty and never
authorizes sparse-state cleanup. Canvas restores its disclosed directory
closure by expanding each retained disclosure to its complete
ancestor-plus-self closure, continues loading independent branches when one
branch fails, and publishes the batch through one final resource view.
Read failures remain indexed as `error`; only authoritative not-found after
ancestor enumeration confirms absence. Explorer expansion, Canvas expansion,
and Reveal in Canvas all request the same directory-load
operation. There is no complete background traversal.

The supported macOS FSEvents and Windows backends each use one native recursive
root subscription. Watcher bursts are sorted and delivered as a batch, but
Runtime refreshes only loaded dependency paths and Debrute-managed documents.
Runtime-authored Feedback events are discarded before refresh when their
content hash matches the accepted document. Ordinary path events update the
flat path index and rederive Canvas only when it displays or retains state for the
affected subtree. A full watcher rescan additionally compares session-only
filesystem identities so deletion plus recreation at the same path receives
default Canvas state.
Version-control internals, fixed operating-system debris, symbolic links, and
non-regular entries are excluded. `.debrute/`, other dotfiles, `.gitignore`,
and paths named by `.gitignore` rules remain ordinary visible entries; Runtime
does not interpret ignore rules. Directories such as `node_modules`, `target`,
`dist`, and `build` are ordinary on-demand folders. Watcher events observed
during initial publication queue behind its barrier and are applied afterward.

Global Canvas state, root-scoped Working Copies, Project-local Feedback, and
global Model Artifact provenance each deserialize as one closed current document
shape. Unknown fields are invalid and remain unchanged on disk. Invalid
Feedback state fails the Project load or refresh. Invalid, unreadable, or
root-mismatched Canvas state leaves Canvas unavailable without blocking the
Project Tree, editor, or terminal.

Releasing the final use atomically removes the live session and closes admission
to that canonical root before cleanup begins. Project Use release itself is an
ownership transition rather than a fallible cleanup response. Successful
cleanup removes the root transition; failure is retained there, blocks reopening
for the rest of the Runtime instance, and is returned by the next open or final
Registry shutdown. It is not converted into success, retried, or wrapped in
Workbench, Terminal, Transfer, Photoshop, or request-specific cleanup results.
There is no idle retention, grace period, reservation worker, or fixed session
cap.

Browser and Desktop Project activation do not preflight the target path.
Browser activation builds a route from the absolute requested root. Desktop
activation forwards the raw root and optional source key to the Desktop host.
Electron selects the live source, the sole live window for a source-free
request, or one new ordinary Root Workbench when there is no unique target.
Existing targets perform the normal bound-connection open or replacement; a
new target submits the initial root with its first connection. Root activation
always opens a new Root window. Project validation failure stays in the
selected Workbench and does not select another target.

Opening from an unbound Workbench and browser replacement from a bound
Workbench are the binding operations. Target validation finishes before an
atomic replace; opening the current target is a no-op. Each Project has at most
one Workbench. A browser replacement or detached **Open Here** acquires the
concrete target at the atomic binding commit and displaces any different
Workbench owner without a second destination confirmation. Preparation does
not modify either owner; a failure leaves both bindings unchanged. Runtime sends
`project.preempted` only when an ownership transfer commits. A displaced Desktop
window stays open on the unbound topology route, while its renderer preserves
the last confirmed Project presentation as a frozen detached surface with
**Open Here**. It is not closed, silently rebound, or allowed to retain Project
command authority. **Open Here** is another explicit request to acquire that
same Project under this rule.

Project mutations are serialized and semantically validated. Commands return
their outcome; ordered stream events carry authoritative state. A stale or
missing response is never permission to replay a state-changing command.
Filesystem mutations commit first and then refresh the session-local Project
Tree. Runtime subsequently applies the same path change to the root-scoped
Canvas document, accepted Feedback, text Working Copies, and Feedback Working
Copies. Rename and Move rewrite the source prefix; Delete prunes it; overwrite
prunes the destination before rewriting the source. Watcher reconciliation
prunes only a path absent from a successful parent enumeration, or an enumerated
path whose immediately following identity lookup returns the expected
`NotFound` or `NotADirectory` result. Permission and other I/O errors fail the
refresh without authorizing cleanup.
Runtime-owned atomic text replacement carries its committed file identity into
that refresh, so only the Runtime's exact output preserves path-keyed state; an
external replacement between commit and refresh does not.

These updates are intentionally not a durable transaction with ordinary
Project files. If Project refresh fails after the filesystem commit, Runtime
preserves the filesystem result, does not retry or roll it back, and publishes
the successful command with one `project_refresh_failed` Error diagnostic. If
secondary-state persistence also fails, it additionally publishes the Error
diagnostic `project_path_state_persistence_failed`; ordinary refresh does not
clear that diagnostic, while the next successful related path mutation does.
Runtime writes no filesystem or Native Trash recovery journal, Canvas byte
snapshot, expected output hash, or commit marker. Native Trash validates the
complete top-level batch before any effect, revalidates each original Project
path immediately before asking the operating system to trash it, and stops at
the first failure without retry or rollback. Earlier successful items remain in
the system Trash and later items are not attempted. Each item is handed to a
fresh private Runtime worker through an argument-array command containing the
canonical Project root, one admitted Project-relative path, expected filesystem
identity, and expected kind. The worker runs before normal Runtime or Terminal
bootstrap, accepts only that closed command shape, reopens the canonical root,
repeats no-symbolic-link containment plus identity and kind checks, and calls
the native Trash Adapter directly. It never builds a shell command. The parent
supervises the worker with one bounded timeout and treats a non-zero exit,
signal, or timeout as the item failure.

## Working Copies And Terminal Lifetime

Runtime persists unsaved text values and not-yet-accepted Canvas Feedback values
as Working Copies under its private state directory, keyed by the canonical
root's Root Key. Feedback values are additionally keyed by stable Feedback
Capsule identity. Text and Feedback Working Copies follow a Runtime-committed
rename or move and are pruned by confirmed deletion or overwrite. Editing
writes the complete current value; a
successful matching save, accepted feedback mutation, explicit discard, or
feedback deletion clears only the corresponding value. Working Copies have no
time-to-live or arbitrary count cap and are restored in the next Project binding.
Reconstructible Canvas camera, selection, and panel state remains frontend-local
and is not a Working Copy.

Runtime owns PTYs and holds a `running-terminal` Project Use independently of a
Workbench connection. One Project-scoped WebSocket transports terminal
topology, observation, input, resize, output, and exit events. Its initial
`sync` frame and subsequent contiguous, full `topology` snapshots are the only
Workbench authority for the Terminal collection; Terminal create and close
HTTP requests are commands and there is no parallel HTTP list projection. A
missing or non-contiguous topology revision terminates the Terminal connection
instead of accepting an uncertain collection. Unexpected socket loss is
terminal for that loaded Workbench; it is not automatically reconnected and
input is never replayed. Rebinding, preemption, or Workbench connection end
closes that socket while the Runtime-owned PTY remains alive. Project or
Runtime shutdown terminates owned PTYs.

Binding the Terminal WebSocket does not observe any PTY. A Workbench listener
explicitly observes one Terminal id, and the observation barrier returns that
actor's current session view and exact emulator checkpoint together before its
ordered output and status events. Background tab status is therefore an
explicit product observation, not an implicit bind-time subscription.

Every Workbench Terminal creation names its Project-relative working directory.
Runtime starts the PTY at one internal initial size, then the mounted terminal
sends its measured dimensions through the resize command. Creation does not
accept dimension overrides. Resize replies correlate the request and return the
complete current Terminal session. Web keeps at most one resize in flight per
terminal and coalesces further measurements into one latest pending resize.
Every caller settles without treating ordinary measurement replacement as a
transport failure. Input and resize are admitted only after that connection has
an explicit observation for the Terminal. Every Web event subscription supplies
the error handler that owns actual transport failures.

## Product Version Ownership

Desktop, Runtime, CLI, Web assets, official Skills, and model documentation
share one Product version. Desktop embeds a complete seed for fresh install.
Runtime validates and materializes immutable versions under
`~/.debrute/products/versions/<version>`, selects `current`, and publishes stable
entrypoints. Acceptance of a title-bar or General Settings Install action wins
over Product Quit, closes new mutating work, and drains admitted short work
before reversible preparation; the durable transaction is then forward-only.
Update continuation does not migrate Workbench connections, terminal sessions,
or Project Uses. See
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
  `apps/runtime/src/model_request/`.
- Desktop window host: `apps/desktop/src/electron/`.
- Terminal ownership: `apps/runtime/src/terminal/`.
- Product bootstrap and update: `apps/runtime/src/product/`.
- Browser client connection: `apps/web/src/api/httpWorkbenchApiClient.ts` and
  `apps/web/src/workbench/WorkbenchApp.tsx`.

`pnpm verify:browser` is an explicit development diagnostic and is not part of
`pnpm verify`. Run it only when live browser verification is intentionally in
scope.
