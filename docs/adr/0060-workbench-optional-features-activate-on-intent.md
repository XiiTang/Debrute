---
status: accepted
---

# Workbench Optional Features Activate On Intent

The Workbench critical JavaScript graph contains only connection projection,
shell, Project presentation, and Canvas presentation required for the first
committed surface. Settings, Explorer presentation, Inspector, Terminal,
floating text windows, and the CodeMirror editor engine activate when their
surface is requested and read the current accepted Project snapshot when they
mount.

The Terminal WebSocket Hub is created only by first Terminal transport use and
binds the latest accepted Project. Settings and Explorer do not maintain a
second cache or frontend authority merely to activate late. The production
manifest and gzip budget enforce these code-loading boundaries.

Runtime owns one on-demand Project Tree and one watcher per loaded canonical
root. Explorer disclosure and Canvas Folder Disclosure request directory
loads through that same tree; no background full-tree index runs beside it.
The watcher admits changes only for loaded directory dependencies and refreshes
the shared tree before Runtime publishes the next complete Project snapshot.
