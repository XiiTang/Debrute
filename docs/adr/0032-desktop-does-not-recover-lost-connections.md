# Desktop Does Not Recover Lost Connections

Intentional window close removes that Runtime window route. Closing the final
window exits Electron and leaves Runtime running. A later Desktop activation
creates a fresh root window unless the activation explicitly names a Project.

Unexpected Desktop Control loss is a local product failure: Main presents a
native error and exits. Runtime does not retain bounds or a recovery plan,
Desktop does not automatically reconnect or restart Runtime, and no renderer
request is replayed. A later user launch performs a fresh ensure-and-connect
sequence.

A failed or gone renderer is likewise not repaired through session migration.
Working Copies protect the narrow unsaved text and not-yet-accepted Canvas
Feedback values; other frontend presentation state is disposable. This keeps
recovery proportional to a local single-machine application rather than
implementing distributed continuity machinery.
