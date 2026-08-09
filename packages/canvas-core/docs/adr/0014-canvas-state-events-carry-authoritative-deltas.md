---
status: accepted
---

# Canvas State Events Carry Authoritative Deltas

ADR 0013 separated Canvas State-only changes from complete Project snapshot
events. This ADR supersedes only ADR 0013's rule that the state-only event
carries the complete Canvas Workspace Document.

Runtime still validates, normalizes, and atomically persists the complete
root-scoped Canvas Workspace Document. When Folder Disclosure is unchanged, it
compares the previous and resulting normalized Canvas State and publishes one
`canvas.state.changed` event containing:

- each changed Project path and its complete resulting `CanvasNodeState`, or
  `null` when that sparse state was removed; and
- the complete resulting `occlusionOrder` only when that order changed.

The event contains no complete Workspace, field patch, optimistic value,
compatibility shape, or fallback snapshot. A no-op still publishes no Project
revision or event. A Folder Disclosure change still publishes one complete
Project snapshot and never also publishes this delta.

Workbench accepts the event only through the existing strict binding and
consecutive Project-revision stream. It first applies the delta structurally to
its canonical Canvas State while preserving Folder Disclosure, Project Tree,
and Canvas Resource View identities. The mounted Canvas Runtime then applies
the same accepted delta to its existing Scene. Exact-path content subscribers,
geometry and spatial entries, affected edge groups, and base z values are the
only eligible consumers. React membership is replaced only by a complete
resource projection.

Automatic Layout rectangles belong to that complete resource projection and
remain available as the reset baseline. Canvas Stage Runtime remains the sole
post-mount DOM authority for node geometry, z-index, and visibility. These
boundaries prevent a state-only confirmation from rebuilding the Scene,
rescanning culling membership, or replaying stale React geometry.
