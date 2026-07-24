# Operation Control State Is Not Domain History

An Operation is instance-scoped coordination state, not a durable audit log.
Runtime keeps active Operations and at most 100 terminal records in the
current process only. Each terminal record includes the snapshot and retained
Batch Item Outcomes. An id absent from the current registry returns
`operation_not_found`; Runtime does not distinguish an unknown id, a retired
record, and an Operation from a replaced Runtime. Runtime does not persist a
generic Operation ledger, reconstruct Operations, or replay accepted work
after restart.

Durable outcomes belong to the domain that owns the fact. A successful Model
Operation commits Project files and Generated Asset provenance. If a feature
requires durable history or audit, that context defines its own redacted record
rather than extending the Operation registry. Cancellation and failure details
remain current-instance coordination results unless their owning domain
explicitly requires a durable fact. Callers that want to retain the Agent Record
observation stream use ordinary stdout redirection. This keeps transient
execution machinery out of Project truth, avoids a cross-domain task database,
and makes terminal retention a fixed record count rather than an arbitrary time
window.
