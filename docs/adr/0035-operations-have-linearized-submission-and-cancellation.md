# Operations Have Linearized Submission And Cancellation

An Operation moves only through `queued`, `running`, `cancelling`, and one of
`succeeded`, `failed`, or `cancelled`. Submission uses two side-effect-free
steps rather than a caller-generated idempotency window. `ReserveOperation`
issues an opaque operation id containing the current Runtime instance id and a
monotonically increasing sequence, but creates no Operation, acquires no Project Use,
and starts no work. `StartOperation` supplies that id and the input; Runtime
validates current authority, input, and Project revision, then atomically
creates the queued Operation before returning. Repeating `StartOperation` with
the same canonical input returns the same Operation, while different input for
that id is a conflict.

Runtime retains only an in-memory issued-sequence high-water mark, not
time-limited idempotency receipts. A current-instance id at or below the
high-water mark whose reservation or Operation record has been evicted returns
`operation_retired` and can never start work. An id above the high-water mark is
invalid, and an id from another Runtime instance returns
`stale_runtime_instance`. Unused reservations and terminal records may
therefore be removed under explicit count or memory pressure without creating
a duplicate-submission path. Once accepted, Operation lifetime is independent
of its initiating connection and is never replayed after Runtime loss.

Canceling queued work completes immediately. Canceling running work first
enters `cancelling` and reaches `cancelled` only after cleanup succeeds; cleanup
failure produces a redacted `failed` result. Every Operation kind defines an
irreversible commit boundary. A cancellation linearized before that boundary
prevents successful commit, while cancellation after it is rejected and work
continues. This was chosen so HTTP retries, user cancellation, external side
effects, and Project commits have one observable order rather than competing
best-effort flags.
