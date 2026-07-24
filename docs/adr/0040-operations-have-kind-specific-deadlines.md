# Operations Have Kind-Specific Deadlines

Runtime applies no generic wall-clock timeout, idle timeout, or queue timeout to
an Operation. Waiting for lane permits does not make queued work fail, and a
running Operation is not reclaimed merely because its total elapsed duration is
large. Terminal-summary retention remains a separate memory-budget decision.

Each closed Operation kind instead defines deadlines for the external waits it
actually owns: connection establishment, response inactivity, one provider
attempt, provider-job polling, transfer, subprocess exit, or cleanup. A caller
may supply a lower deadline only where that kind's input explicitly permits it;
the accepted deadline follows the Runtime-owned Operation after the initiating
connection disappears. Deadlines use a monotonic clock and expire as a typed,
redacted `phase_deadline_exceeded` failure followed by kind-owned cleanup, not
as user cancellation or an automatic retry. This was chosen so genuine hung
resources are bounded without inventing one elapsed-time rule for unrelated
work.
