# Model Operation Snapshots Use One Closed Schema

`ModelOperationSnapshot` is one closed Rust-owned response schema. Its common
envelope contains exactly Operation `id`, Model Kind, lifecycle `state`, UTC RFC
3339 `acceptedAt`, shape-specific `execution`, bounded warning `diagnostics`,
and optional failure `log`. It contains no Project binding, requested output
directory or basename, revision, generic metadata bag, schema version,
capability flags, or transition timestamp collection.

`execution` is a closed union selected by shape. Single contains Model id,
effective `timeoutSeconds`, and successful terminal Artifact Pointers. Batch
contains `itemCount`, effective `concurrency`, effective `timeoutSeconds`,
`active`, `succeeded`, and `failed`. Derived counts and percentages are not
stored. Model Requests, output naming, replace policy, Model bindings, and raw
remote responses remain outside the public snapshot.

HTTP retains that nested union. Agent Records flatten it into one primitive
`operation` record with common fields `id`, `model_kind`, `state`,
`accepted_at`, and `shape`. Single adds `model` and `timeout_seconds`; Batch adds
`item_count`, `concurrency`, `timeout_seconds`, `active`, `succeeded`, and
`failed`. A failed Operation alone adds `log`.

A successful Single's `artifact` records immediately follow its Operation.
Batch settlement uses a separate `batch_item` record with `item_index`, `model`,
`status`, and optional failure `log`, followed by that Item's Artifact records.
Sequential grouping supplies parent identity, so Artifact records do not repeat
Operation or Batch ids.

Every Artifact Pointer has zero-based `artifactIndex`, canonical absolute
`outputPath`, actual `mimeType`, and optional known `width` and `height`.
Provenance is looked up by file content and is not copied into the immediate
result.

Post-commit provenance failures enter `diagnostics` as warnings without changing
the successful Item or Operation state. Model and remote failures use one
redacted bounded `log`; arbitrary provider fields, secrets, and unbounded logs
never enter the snapshot.

Operation ids are opaque canonical lowercase UUID v4 values. Missing and
malformed ids both produce `operation_not_found`. Cancellation is issued
directly and linearized by Runtime; the snapshot does not expose a stale
`canCancel` field.
