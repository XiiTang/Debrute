# Desktop Shell

Debrute Desktop is a trayless Electron window host for the same Web Workbench
and shared local Runtime used by browser clients. Runtime alone owns the
persistent macOS or Windows tray. Desktop owns native windows, menus, folder
picking, and Product packaging. Project sessions, global settings, integrations,
Adobe Bridge, file mutation, terminals, and process lifecycle remain
Runtime-owned.

## Runtime And Window Ownership

Desktop acquires Electron's application single-instance lock and connects to
Runtime as a native launcher. Only an absent Runtime owner may be started. Its
launcher connection is promoted internally to the one Desktop host when
Desktop activates; there is no public `desktop_host` Control role or second
Desktop backend.

Runtime assigns every BrowserWindow an opaque window key and a root-or-Project
route. Main requests one in-memory, single-use launch ticket for that key, loads
the stable Workbench URL, and exposes the ticket once through preload so the
renderer can open its POST SSE connection. Runtime records only the live window
key and route. It does not persist window bounds, focus, recovery topology, or
renderer acknowledgements.

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

The red close button closes one window. Closing the last window exits Electron
and leaves Runtime and its tray running. Electron suppresses its default last-window quit
until the window adapter has reported that close to Runtime; it then performs a
Desktop-only exit. `Command-Q`, the application-menu Quit command, and `debrute
runtime stop` request Product Quit: Runtime closes Desktop and directly
terminates its owned work. There is no Desktop-owned resident process or tray,
close confirmation, unload handshake, or automatic window recovery.

If the Control connection ends unexpectedly, Desktop shows a native startup or
runtime-loss error and exits. It does not reconnect, restart Runtime, or replay
the request. A later user launch performs a fresh ensure-and-connect sequence.

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

Runtime sends Desktop a snapshot-first recent-Projects projection over Control.
Electron mirrors it into native recent-document and menu affordances but does
not persist a separate recent-project store.

## Explorer And Native File Operations

Explorer selection, clipboard state, copy/cut/paste semantics, confirmations,
and post-mutation invalidation belong to the Web Workbench. Project copy, move,
upload, and permanent-delete operations use Runtime's Project mutation API.

Copy Path, reveal, and recoverable deletion cross Runtime's validated native
file boundary. Electron does not expose direct file-operation IPC for these
commands, so browser and Desktop Workbenches share the same behavior.

## Executable Authorities

- Desktop lifecycle and command execution: `apps/desktop/src/electron/main.ts`.
- Runtime window coordination: `apps/runtime/src/control/desktop/`.
- Desktop Control adapter: `apps/desktop/src/electron/desktopWindowControlAdapter.ts`.
- Native application menu and single-instance lifecycle: `apps/desktop/src/electron/main.ts`.
- Narrow renderer bridge: `apps/desktop/src/electron/preload.ts` and
  `apps/desktop/src/electron/nativeWindowShell.ts`.
- Workbench launch and connection authority: `apps/runtime/src/workbench/`.
- Native Project path validation and operations:
  `apps/runtime/src/project/paths.rs` and `native_shell.rs`.
