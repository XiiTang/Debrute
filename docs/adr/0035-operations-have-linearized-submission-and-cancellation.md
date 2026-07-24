# Operations Have Linearized Submission And Cancellation

An Operation moves only through `queued`, `running`, `cancelling`, and one of
`succeeded`, `failed`, or `cancelled`. Submission is one atomic
`SubmitModelOperation` request. Runtime validates the live CLI session
credential, canonical Project root and id, current Model Request envelope, and
output path rules before it creates a `queued` Operation with
a Runtime-issued canonical lowercase UUID v4 id and returns its first snapshot.
The id has no prefix and encodes no time, Model Kind, Project, sequence, or
Runtime instance; it is opaque control identity rather than a credential.
Rejection creates no Operation, opens no Project session, and starts no work.
Model Operation submission does not
compare a Project-wide revision. Acceptance retains the canonical root and
stable Project identity; it registers no Project Use and requires no open
Workbench. Runtime rechecks that identity before Model execution and again
before output commit. Output and provenance writes use the
filesystem capability captured at acceptance rather than resolving the path
again. A replacement observed before commit fails the affected work; a path
replacement racing the noninterruptible commit cannot redirect writes into the
replacement Project.

Submission rejection uses one closed caller-visible set. `invalid_input` covers
CLI arguments, JSONL and Model Request validation, mixed Model Kinds, execution
options, source-size limits, and invalid output paths. `project_invalid` covers
an absent, uninitialized, uncanonicalizable, or inaccessible Project.
`model_unavailable` combines an unknown Model id, missing required local
configuration, and an unavailable Product adapter. Duplicate explicit output
names inside one Batch are `invalid_input`. Unexpected failure before atomic acceptance uses `internal_error`.
There is no separate request, Batch, Model-kind-mismatch, output-exists,
model-not-configured, `output_conflict`, or Provider rejection code. Acceptance
does not inspect, hash, reserve, or claim output files.

`queued` is only the accepted Operation's handoff to its execution task.
Runtime imposes no process-wide model-execution concurrency limit: independent
Operations start independently, and a batch's own concurrency controls only
how many of its Batch Items it executes at once.

Submission has no reservation, caller idempotency key, or automatic transport
retry. If the client loses the response after sending a submission, it reports
`submission_outcome_unknown`. The caller may inspect recent Operations by
Project, Model Kind, and state in newest-first issuance order, but Runtime does not
promise exact correlation without the returned Operation id and the caller must
not blindly submit the same paid work again. Runtime adds no input digest,
submission nonce, or deduplication protocol for this low-probability local
failure. An id absent from the current registry returns `operation_not_found`,
whether it was never issued, its terminal record was retired, or Runtime was
replaced. Once accepted, Operation lifetime is independent of its initiating
connection and is never replayed after Runtime loss.

Canceling queued work completes immediately. Canceling running work first
enters `cancelling` and reaches `cancelled` only after cleanup succeeds; cleanup
failure produces a redacted `failed` result. Already committed Batch Items stay
committed and do not prevent cancellation of the remaining work. An Item inside
its short noninterruptible commit section may finish before execution drains,
but no later Item starts or commits. For a Single, artifact commit and the
transition to `succeeded` are one linearized completion, so cancellation races
only with the Operation's terminal transition. This gives acceptance, user
cancellation, external side effects, and Project commits one observable order
without exposing an Item-level cancellation race protocol.
