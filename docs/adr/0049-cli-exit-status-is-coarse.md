# CLI Exit Status Is Coarse

Debrute CLI uses a coarse process-status model rather than encoding failure
taxonomy in exit codes. It distinguishes successful command completion, failed
execution, and locally detected invocation/usage failure. Foreground waiting
succeeds only when the observed Operation succeeds; non-waiting submission
succeeds at Runtime acceptance; cancellation succeeds when the cancellation
request has won or the retained Operation is already cancelled. Runtime startup
or transport failure, Operation rejection, failed/cancelled observation, and
rejected cancellation are execution failures.

If the process is actually terminated by an operating-system signal, the CLI
launcher preserves native signal termination; the signal never cancels an
accepted Operation. A successfully settled batch reports command success
regardless of failed item outcomes because those are result data under the
batch contract.

Machine-readable command records, Operation states, and typed error codes carry
the actionable distinction between capacity pressure, provider failure,
configuration failure, stale Runtime state, and internal error. The existing
Debrute-specific failure taxonomy and batch failed-item override are removed
from process status. This was chosen so shell status answers only success,
failure, or invalid invocation without duplicating a lossy error taxonomy.
Exact numeric mappings belong to the implemented CLI contract.
