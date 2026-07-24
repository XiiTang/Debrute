# Operations Are Not Automatically Retried

Runtime never automatically re-executes a failed Operation request or phase.
Any failure ends that Operation as `failed`; a caller that wants to try again
must explicitly submit a new Operation. Terminal Operations are immutable and
cannot be restarted.

Repeatedly polling the status or result of one already-submitted provider task
ID remains part of the same attempt and is not a retry. It must not resubmit the
provider request. No Single or Batch Model Request exposes a retry count,
backoff loop, or CLI `--retries` option.

This was chosen because the current batch retry loop treats every failure alike
and cannot prove whether an external provider has already accepted a request.
Requiring a new Operation makes every repeated execution explicit, observable,
and separately cancellable, and avoids hiding duplicate external side effects
inside one Operation.
