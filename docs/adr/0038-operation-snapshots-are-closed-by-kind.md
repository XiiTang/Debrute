# Operation Snapshots Are Closed By Kind

`OperationSnapshot` is a closed Rust-owned discriminated union rather than a
free-form progress record. Every variant shares an envelope containing the
operation id and revision, kind, Product or Project scope, lifecycle state,
timestamps, and current cancellation availability. Its detail is selected by
the closed Operation kind and defines that kind's phase enum, progress shape,
terminal result reference, and redacted failure variants. Rust definitions
generate the TypeScript types and runtime validation schema used by clients.

Progress explicitly distinguishes indeterminate work from determinate
`completed`, `total`, and `unit` values; clients derive percentages. A kind may
add typed counters such as successful, failed, skipped, or active items, but
cannot emit arbitrary key/value bags. Phase and failure codes are protocol
values, not Runtime-authored user-facing prose; clients localize them. Provider
payloads, secret-bearing messages, and unbounded diagnostics never enter the
snapshot. This was chosen over today's unrelated CLI progress maps,
product-update states, and integration flags so every surface observes one
exhaustive contract while each Operation kind still expresses its real work.
