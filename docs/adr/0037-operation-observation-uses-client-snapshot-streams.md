# Operation Observation Uses Client Snapshot Streams

Operation observation is current-state synchronization, not event-log replay.
Every authorized client connection may open at most one dedicated Operations
SSE connection, regardless of how many Operations it observes. A Workbench
connection, CLI watcher, or Photoshop link is a separate observer. This avoids
requiring cross-client stream ownership.

On connect and reconnect, Runtime sends one role-filtered
`operations.snapshot` containing every visible active Operation and retained
terminal summary. Subsequent, coalesced `operation.changed` events carry the
complete latest snapshot and a monotonically increasing Operation revision;
retirement emits `operation.retired`. Runtime does not replay progress events or
use `Last-Event-ID` as Operation history. Disconnecting observation neither
cancels work nor releases a Project Use owned by the Operation.
High-volume logs, provider payloads, and diagnostics are excluded from this
stream and remain separate bounded reads. This was chosen over per-Operation
connections and replay logs so reconnect always converges on current truth
without coupling Runtime memory to elapsed work or event volume.
