---
status: accepted
---

# Canvas State Events Follow Projection Scope

ADR 0008 established one `patchCanvasState` command and atomic Canvas Workspace
persistence. This ADR supersedes only its rule that every changed Canvas patch
publishes a complete Project snapshot.

A Canvas patch that leaves Folder Disclosure unchanged cannot change Project
Tree loading or Canvas Resource membership. Runtime therefore publishes one
typed `canvas.state.changed` event containing the binding, Project revision,
and complete Canvas Workspace Document. Workbench replaces only that workspace
inside its current available Canvas snapshot and preserves the current Project
Tree and Canvas Resource View identities.

A patch that changes Folder Disclosure may load directories and change the
visible Canvas Resource View. Runtime continues to publish one complete Project
snapshot for that command. A no-op publishes no revision or event. One command
never publishes both event shapes.

The event split follows the mutation's real authority boundary. It does not add
a second Canvas command, partial persisted document, optimistic merge,
compatibility event, or fallback snapshot request.
