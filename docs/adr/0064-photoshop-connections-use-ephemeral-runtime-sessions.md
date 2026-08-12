# Photoshop Connections Use Ephemeral Runtime Sessions

The first-version UXP plugin connects directly to the local Runtime without a
user authorization ceremony or a persistent plugin identity. Runtime gives
each accepted WebSocket connection a fresh opaque plugin-session identity and
bearer, and expires both when that connection ends. Workbenches discover
Photoshop Documents only through the live session, and every transfer binds
the exact session and document so reconnection cannot redirect an in-flight
command. The plugin represents that binding as an immutable revocable session
lease which owns the exact socket, loopback origin, and bearer. Reconnection
creates a different lease; an operation admitted by the old lease cannot send
control or bytes through the replacement connection. There are no one-use
codes, stored P-256 keys, signed pairing
challenges, pairing records, or revocation behavior. The connection remains
loopback-only with narrow sessions, origin restrictions, Project-relative
paths, and Runtime validation. The concrete loopback gateway is governed by
ADR 0065. Protection
against a local process imitating the plugin is deferred until the product
introduces an explicit security boundary.

The plugin starts the accepted socket with one Photoshop-specific message
containing its host version and complete initial Document snapshot. Runtime
responds with the fresh session identity, HTTP bearer, and Runtime instance
identity. There is no challenge, post-connect state GET, or restoration of an
earlier socket's session.

The versioned socket uses only Photoshop-specific session, complete-snapshot,
directory-request, export, placement-result, and planned-replacement messages.
Unknown or structurally invalid messages close that ephemeral session. The
Workbench projection contains only live session identity, Photoshop version,
and Document identities and titles; credentials and command state remain inside
the Photoshop boundary.

Socket loss revokes new dispatch immediately. An export-item upload already
accepted by Runtime's HTTP handler remains pinned until its Project commit
settles. A complete valid success response is committed even if the socket
closes immediately afterward; a dispatched upload without a trustworthy
response has an unknown outcome. The plugin never retries, queries, rolls back,
finishes, or replays an unknown item, and it does not attempt later batch items.
