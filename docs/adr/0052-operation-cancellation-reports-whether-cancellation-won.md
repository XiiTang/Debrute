# Operation Cancellation Reports Whether Cancellation Won

Operation cancellation is an idempotent request for the target to reach its
cancelled terminal state, not a generic request for it to stop being active. A
queued Operation cancels immediately. A cancellable running Operation
atomically enters cancellation, after which the request returns without waiting
for cleanup. Repeating cancellation while cancellation is active or after it
has completed succeeds and returns the latest snapshot.

Cancellation after successful or failed completion reports that the Operation
was already terminal; cancellation after the kind-specific irreversible commit
boundary reports that cancellation can no longer win and the Operation
continues. Both are failed CLI commands and include the latest authorized
snapshot so an Agent can distinguish losing the completion race from achieving
cancellation. If cancellation and completion race, the Runtime's first
linearized state transition determines the outcome. Cleanup failure after an
accepted cancellation still produces a failed Operation.

Every request reauthorizes the caller's role and Project scope because an
Operation id is not a bearer capability. Retired and previous-instance ids
remain distinguishable errors. No separate cancellation-request id is
introduced: the target Operation id and monotonic lifecycle make the
desired-state request idempotent.
