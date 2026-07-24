# Runtime Owns The Tray

The single Rust Runtime process owns Debrute's macOS menu-bar item and Windows
notification-area icon. Desktop remains a trayless Electron window host, and no
Supervisor process exists merely to keep the tray alive after Runtime exits.

The tray is a narrow lifecycle and frontend-entry surface. Its menu contains a
non-interactive Runtime status, **Open Desktop**, **Open in Browser**, **Start at
Login**, and **Quit Debrute**. It has no update controls, recent Projects,
diagnostics, restart action, or URL copying. macOS activation opens the menu. On
Windows, primary activation opens Desktop and secondary activation opens the
menu.

Tray creation is a required startup step on macOS and Windows. If the platform
cannot create it, Runtime exits before starting its services or publishing
`Ready`; the launcher reports the startup failure. There is no invisible
trayless Runtime mode, degraded lifecycle state, or retry loop. Linux tray
behavior is outside the supported product design.

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
