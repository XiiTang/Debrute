# Operation Observation Uses Command-Scoped Waits

CLI uses its existing native Control connection to obtain a connection-bound
loopback HTTP credential. Operation submission, listing, inspection, and
cancellation are ordinary HTTP request and response commands. Atomic submission
returns the Operation id and accepted snapshot before observation begins.

Model Operation submission uses one authenticated `multipart/form-data` HTTP
request to a dedicated endpoint. One `request` field carries the small closed
submission envelope, and one `input` file part carries the exact JSONL source
read from the CLI-local `--input` file or standard input. Runtime streams that
part into Runtime-owned temporary storage and enforces the complete-source
`16 MiB` limit while receiving it. It validates the entire JSONL source before
acceptance, then releases the temporary upload after constructing the immutable
Operation input. Runtime never opens a caller-supplied CLI-local path. There is
no upload session, chunk protocol, resume token, or alternate JSON-body
submission route.

The CLI exposes observation as two commands with stable liveness semantics:
`debrute operation inspect <operation-id>` always returns one current snapshot
immediately, while `debrute operation wait <operation-id>` opens the
command-scoped NDJSON response and may remain active until the Operation is
terminal. Waiting is a separate command rather than an `inspect --wait` mode so
an Agent can tell from the command itself whether the tool call may block and
stream multiple records.

Each CLI invocation emits exactly one final `debrute ok` or `debrute error`
result block and exits immediately after writing it, without an acknowledgement
exchange. Nonterminal snapshots use `debrute progress`: foreground submission
uses `event=operation.accepted`, and a standalone wait on an active Operation
uses `event=operation.observed`. An already-terminal Single writes its final
result directly. An already-terminal Batch first replays its committed Item
Outcomes retained with the Operation and then writes the final result,
preserving the same wait contract used while active. EOF is process or pipe
termination rather than a substitute for the structured terminal result.

The submission response itself is not a long-lived stream. A foreground
request command receives the accepted snapshot, flushes its
`operation.accepted` progress block, and then starts the same command-scoped
wait used by `debrute operation wait`. `--no-wait` instead writes its final
accepted result and stops after the submission response. A Batch wait reads
the Operation's retained Item Outcomes from the beginning, so an Item settling
between submission and the follow-up wait cannot be missed. This reuses one
observation contract instead of adding a combined submit-and-stream route.

Waiting uses one command-scoped NDJSON response for one Operation. A standalone
wait begins with its current snapshot. A Single Model Operation emits no
synthetic progress, provider polling, or heartbeat records and remains silent
until its terminal record. A Batch Model Operation emits one closed, typed
`batch_item.settled` record for every committed Item, then the Operation
terminal record. Runtime first reads the retained Outcomes through the
Operation's current settlement boundary, then follows later Outcomes through
an Operation-specific notification. The same wait therefore neither misses an
Item that settled between submission and observation nor emits one twice.
Internal phase changes and other internal state changes are not printed merely
because they occurred.

Each settled Item is one multi-line Agent Record block beginning with
`debrute progress cmd=<command> event=batch_item.settled`. The block contains
exactly one `batch_item` named record and, for success, zero or more repeated
`artifact` records. A failed Item carries its redacted, compacted source text in
the `batch_item` record's `log` field, with no Provider error code, message
wrapper, diagnostic object, or retained log sequence. This extends the
existing named-record grammar to progress blocks instead of embedding artifact
arrays as escaped JSON or repeating the complete Operation snapshot for every
Item. Runtime and CLI logs never enter stdout.

Ending the HTTP response or its credential-issuing Control connection ends only that
observer and never cancels the accepted Operation. A later CLI command obtains
fresh credentials and current state from the same Runtime instance. Runtime
adds no dedicated Operations SSE, WebSocket, Control event subscription,
all-Operations snapshot broadcast, event log, or keepalive protocol. This keeps
model execution observation sparse while allowing a foreground Batch command
to expose useful intermediate Item outcomes. A separate later wait replays the
same retained Outcomes in settlement order. Stable `itemIndex` identifies
repeated records across separate commands without introducing a public replay
cursor or persistent event log. The retained Outcome list and notification are
current-instance Operation observation state, not snapshot fields, durable
history, or another public protocol. They retire with the terminal Operation
record and disappear on Runtime exit.

Operation management uses one closed control-code set. `operation_not_found`
applies to `inspect`, `wait`, and `cancel` whether an id was never issued, its
terminal record was retired, or Runtime was replaced. `invalid_cursor` applies
only to `list`. `operation_failed` and `operation_cancelled` are terminal
outcomes of foreground request or `wait`; the snapshot state and optional log
carry the result rather than a cause code. `operation_already_terminal` applies
only when `cancel` loses to `succeeded` or `failed`; cancelling an already
`cancelling` or `cancelled` Operation succeeds. `submission_outcome_unknown`
applies only when submission may have been accepted before its response was
lost. `runtime_lost` ends any affected command without automatic reconnection.
There is no `already_cancelled`, `cancellation_rejected`,
`operation_unavailable`, `stale_operation`, `operation_timeout`, or public
Provider/Model error code.
