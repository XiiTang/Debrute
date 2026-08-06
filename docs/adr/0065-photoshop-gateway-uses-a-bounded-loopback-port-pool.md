# Photoshop Gateway Uses A Bounded Loopback Port Pool

Runtime's main Workbench HTTP server keeps its OS-assigned dynamic loopback
origin. Photoshop instead receives one application-specific loopback gateway:
Runtime attempts the closed ordered port pool `32124` through `32131`, and the
UXP plugin probes only that same pool by opening `/photoshop/session` with the
exact `debrute.photoshop.v1` WebSocket subprotocol. A matched gateway directly
owns the plugin's one ephemeral session. Its WebSocket carries bounded JSON
control and defines session liveness, while fixed command-scoped HTTP routes
carry file bytes using the same session bearer. There is no separate HTTP
discovery request, WebSocket file-chunk protocol, second HTTP identity,
generated signed-URL subsystem, or redirection into the Workbench server.

The gateway file surface is closed to one command-content GET and one
command-item PNG POST. Both use the socket session's bearer in the
`Authorization` header, and neither selects a destination independently of its
already admitted Photoshop command.

An occupied port advances Runtime to the next pool entry. Exhausting the pool
makes Photoshop connectivity unavailable without preventing Runtime or
Workbench operation. The plugin does not scan arbitrary ports, read a Runtime
locator file, request broad host-filesystem access, or use a fixed port for the
entire Workbench server. The Workbench keeps its dynamic origin and
role-partitioned authorization.
