# Operation Queue Pressure Rejects Before Acceptance

Each resource lane has Runtime-owned budgets for both waiting Operation count
and retained canonical-input bytes. These budgets have no time component. The
first `StartOperation` for a reserved Operation ID binds that reservation to the
canonical input digest before admission is decided.

When the lane has capacity, Runtime atomically creates the Operation in
`queued`. When either budget is exhausted, Runtime returns the retryable
`lane_queue_full` error without creating an Operation, acquiring a Project Use, or
leaving behind a deferred admission task. The bound reservation remains valid:
the caller may retry the same ID with the same canonical input, while different
input is an idempotency conflict. The initiating HTTP request never waits for a
lane permit, and Runtime does not invent a `Retry-After` estimate it cannot
justify.

Once accepted, an Operation in `queued`, `running`, or `cancelling` is never
evicted or preempted to admit newer work. Runtime may reclaim only terminal
summaries and unused reservations under their separate memory budgets. This
was chosen so Runtime either clearly accepts responsibility for work or clearly
rejects it before acceptance, without hidden waiting or overload-driven loss.
