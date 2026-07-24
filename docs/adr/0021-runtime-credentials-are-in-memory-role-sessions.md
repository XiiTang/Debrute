# Runtime Credentials Are In-Memory Role Sessions

Runtime discovery contains no credential. Public native Control roles are only
`launcher` and `cli`; the operating-system user and kernel peer identity are
their trust boundary. Desktop promotion is internal state on a launcher
connection, not another public role.

Workbench, CLI, and Photoshop each receive separate in-memory authorization
with a closed route set. A Workbench browser session is HttpOnly; its POST SSE
connection issues a narrower JavaScript-held command credential. A CLI obtains
its HTTP authorization only through its live `cli` Control connection and keeps
that connection open for the command. Photoshop pairing remains scoped to the
plugin protocol. No credential can substitute for another role.

Credentials are never written to discovery files, URLs, logs, environment
variables, or command output. Closing the owning connection revokes the
authorization. Runtime-owned work already accepted follows its own typed
lifetime; revocation does not imply automatic cancellation or replay.
