# CLI Exit Status Is Coarse

Debrute CLI uses exactly three ordinary process statuses rather than encoding
failure taxonomy in exit codes: `0` for successful command completion, `1` for
execution failure, and `2` for an invalid command invocation or input.
Foreground waiting
succeeds only when the observed Operation succeeds; non-waiting submission
succeeds at Runtime acceptance; cancellation succeeds when the cancellation
request has won or the retained Operation is already cancelled. Runtime startup
or transport failure, execution-level submission rejection,
failed/cancelled observation, and rejected cancellation are execution failures;
caller-invalid submission remains status `2`.

If the process is actually terminated by an operating-system signal, the CLI
launcher preserves native signal termination; the signal never cancels an
accepted Operation. A successfully settled batch reports command success
regardless of failed item outcomes because those are result data under the
batch contract.

Successful `operation list` and `operation inspect` commands return `0` even
when a returned snapshot is failed or cancelled, because inspection itself
succeeded. `operation wait` returns `1` when the observed Operation is failed or
cancelled. Invalid commands, missing or invalid options, invalid JSONL, and
invalid Model Requests return `2`; Runtime launch, transport, model execution,
output commit, and internal failures return `1`.

Machine-readable command records, Operation states, and the closed command-code
set carry the actionable distinction between invalid input, invalid Project,
unavailable Model, Operation failure or cancellation, lost Runtime transport,
unknown submission outcome, and internal failure. Provider, Model, output
commit, and configuration causes remain redacted logs rather than public error
codes. The existing Debrute-specific `3`, `4`, and `5` failure taxonomy and the
batch failed-item override are removed from process status. This was chosen so
shell status answers only success, failure, or invalid invocation without
duplicating a lossy error taxonomy.
