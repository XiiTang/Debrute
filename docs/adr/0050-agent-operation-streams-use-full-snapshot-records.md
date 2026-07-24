# Agent Operation Streams Use Full Snapshot Records

Operation-aware CLI commands preserve the existing Agent Record protocol and
add no competing serialization mode. A foreground start emits one flushed
progress record containing the complete accepted Operation snapshot. Each
later, coalesced revision emits one progress record containing the complete
latest snapshot. Duplicate revisions and field-level deltas are never emitted.

At terminal state, CLI emits one final command-status record together with the
complete terminal Operation record and any bounded typed result records. A
non-waiting submission emits no progress prefix; its final record contains the
accepted snapshot because acceptance is that command's result. Listing,
inspection, and waiting use the same Operation projection, with waiting always
emitting its initial current snapshot before later revisions.

Common and kind-specific fields come from the closed Rust Operation union and
remain bounded, redacted, and non-localized. Free-form provider payloads and
Runtime-authored progress prose are excluded. This was chosen over delta
streams and a second serialization format so an Agent can interpret any record
without retaining earlier output or reconciling competing CLI contracts.
The exact record names and fields belong to the implemented protocol and CLI
documentation.
