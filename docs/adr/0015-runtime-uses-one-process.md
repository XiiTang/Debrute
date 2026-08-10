# Runtime Uses One Process

Debrute Runtime is one Rust operating-system process containing native
single-instance Control, the macOS or Windows tray event loop, Workbench
services, Project sessions, operations, terminals, file watching, professional-tool connectivity,
and product update coordination. The native event loop remains on the
platform-required main thread while asynchronous and worker execution stays in
the same process.

This was chosen over a Supervisor/Engine pair because the tray is not required
to survive a Runtime crash. A child process, private supervisory protocol,
duplicated lifecycle state, and two-phase shutdown would add failure modes
without satisfying a requirement. The removed TypeScript backend is not kept
as a sidecar, fallback, or compatibility backend.

Whole-Product removal has one narrow self-deletion exception: after the live
Runtime has validated and durably recorded the exact removal plan, it launches
a manifest-validated copy of its own execution closure outside Product-owned
paths. That one-shot child waits for the authoritative Runtime process to exit,
executes only the closed deletion plan, and removes itself. It exposes no
Control or business service, owns no independent lifecycle or Product state,
and uses no private supervisory protocol. The user-session Runtime remains the
only live service authority.
