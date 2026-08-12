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

The gateway surface is closed to one WebSocket-upgrade GET, one command-content
GET, one command-item PNG POST, and CORS OPTIONS only for the two byte routes.
HEAD and every reverse or unlisted method return 405; unknown paths return 404.
Both byte routes use the socket session's bearer in the `Authorization` header,
and neither selects a destination independently of its already admitted
Photoshop command. Every HTTP failure uses the same closed Photoshop v1 JSON
error envelope, including perimeter and authorization rejection.

The Runtime-owned Photoshop enable setting controls the complete gateway
lifecycle. Off binds no pool port and retains no Photoshop route or session
authority. On attempts the complete pool immediately. An occupied port advances
Runtime to the next entry; exhausting the pool publishes `unavailable` without
turning the setting off or preventing Runtime and Workbench operation. Runtime
retries the complete pool after each five-second interval with no overlapping
rounds. The plugin does not scan arbitrary ports, read a Runtime locator file,
request broad host-filesystem access, or use a fixed port for the entire
Workbench server. The Workbench keeps its dynamic origin and role-partitioned
authorization.
