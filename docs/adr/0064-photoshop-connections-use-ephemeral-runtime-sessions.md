# Photoshop Connections Use Ephemeral Runtime Sessions

The first-version UXP plugin connects directly to the local Runtime without a
user authorization ceremony or a persistent plugin identity. Runtime gives
each accepted WebSocket connection a fresh opaque plugin-session identity and
bearer, and expires both when that connection ends. Workbenches discover
Photoshop Documents only through the live session, and every transfer binds
the exact session and document so reconnection cannot redirect an in-flight
command. This deliberately removes one-use codes, stored P-256 keys, signed
pairing challenges, pairing records, and revocation behavior. It supersedes
those parts of ADR 0009 while retaining loopback-only discovery,
narrow sessions, origin restrictions, Project-relative paths, and Runtime
validation. The concrete loopback gateway is governed by ADR 0065. Protection
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
