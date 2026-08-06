# Operations Have Linearized Submission And Cancellation

A Model Operation moves only through `queued`, `running`, `cancelling`, and one
of `succeeded`, `failed`, or `cancelled`. Submission is one atomic
`SubmitModelOperation` request containing the CLI's canonical invocation working
directory, one execution shape, one or more Model Requests, and immutable
timeout, replace, and concurrency policy.

Before acceptance Runtime resolves every required `output.directory` and each
Model-declared local argument path against the invocation directory. It
validates the closed request envelope and creates one immutable Accepted Model
Binding for each unique Model id from one Global configuration snapshot. Every
request and binding must validate before Runtime creates an Operation and issues
its opaque UUID. Rejection creates no Operation, opens no Project, and starts no
work.

Accepted absolute paths are immutable values, not Project ownership or long-
lived directory capabilities. Immediately before publication Runtime safely
opens or creates the exact output directory. A regular file, symbolic link,
inaccessible path, or unsafe component fails the affected Item without
redirecting it. A short-lived directory capability stages and publishes the
complete Item; Artifact Pointers and provenance use those actual absolute paths.

Acceptance never inspects candidate output files, hashes or reserves names,
claims destinations, or rejects duplicate paths across Batch records. The
caller owns the submitted JSONL. `--replace` is applied only at the actual file
commit. Global provenance is attempted after file publication.

`queued` is only the accepted Operation's handoff to its execution task. Runtime
has no process-wide Model Request concurrency limit; each Batch's concurrency
controls only its own Items.

Submission has no idempotency key, input digest, deduplication protocol, or
automatic retry. If transport is lost after submission but before the Operation
id arrives, CLI reports `submission_outcome_unknown`. Operation listing can
narrow by Model Kind and state but cannot prove correlation without the returned
id. A missing id returns `operation_not_found`, whether it was never issued,
retired, or belonged to a replaced Runtime.

Cancelling queued work completes immediately. Cancelling running work enters
`cancelling` and reaches `cancelled` only after Debrute-owned execution stops.
An exact adapter may make one bounded best-effort remote cancellation call;
failure of that call does not change accepted local cancellation. Already
committed Batch Items remain committed. A Single's artifact commit and terminal
success are linearized, so cancellation races with one terminal transition
rather than an exposed Item-level protocol.
