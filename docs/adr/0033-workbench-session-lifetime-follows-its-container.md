# Workbench Connection Lifetime Follows Its Document

Each loaded browser tab or Electron BrowserWindow owns one POST SSE Workbench
connection and one in-memory connection credential. It has at most one bound
Project. Ordinary tabs in one browser storage partition share one HttpOnly
browser session, while Desktop BrowserWindows use isolated partitions. Sharing
the browser session authorizes passive same-origin access; it does not merge
document connections or authorize commands without the matching live connection
credential.

The connection begins with complete Global and optional Project snapshots.
Runtime closes it on browser loss, backpressure, revision gap, Product Quit, or
replacement, immediately releasing its Workbench Project Use. Closing one tab
removes only that connection; a shared browser session remains live while any
of its other connections remain. After its final connection closes, a retained
client cookie is stale and the next document creates a fresh browser session.
There is no idle timer, unload release request, attachment anchor, reconnect
reservation, heartbeat, recovery deadline, or Reconnect button. Refreshing
creates an entirely new connection and snapshots.

Each Project has at most one Workbench owner. Once a browser tab or Electron
BrowserWindow explicitly opens a concrete Project target, that requesting
Workbench directly acquires the target at Runtime's atomic binding commit. If a
different Workbench owned the Project, that previous owner is displaced; the
requesting destination does not ask for a second ownership confirmation. The
only duplicate-open exception is within one Desktop host: when Desktop window D2
opens a Project already owned by Desktop window D1, Desktop focuses D1, leaves
D1 as owner, and leaves D2's existing binding unchanged.

A displaced page remains loaded on a detached, read-only surface with its last
presentation but has no Project command authority. It alone offers **Open Here**,
which is an explicit request to acquire that same Project back under the same
rule. For Desktop, Runtime retargets the displaced window's topology route to
Root without erasing that renderer-local presentation. Ownership transfer does
not close either browser tab or native window and does not transfer frontend
presentation state.

Working Copies are the only persistent cross-document recovery state for
unsaved Workbench values. Disposable Canvas camera, selection, panel geometry,
and other presentation state may remain frontend-local. Terminals keep their
own Runtime Project Use and are not made durable or migrated by this rule.
