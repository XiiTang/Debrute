# Operation Cancellation Reports Whether Cancellation Won

`debrute operation cancel <operation-id>` is an idempotent request for the
target to reach its cancelled terminal state, not a generic request for it to
stop being active. A queued Operation cancels immediately. A cancellable
running Operation atomically enters cancellation, after which the request
returns without waiting for cleanup. Repeating cancellation while cancellation
is active or after it has completed succeeds and returns the latest snapshot.
The response adds no `won`, `accepted`, or `alreadyCancelled` field because the
returned state already distinguishes `cancelling` from `cancelled`.

For a batch, accepted cancellation immediately stops scheduling unstarted
items and requests cooperative abort of active model calls. Runtime preserves
committed item results and artifacts; an item without a committed outcome stays
unsettled rather than becoming failed. `cancelled` guarantees that Runtime has
stopped local execution and commits, not that an upstream service without a
cancellation API stopped remote work or reversed billing.

An already committed Batch Item does not make the Operation uncancellable.
Cancellation may preserve that Item while stopping the rest. An Item already
inside its short noninterruptible commit section may finish that commit before
local execution drains; Runtime does not roll it back or start another commit.
For a Single, artifact commit and transition to `succeeded` form one linearized
completion, so there is no public committed-but-still-cancellable phase.

Cancellation after successful or failed completion returns
`operation_already_terminal` with the latest snapshot. If cancellation and
completion race, the Runtime's first linearized state transition determines
the outcome. These are the only terminal states for which cancel is a failed
CLI command; repeated cancellation of an already `cancelled` Operation remains
successful. Cleanup failure after an accepted cancellation still produces a
failed Operation.

Every command still requires a live CLI session credential, but cancellation
adds no per-Project or per-Operation ACL. An id absent from the current registry
returns `operation_not_found`. No separate cancellation-request id is
introduced: the target Operation id and monotonic lifecycle make the
desired-state request idempotent.

Cancellation exposes no `already_cancelled`, `cancellation_rejected`,
`operation_unavailable`, or stale-Operation variant. An absent id always uses
`operation_not_found`, and loss of the current Runtime observation path uses
the shared `runtime_lost` command error.
