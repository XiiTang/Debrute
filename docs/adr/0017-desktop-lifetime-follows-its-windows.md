# Desktop Lifetime Follows Its Windows

Electron Desktop exits after its last BrowserWindow closes. Closing a
non-final window reports its opaque key to Runtime, which removes that live
route. Closing the final window instead closes the promoted Desktop Control
connection and exits Electron; Runtime unregisters that host and drains its
remaining window topology as part of connection teardown. There is no final
window-close request, acknowledgement wait, timeout, or fallback exit. The
independent Runtime keeps running.

Runtime and Desktop remain separate single-instance applications. Runtime's
user-scoped lock protects one Runtime, while Electron's
`requestSingleInstanceLock` protects one Desktop Main process with multiple
windows. Desktop connects using the public `launcher` role and its connection
is promoted internally to the sole Desktop host. `desktop_host` is not a public
Control role.

Desktop retains no windowless process, tray, bounds-recovery store, or crash
topology. A later Desktop launch opens a fresh root window unless its explicit
activation targets a Project. Runtime owns the persistent tray, so closing the
last Desktop window leaves both Runtime and its tray running.
