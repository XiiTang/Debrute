# Browser API Uses Same-Origin Sessions

Runtime binds one required dynamic loopback listener on `127.0.0.1:0`. It is
the sole Workbench browser origin and serves packaged assets, relative HTTP
APIs, the POST SSE Workbench connection, Terminal WebSockets, and transfer
content. Its port and credentials are never persisted or discovered by
scanning. The fixed Photoshop discovery listener remains a separate, narrow
integration bootstrap.

Every request must arrive from loopback and use Runtime's exact numeric Host.
State-changing requests and WebSocket upgrades additionally require the exact
Origin. Workbench routes emit no CORS allowance and do not accept CLI or
Photoshop authorization.

An ordinary browser storage partition establishes one opaque, host-only,
HttpOnly, SameSite-Strict session cookie. Every loaded document in that
partition reuses the same live browser session; opening another tab does not
replace the cookie or invalidate an existing connection. A missing or stale
cookie creates a fresh session without recovery or compatibility behavior.

Desktop receives an in-memory, single-use launch ticket from Control and passes
it once through preload; its stable Workbench URL contains no ticket or other
credential. Runtime consumes the ticket in the body of the renderer's
connection request and removes it atomically. Each Desktop BrowserWindow uses
its own storage partition, so the consumed ticket creates that window's isolated
browser session. Tickets have no disk persistence, expiry timer, used-ticket
set, or compatibility form.

Each loaded document opens exactly one POST SSE request at
`/api/workbench/connection`. One browser session may contain multiple document
connections, but each connection has its own command authority and at most one
Project binding. The first frames are `connection.opened`, one
`global.snapshot`, and, when requested, `project.bound` or
`project.open_failed`. `connection.opened` supplies one random, in-memory
connection credential. JavaScript sends it in a custom same-origin header for
commands; Runtime validates the cookie and credential as a pair. The credential
is never placed in a URL, cookie, Web Storage, file, environment variable, or
log.

`global.snapshot` and subsequent ordered Global change events are the sole
Workbench projections of Global settings, Integration settings, and packaged
Product state. The Workbench neither follows connection establishment with
duplicate state GETs nor applies complete state returned by an action command.
Such commands return only their closed outcome and any action-specific
diagnostic. UI command progress may settle before the corresponding event is
processed; the protocol does not add a response revision wait or a response
state fallback. Loss of the event connection is already a terminal page state.

Likewise, `project.bound` establishes the connection's one bound-Project
projection. The client does not mirror that successful first binding in a
separate `initialProject` cache before reading the same bound projection.
Project snapshots, including health, enter Workbench only through binding and
ordered Project events. There are no duplicate snapshot or health GETs and no
Workbench command that manually refreshes the Project; Runtime-owned filesystem
watching and internal refreshes publish through the existing event authority.

The connection is the command and Project-binding lifetime. Runtime closes it
on Project-event backpressure, revision gaps, shutdown, or transport loss and
revokes its credential and Workbench Project Use. There are no split Global and
Project streams, EventSource reconnect, heartbeat, continuity deadline,
attachment anchor, participant release, unload request, or automatic command
replay. The loaded Workbench presents an ended-connection state; a manual page
refresh creates a fresh browser connection and complete snapshots.

Passive Project media GETs require a live browser session with at least one
live connection bound to the requested Project, but no JavaScript bearer. They
cannot mutate state. The Terminal WebSocket additionally binds one exact live
connection credential and current Project binding before accepting terminal
frames. Rebinding, preemption, or that connection's end closes the socket;
unexpected loss stops input and is not automatically reconnected.
