# Runtime Uses One Process

Debrute Runtime is one Rust operating-system process containing native
single-instance Control, the macOS or Windows tray event loop, Workbench
services, Project sessions, operations, terminals, file watching, integrations,
and product update coordination. The native event loop remains on the
platform-required main thread while asynchronous and worker execution stays in
the same process.

This was chosen over a Supervisor/Engine pair because the tray is not required
to survive a Runtime crash. A child process, private supervisory protocol,
duplicated lifecycle state, and two-phase shutdown would add failure modes
without satisfying a requirement. The removed TypeScript backend is not kept
as a sidecar, fallback, or compatibility backend.
