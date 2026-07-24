# Photoshop Bridge Uses A Link-Scoped Protocol

Photoshop plugins connect to the shared Runtime through a dedicated client-scoped
protocol and must explicitly link to a live Project before transferring files.
Plugins receive neither Workbench/CLI authority nor absolute Project paths; they use
Project-relative paths, client-scoped state, and short-lived transfer URLs. This
was chosen over giving professional-tool plugins general Workbench authority or
direct filesystem access so both UXP and CEP share one narrow trust boundary and
Project visibility rules remain runtime-owned.

UXP and CEP cannot use the native Runtime Control Channel. They therefore
bootstrap only through the fixed loopback endpoint
`127.0.0.1:32124/adobe-bridge/discovery`. Its versioned response reveals only
Adobe Bridge availability and the current dynamic bridge HTTP and WebSocket
endpoints; it grants no session, native role, Project authority, or reusable
Workbench credential. Plugins do not scan ports, read Runtime discovery files,
or fall back to alternate endpoints.

This fixed listener is an integration-specific discovery shim over the same
single Runtime process, not a second business backend. Failure to bind
it makes Adobe Bridge explicitly unavailable in Runtime live state and the
Workbench settings surface, while the required dynamic Workbench origin and
the rest of Runtime may still become `Ready`. Plugin discovery failure is
reported as Bridge offline rather than causing a Runtime restart or endpoint
fallback.

On the dynamic listener, only the closed Photoshop Bridge route group accepts
the exact source-defined UXP and CEP origins and only that group answers the
required CORS preflight. Every request also requires its client-scoped Bridge
session. Browser sessions and CLI authorization cannot call these routes, and a
Bridge session cannot call Workbench or CLI routes.

`Photoshop` is the current integration name, not a permanent claim that it will
be the only professional-tool plugin. After Effects, Illustrator, or another
future plugin must add its own closed identity, origin allowlist, route group,
session capabilities, and discovery decision rather than inheriting Photoshop
authority. A general plugin platform and final shared discovery naming are not
part of the current Runtime refactor.

Planned product replacement sends connected plugins `runtime_replacing` before
closing their sessions. A live plugin may then wait for discovery only within
the bounded replacement-startup window and create a new Bridge session after a
different Runtime instance becomes `Ready`; it reads a full current snapshot
and migrates no session, link, or transfer state. Pending and running transfers
fail explicitly and are never replayed. A WebSocket loss without the planned
signal is an unexpected disconnect: the plugin remains disconnected and makes
no automatic discovery or reconnection attempt until the user invokes its
explicit Reconnect action.
