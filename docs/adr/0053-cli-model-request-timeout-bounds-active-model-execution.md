# CLI Model Request Timeout Bounds Active Model Execution

Model Request commands replace the ambiguous whole-command timeout with a
dedicated active model-execution timeout. It bounds one continuous active phase:
from invoking the Debrute Model through upstream request submission, any remote
task polling, response reads, and Generated Asset download. It does not include
the brief execution-task handoff, Project commit, cleanup, or CLI observation.
A Single Model Operation uses one clock rather than resetting it for individual
HTTP requests. Every Batch uses an independent clock for each Item; its
command-level value applies uniformly to every Item. Model Request JSON and
Batch Item records contain no timeout field. Callers that need different timeout
policies submit separate Batches.

Runtime uses a `30m` default for `video` and a `10m` default for `image`, `tts`,
`music`, and `sound-effect`. These are intentionally two execution-duration
classes rather than Model-specific settings: video is the consistently
submit-poll-download Kind, while the other Kinds mix mostly synchronous work
with some asynchronous adapters. An omitted value uses the applicable default.
The CLI option is `--timeout <duration>`, where the duration is a
positive integer followed by exactly one of `s`, `m`, or `h`. Bare numbers,
milliseconds, decimals, zero, negative values, compound values such as
`1h30m`, and values outside Runtime's representable monotonic-clock range are
rejected before Operation acceptance rather than normalized or silently
clamped. There is no product-defined maximum: an explicit duration is the
caller's chosen wait policy, and a real upper bound on Runtime load could not be
provided by limiting one Operation while multiple Operations remain
independently submittable. The accepted value belongs to the immutable Model
Request execution policy.

Snapshots expose only the effective `timeoutSeconds`; they do not retain
whether the value came from a Runtime default or an explicit CLI option.

Expiration produces a redacted, compacted failure `log` followed by
model-execution-owned cleanup. A Single Model Operation fails; a Batch records
a failed Item with the same direct log text and continues to settle its other
Items under the batch-success contract. The public result exposes no timeout or
Provider failure code; a foreground command reports the Operation-level outcome
through its ordinary control code. Model adapters may use fixed lower-level transport safeguards, but
Operation input exposes no separate connection, inactivity, polling, download,
or cleanup deadlines. This preserves Agent control over paid model waiting
without reintroducing a queue, whole-Operation, or observer timeout.
