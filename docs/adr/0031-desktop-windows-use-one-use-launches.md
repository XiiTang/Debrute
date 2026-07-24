# Desktop Windows Use One-Use Launch Tickets

Runtime owns an in-memory topology containing each live Desktop window's opaque
key and root-or-Project route. It stores no bounds, focus history, renderer
acknowledgement, recovery topology, or persistent window session.

One Desktop Window Host requests a random one-use ticket for a Runtime-issued
window key. The response includes the ticket, a stable Workbench URL, and the
current Runtime-owned Workbench theme preference. The Host is the sole local
owner of the record joining that key to a BrowserWindow identity. It constructs
the BrowserWindow hidden, inserts the record and close listener, stores the
ticket in that record, applies the pre-render background, and only then loads
the stable URL. Narrow preload IPC resolves the sender's real BrowserWindow
through the Host and consumes the record's ticket once while the document is
loading; the renderer includes it in the body of its POST SSE connection
request. Runtime validates host, key, and route, consumes the ticket atomically,
creates an isolated browser session, and binds that connection to the window.

The local record explicitly moves from `opening` to `live` after load succeeds.
Focus received during `opening` is deferred until that transition. Desktop Main
does not mirror the registry, expose Runtime window keys for reload, or store a
second copy of the ticket in the Electron adapter.

Tickets exist only in memory, have no timer, and leave no used-ticket record.
They are not Project credentials, browser URL parameters, cookies, disk state,
or reusable Main-process business authority. Renderer commands use the
connection credential issued by the SSE bootstrap and go directly to Runtime.
The accompanying theme preference is a launch-time presentation snapshot, not
a Desktop settings store or a general settings surface on Control. Missing or
invalid launch presentation fails the window launch instead of selecting a
default background.

An explicit reload addresses the Host by BrowserWindow identity. Reloads are
strictly serialized, and every request obtains a fresh ticket; they are not
coalesced, retried, or given a fallback URL. A queued reload whose window has
already closed is discarded before requesting a ticket. A reload failure for a
still-live window clears any unconsumed ticket and is reported once, while the
window record remains available for a later manual reload.

Window close and Product exit preempt pending launch work. Close invalidates one
record immediately and reports only a non-final key. Product exit or replacement
invalidates all records, removes native listeners, destroys the windows, closes
Control, and exits Desktop. Late ticket or load results from invalidated records
have no authority to show windows, mutate topology, or surface another failure.

Replacing a Project in that Workbench retargets the Runtime window route.
Opening a Project already owned by another Desktop window focuses the existing
window. A browser preemption retargets the old Desktop window to Root in the
Runtime topology, but the renderer keeps its last Project presentation visible
as a detached, read-only surface. An explicit **Open Here** action may preempt
back. Closing the window removes its topology entry.
