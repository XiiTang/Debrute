# Workbench Connection Lifetime Follows Its Document

Each loaded browser tab or Electron BrowserWindow owns one POST SSE Workbench
connection and one in-memory connection credential. It has at most one bound
Project. The browser's HttpOnly session authorizes passive same-origin access;
it does not merge multiple documents into one Workbench identity or authorize
commands without a live connection credential.

The connection begins with complete Global and optional Project snapshots.
Runtime closes it on browser loss, backpressure, revision gap, Product Quit, or
replacement, immediately releasing its Workbench Project Use. There is no idle
timer, unload release request, attachment anchor, reconnect reservation,
heartbeat, recovery deadline, or Reconnect button. Refreshing creates an
entirely new connection and snapshots.

Each Project has at most one Workbench owner. Desktop-to-Desktop duplicate open
focuses the existing native window. Web opens and explicit Desktop **Open Here**
preempt the old connection's binding. A preempted page remains loaded on a
detached, read-only surface with its last presentation but has no Project
command authority. For Desktop, Runtime retargets the window's topology route
to Root without erasing that renderer-local presentation.

Working Copies are the only persistent cross-document recovery state for
unsaved Workbench values. Disposable Canvas camera, selection, panel geometry,
and other presentation state may remain frontend-local. Terminals keep their
own Runtime Project Use and are not made durable or migrated by this rule.
