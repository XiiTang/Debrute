# Desktop Shell

Debrute Desktop is a trayless Electron window host for the same Web Workbench
and shared local Runtime used by browser clients. Runtime alone owns the
persistent macOS or Windows tray. Desktop owns native windows, menus, folder
picking, and Product packaging. Project sessions, global settings, integrations,
Photoshop file transfer, file mutation, terminals, and process lifecycle remain
Runtime-owned.

Each Desktop artifact is built on its matching native release target together
with Workbench assets containing the same closed `darwin` or `win32` build
constant. Desktop validates its native entrypoint once and continues only for
that target. Runtime paths, native chrome, menus, and recent-Project integration
consume the typed build target; renderer code does not infer it again from
browser APIs or receive it through Runtime bootstrap.

## Runtime And Window Ownership

Desktop acquires Electron's application single-instance lock and connects to
Runtime as a native launcher. Only an absent Runtime owner may be started. Its
launcher connection is promoted internally to the one Desktop host when
Desktop activates; there is no public `desktop_host` Control role or second
Desktop backend. Control acquisition, optional Runtime launch, handshake, and
Ready polling share one absolute fifteen-second startup deadline. Timeout
closes the client, shows the startup failure, and exits Desktop without opening
a window, terminating or replacing Runtime, retrying activation, or launching
another Runtime.

Main resolves the Runtime entrypoint, its complete argument list, the Desktop
entrypoint and argument list, the Workbench asset directory, the log path, and
the inherited process environment before entering that connect-or-launch
sequence. The internal launcher consumes those resolved values exactly; it
does not synthesize missing argument arrays or an alternate environment.

Runtime assigns every new BrowserWindow an opaque window key and a Root route.
One `DesktopWindowHost` owns the complete local record for that window:
the Runtime key, BrowserWindow identity, `opening` or `live` phase, current
one-use launch context, deferred focus intent, and native close listener. Main
does not keep a second BrowserWindow map, and the Electron adapter does not own
the launch ticket or Runtime identity.

The Host requests one in-memory, single-use launch ticket for the Runtime key.
The same response carries the current Runtime-owned Workbench theme preference
as a launch-time presentation snapshot. Desktop exposes a one-use launch
context to preload through one narrow IPC method. The context contains the
ticket and, only for a new window created by a Project-open request, the initial
Project root. Window construction is synchronous and hidden. The Host
inserts its record and close listener before applying the background and
calling `loadURL`, so preload can resolve the real BrowserWindow to that record
and consume the ticket while the document is loading. Only a successful load
changes the record to `live` and shows the window. A focus request received
during `opening` is remembered and applied after that transition instead of
showing a partial Workbench.

The Host resolves `system` with Electron's native theme and loads the complete
Workbench URL from the ticket response unchanged. Runtime selects the packaged
or registered source-development origin. Electron does not rewrite its origin,
path, or query. Runtime records only
the live window key and route. Desktop does not persist a settings copy. Missing
or invalid launch presentation fails the window launch instead of selecting a
default background. Runtime does not persist window bounds, focus, recovery
topology, or renderer acknowledgements. The renderer document remains
transparent while its Workbench connection waits for the authoritative Global
Settings snapshot, leaving this native background visible. It begins normal
painting only after applying the snapshot's resolved theme, so a slow Project or
Integration resource cannot produce an intermediate default-theme frame.

Electron Main owns the native Project selector and determines exactly one
target for every ordinary Desktop Project open. This includes startup arguments,
Finder or Dock file opens, second-instance arguments, the application menu,
Open Recent, the Windows Web title bar, and Windows Jump Lists. Cancelling does
nothing. A request with a live native source targets only that source; a
destroyed source discards the request. A request without a source targets the
only live window when exactly one exists, and otherwise creates one ordinary
Root Workbench carrying the initial Project in its one-use launch context.

An existing target receives one semantic Project-open event and performs the
normal Workbench binding operation itself. The new-window target submits its
initial Project with the first Workbench connection. The selected target is not
changed after dispatch: a Project-open failure stays in that Workbench, and
Desktop does not find a focused window, choose another live window, create a
fallback window, queue a retry, or return the failure through a second native
result chain. If another Desktop Workbench already owns the Project, the normal
Runtime binding contract may focus that owner for an existing target. A newly
created target instead completes its own initial binding, displacing the old
owner. Browser Project selection keeps its same-tab binding behavior.

A browser may still displace a Desktop Project owner. The Electron window then
remains open with its last confirmed Project presentation frozen and alone
offers **Open Here**. Runtime treats that detached window as unbound in Desktop
topology; the preserved presentation is frontend-local context, not Project
command authority. **Open Here** is the deliberate same-window ownership
reacquisition path and is not an ordinary Desktop Project open.

