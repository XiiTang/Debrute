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

An ordinary browser launch establishes an opaque, host-only, HttpOnly,
SameSite-Strict session cookie. Desktop receives an in-memory, single-use
launch ticket from Control and passes it once through preload; its stable
Workbench URL contains no ticket or other credential. Runtime consumes the
ticket in the body of the renderer's connection request and removes it
atomically. Tickets have no disk persistence, expiry timer, used-ticket set, or
compatibility form.

Each loaded document opens exactly one POST SSE request at
`/api/workbench/connection`. The first frames are `connection.opened`, one
`global.snapshot`, and, when requested, `project.bound` or
`project.open_failed`. `connection.opened` supplies one random, in-memory
connection credential. JavaScript sends it in a custom same-origin header for
commands; it is never placed in a URL, cookie, Web Storage, file, environment
variable, or log.

The connection is the command and Project-binding lifetime. Runtime closes it
on Project-event backpressure, revision gaps, shutdown, or transport loss and
revokes its credential and Workbench Project Use. There are no split Global and
Project streams, EventSource reconnect, heartbeat, continuity deadline,
attachment anchor, participant release, unload request, or automatic command
replay. The loaded Workbench presents an ended-connection state; a manual page
refresh creates a fresh browser connection and complete snapshots.

Passive Project media GETs require the live browser session but no JavaScript
bearer. They cannot mutate state. The Terminal WebSocket additionally binds the
same live connection credential and current Project binding before accepting
terminal frames. Rebinding, preemption, or connection end closes the socket;
unexpected loss stops input and is not automatically reconnected.
