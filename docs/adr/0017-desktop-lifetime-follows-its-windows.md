# Desktop Lifetime Follows Its Windows

Electron Desktop exits after its last BrowserWindow closes. Closing a window
reports its opaque key to Runtime, which removes that live route and any bound
Workbench connection. Closing the last window affects Electron only; the
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
