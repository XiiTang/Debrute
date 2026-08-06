# Runtime Owns The Tray

The single Rust Runtime process owns Debrute's macOS menu-bar item and Windows
notification-area icon. Desktop remains a trayless Electron window host, and no
Supervisor process exists merely to keep the tray alive after Runtime exits.

The tray is a narrow lifecycle and explicit Workbench-entry surface. Its menu
contains, in order, a non-interactive Runtime status, **New Desktop Window**,
**Open in Browser**, **Copy URL**, **Recent Projects**, **Start at Login**, and
**Quit Debrute**. Both left and right clicks open this same menu on macOS and
Windows; clicking the tray icon never chooses a frontend.

**Recent Projects** consumes Runtime's one ordered Global projection and has
exactly three submenus: **Desktop**, **Browser**, and **Copy URL**. Each repeats
the same canonical Project-root labels in the same order and maps its item to
the canonical root. The Recent menu is disabled when the projection is
empty. Desktop activation follows the shared multi-window admission contract:
focus the matching Project window, reuse one eligible truly empty window, or
create a new window; it never replaces another Project. Browser activation
opens the selected Project in a browser.

Root and Recent **Copy URL** actions only place the exact current Runtime-owned
Workbench URL on the operating-system clipboard. They do not open or bind a
Workbench, create a Project session, or reorder Recent Projects. The copied URL
is the same credential-free loopback Workbench URL the corresponding browser
action would open: the packaged Runtime origin in Product builds or the one
registered source-Workbench origin during development. It is current-session
state rather than a persisted public endpoint. Runtime uses the single native
clipboard command for the platform (`/usr/bin/pbcopy` or `clip.exe`) and reports
failure without trying another transport. Workbench actions and Recent Projects
remain disabled until Runtime is `Ready`.

Tray creation is a required startup step on macOS and Windows. If the platform
cannot create it, Runtime exits before starting its services or publishing
`Ready`; the launcher reports the startup failure. A later menu-rebuild failure
requests Product Quit rather than leaving stale actions visible. There is no
invisible trayless Runtime mode, degraded lifecycle state, or retry loop.

On macOS, the Runtime executable is packaged and launched inside an
`LSUIElement` application bundle so the status item has a stable native
application identity without a Dock icon. This bundle is packaging for the same
single Rust process, not a launcher or Supervisor process. Runtime selects the
accessory activation policy before creating the status item and runs the `tao`
native event loop on its main thread. Its status icon is a template image
supplied by Runtime; Electron's application identity and Dock/menu state are not
used to manufacture or keep that item alive.

**Start at Login** activates only the ensure-Runtime intent and never opens a
frontend or Project. **Quit Debrute** requests the same Product Quit transition
as the Desktop application menu and `debrute runtime stop`; Runtime removal
removes the tray as part of the same process exit.
