# Native Hosts Use A Narrow Runtime Control Channel

Runtime exposes a deterministic per-user Unix-domain socket on macOS and a
current-user named pipe on Windows before business services become ready. The
endpoint is protected by same-user kernel peer checks plus a process-lifetime
owner lock or mutex. No dynamic HTTP address, credential, or owner record is
persisted for discovery.

The wire protocol is length-prefixed UTF-8 JSON with a one-MiB frame cap and
closed Rust-generated request, response, and event enums. The mandatory first
frame fixes protocol name, protocol version, product version, and either the
`launcher` or `cli` role. There is no JSON-RPC method string, version
negotiation, compatibility mode, request replay, or event history.

Control requests are limited to:

- activate a closed Runtime/Desktop/browser/Project intent;
- inspect Runtime identity and status;
- issue CLI authorization;
- register the one source-development Vite origin;
- create a one-use Desktop launch ticket for a known window key;
- report a Desktop window closed; and
- request Product Quit.

Product Quit requests from external product surfaces use this Control request.
They are not duplicated as a Workbench HTTP business command; Runtime's own tray
may invoke the same internal transition directly.

Its events are limited to Desktop recent-Project snapshots, Desktop window
open/focus instructions, and Product exiting/replacing. Runtime internally
promotes the Desktop launcher connection after Desktop activation. There is no
public `desktop_host` role, generic business forwarding, Project snapshot,
settings object, renderer credential, or unload protocol on Control.

Project, Canvas, settings, generation, file, and terminal traffic uses the
role-partitioned loopback business surfaces. CLI authorization is bound to the
live `cli` Control connection. Desktop tickets are bound to the promoted host
and window key and consumed once by the renderer connection request; the stable
BrowserWindow URL contains no credential.

Each connection has one serialized writer and bounded outbound queue. Enqueue
or write failure closes the connection rather than dropping and continuing.
Clients surface `runtime_lost`; they do not reconnect, restart Runtime, or
replay a request inside the transport.

The native ensure-and-connect sequence may wait for an owner that is still
starting or start Runtime only after acquiring and rechecking the owner lock.
That bounded startup synchronization is not an automatic retry of an accepted
business request.