Before Runtime Control is ready, one admission closure orders Desktop opens.
An explicit first-process Project argument runs first; otherwise the first
queued native open replaces the default root window, and only an empty queue
creates that default. Intents arriving during the first activation are drained
in order before admission becomes live. The closure does not deduplicate,
retry, replay, or persist opens. Each admitted request is dispatched once to
its selected target.

Project validation and binding happen in the selected Workbench connection.
Workbench shows the requested root and error while preserving its previously
accepted Project, if any. A cold-start failure appears in the newly created
ordinary Workbench. Native error boxes remain reserved for Desktop or Runtime
infrastructure failures, not Project-open results.

Canvas Workspace damage does not fail Project opening. Workbench remains bound
to the Project and presents the Canvas-unavailable surface there.

The red close button closes one window. A non-final close reports that window
key to Runtime. The final close instead closes the Desktop Control connection
and exits Electron immediately; Runtime removes the Desktop host and its final
topology entry when that connection ends. It does not wait for a redundant
final-window acknowledgement. Runtime and its tray remain running. `Command-Q`,
the application-menu Quit command, and `debrute runtime stop` request Product
Quit: Runtime closes Desktop and directly terminates its owned work. There is
no Desktop-owned resident process or tray, close confirmation, unload
handshake, fallback exit, or automatic window recovery.

If Runtime rejects or cannot receive a non-final window-close report, the local
window is already gone and Desktop's topology can no longer agree with Runtime.
Desktop reports the failure, destroys its remaining windows, closes Control,
and exits locally. Connection teardown drains the complete Desktop-host
topology; Desktop does not continue with the remaining windows, retry the
report, or open another Control connection. Runtime remains available for a
later fresh Desktop launch.

On Windows, File > Close Window, `Ctrl+W`, the title-bar close button, and
`Alt+F4` retain that window-close meaning. File > Quit Debrute and `Ctrl+Q`
instead request Product Quit. Both surfaces use the same `Quit Debrute` product
term; Windows does not introduce a separate Exit command.

Command-Q received during Desktop startup retains that Product Quit meaning.
Desktop completes its already-running Control acquisition, installs the Product
exit event path, and sends Product Quit once before opening any Workbench
window. Absence of an assigned Control client is not permission to downgrade
the action to a Desktop-only exit; Desktop does not cancel startup, create a
second connection, or retry the request.

If the Control connection ends unexpectedly, Desktop shows a native startup or
runtime-loss error and exits. It does not reconnect, restart Runtime, or replay
the request. A later user launch performs a fresh ensure-and-connect sequence.

A BrowserWindow is hidden until its Workbench document loads. If loading fails,
Desktop destroys that local window and asks Runtime to remove its window key.
When no successfully loaded window remains, Desktop shows the failure, closes
its Control connection, and exits locally; Runtime remains alive for a later
fresh Desktop launch. A failed additional window does not close other loaded
windows. Desktop does not retain the hidden window, retry, reload it, or use a
different URL.

If Runtime also rejects or cannot receive the failed-window cleanup, Desktop
reports both failures, destroys its remaining windows, closes Control, and exits
locally. The connection teardown drains Runtime's complete Desktop-host
topology. Desktop does not continue with divergent topology, retry the cleanup,
open another Control connection, or restart itself.

View > Reload Workbench and its semantic menu equivalent identify the target by
the real BrowserWindow, not by exposing the Runtime key to Main. The Host
serializes explicit reloads. Each request obtains its own fresh ticket, installs
that ticket and the current launch presentation on the existing record, and
loads the stable URL once. Requests are not coalesced or retried. If the target
closes before a queued reload begins, that reload is discarded without asking
Runtime for a ticket. If a live reload fails while the window still exists, the
Host clears any unconsumed ticket and reports the failure once, but keeps the
window record so a later manual reload can try again.

A native close invalidates its Host record immediately, even if an initial load
or reload is still pending. A non-final close reports its Runtime key exactly
once; the final close closes Control and exits Electron without the redundant
request. Product exit or replacement synchronously marks the Host as shutting
down, removes close listeners, destroys every local window, closes Control, and
exits Electron. Results arriving from preempted ticket or load operations cannot
show a window, perform topology cleanup, or report a late error.

## Renderer Boundary

Desktop windows use context isolation with Node integration disabled. Preload
exposes only the native shell operations needed by the Workbench:

