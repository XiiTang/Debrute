# Desktop Windows Use One-Use Launch Tickets

Runtime owns an in-memory topology containing each live Desktop window's opaque
key and root-or-Project route. It stores no bounds, focus history, renderer
acknowledgement, recovery topology, or persistent window session.

Desktop Main requests a random one-use ticket for a Runtime-issued window key.
The response includes the ticket separately from a stable Workbench URL. Main
loads the stable URL and exposes the ticket once through narrow preload IPC;
the renderer includes it in the body of its POST SSE connection request.
Runtime validates host, key, and route, consumes the ticket atomically, creates
an isolated browser session, and binds that connection to the window.

Tickets exist only in memory, have no timer, and leave no used-ticket record.
They are not Project credentials, browser URL parameters, cookies, disk state,
or reusable Main-process business authority. Renderer commands use the
connection credential issued by the SSE bootstrap and go directly to Runtime.

Replacing a Project in that Workbench retargets the Runtime window route.
Opening a Project already owned by another Desktop window focuses the existing
window. A browser preemption retargets the old Desktop window to Root in the
Runtime topology, but the renderer keeps its last Project presentation visible
as a detached, read-only surface. An explicit **Open Here** action may preempt
back. Closing the window removes its topology entry.
