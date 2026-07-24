# Desktop Shell

Debrute Desktop is a trayless Electron window host for the same Web Workbench
and shared local Runtime used by browser clients. Runtime alone owns the
persistent macOS or Windows tray. Desktop owns native windows, menus, folder
picking, and Product packaging. Project sessions, global settings, integrations,
Adobe Bridge, file mutation, terminals, and process lifecycle remain
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

Runtime assigns every BrowserWindow an opaque window key and a root-or-Project
route. One `DesktopWindowHost` owns the complete local record for that window:
the Runtime key, BrowserWindow identity, `opening` or `live` phase, current
one-use launch ticket, deferred focus intent, and native close listener. Main
does not keep a second BrowserWindow map, and the Electron adapter does not own
the ticket or Runtime identity.

The Host requests one in-memory, single-use launch ticket for the Runtime key.
The same response carries the current Runtime-owned Workbench theme preference
as a launch-time presentation snapshot. Window construction is synchronous and
hidden. The Host inserts its record and close listener before applying the
background and calling `loadURL`, so preload can resolve the real
BrowserWindow to that record and consume the ticket while the document is
loading. Only a successful load changes the record to `live` and shows the
window. A focus request received during `opening` is remembered and applied
after that transition instead of showing a partial Workbench.

The Host resolves `system` with Electron's native theme and loads the stable
Workbench URL. Runtime records only the live window key and route. Desktop does
not persist a settings copy. Missing or invalid launch presentation fails the
window launch instead of selecting a default background. Runtime does not
persist window bounds, focus, recovery topology, or renderer acknowledgements.

Opening an already-open Project from Electron focuses its existing window.
Opening another Project replaces the current window's binding after target
validation. If Web already owns the target, an ordinary Electron open remains
on the root Project chooser and presents **Open Here** instead of taking the
Project silently. A browser may preempt the Project; the old Electron window
remains open with its last Project presentation, becomes read-only, and offers
**Open Here**. The Runtime topology treats that detached window as unbound; the
preserved presentation is frontend-local context, not Project command
authority. **Open Here** explicitly preempts another Workbench instead of
focusing it.

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

- consume the current window's one-use Desktop launch ticket;
- execute native window controls and receive semantic menu commands; and
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

Copy Path, reveal, and recoverable deletion cross Runtime's validated native
file boundary. Electron does not expose direct file-operation IPC for these
commands, so browser and Desktop Workbenches share the same behavior.

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