- consume the current window's one-use Desktop launch context;
- execute native window controls and receive semantic menu commands;
- receive a Project-open request selected for that exact window; and
- extract absolute paths from native file-drop objects.

The renderer does not receive project services, settings stores, filesystem
objects, Control credentials, or a general-purpose IPC bridge. After bootstrap,
it talks directly to the same Runtime Workbench API as an ordinary browser.

## Menus, Title, And Recent Projects

Workbench derives the current title from its Project state and owns its visible
title bar. Electron owns the native application menu. Native edit roles
implement undo, redo, cut, copy, paste, paste-and-match-style, delete, select
all, and speech commands; supported semantic commands are forwarded to the
focused Workbench window.

The Windows Web title bar forwards its closed native edit-command subset,
including Delete and Paste and Match Style, to Electron for actual execution.
The executor is exhaustive: a successful IPC response means the requested
command ran, while an unknown or unsupported command is rejected. macOS Start
Speaking and Stop Speaking remain native application-menu roles only; because
macOS Desktop does not render the Web menus, those roles are not duplicated in
the Web-to-Electron command protocol.

File > New Window and `CmdOrCtrl+N` activate a root window. On macOS, the Dock
menu exposes the same single **New Window** action. File > Open Project and all
recent-Project surfaces use the same target-first Project-open dispatch. A live
native source is the target, including when it is already Project-bound or
detached.

After open admission becomes live, native event and menu callbacks pass their
action promise through one Desktop error reporter. Opens queued before that
boundary are owned by the awaited startup sequence, so the same failure is not
also reported by a native callback. Renderer-originated IPC handlers remain
awaited and return their rejection to the renderer instead of also reporting it
as a second native error. Runtime-loss and window-host failures retain their
existing dedicated lifecycle handling.

Runtime sends Desktop a snapshot-first recent-Projects projection over Control.
Electron mirrors it into native recent-document and menu affordances but does
not persist a separate recent-project store. A host which cannot accept a later
projection event loses its Control connection; Runtime continues with the
ordered projection and any other hosts rather than reporting a Global update
failure or retrying delivery.

Each projection change is applied directly through the current platform's
required Electron API: macOS clears and repopulates recent documents, while
Windows replaces the Jump List. The sync path does not build a deferred
`apply` object for production to invoke immediately, and required platform
methods are not optional no-op calls. A missing current-platform API is an
explicit Desktop integration failure.

## Explorer And Native File Operations

Explorer selection, clipboard state, copy/cut/paste semantics, confirmations,
and post-mutation invalidation belong to the Web Workbench. Project copy, move,
upload, and permanent-delete operations use Runtime's Project mutation API.

Copy Path, Copy Relative Path, reveal, and recoverable deletion cross Runtime's
validated native file boundary. Both path-copy commands use one Runtime-owned
system-clipboard implementation shared with the tray. Web never completes them
through `navigator.clipboard`, and Electron does not expose direct
file-operation or clipboard IPC for these commands, so browser and Desktop
Workbenches share the same behavior.

On Windows, reveal calls the Shell PIDL API directly; it does not start Explorer
as a child process. Recoverable deletion does not invoke PowerShell, AppleScript,
Finder, or another command interpreter. Runtime validates the whole requested
Project batch, then starts one private copy of its current executable for each
top-level item. The worker accepts only the canonical Project root, one admitted
Project-relative path, and the expected filesystem identity and
file-or-directory kind. It reopens the canonical root, repeats the complete
no-symbolic-link containment and identity validation, and only then calls the
operating system Trash or Recycle Bin Adapter. Runtime supervises each worker
for 30 seconds, stops at the first failure, and performs no retry, rollback,
compatibility fallback, or recovery journal.

## Executable Authorities

- Desktop composition and native command execution: `apps/desktop/src/electron/main.ts`.
- Runtime window coordination: `apps/runtime/src/control/desktop/`.
- Desktop window identity and lifecycle host:
  `apps/desktop/src/electron/desktopWindowHost.ts`.
- BrowserWindow construction and native operations:
  `apps/desktop/src/electron/electronDesktopWindow.ts`.
- Native application menu: `apps/desktop/src/electron/desktopApplicationMenu.ts`.
- Desktop single-instance lifecycle: `apps/desktop/src/electron/main.ts`.
- Narrow renderer bridge: `apps/desktop/src/electron/preload.ts` and
  `apps/desktop/src/electron/nativeWindowShell.ts`.
- Workbench launch and connection authority: `apps/runtime/src/workbench/`.
- Native Project path validation and operations:
  `apps/runtime/src/project/paths.rs` and `native_shell.rs`.
