# Operation Control State Is Not Domain History

An Operation is instance-scoped coordination state, not a durable audit log.
Runtime keeps active Operations and memory-budgeted terminal summaries in the
current process only. After a summary is retired, its id returns
`operation_retired`; after Runtime replacement, its id returns
`stale_runtime_instance`. Runtime does not persist a generic Operation ledger,
reconstruct Operations, or replay accepted work after restart.

Durable outcomes belong to the domain that owns the fact. A successful Project
Operation commits Project state or an artifact reference, a product update
commits product-version state, and an integration change is reflected by the
integration's detected state. If a feature requires durable history or audit,
that context defines its own redacted record rather than extending the generic
Operation registry. Cancellation and failure details remain current-instance
coordination results unless their owning domain explicitly requires a durable
fact. This keeps transient execution machinery out of Project and Product
truth, avoids a cross-domain task database, and makes record retention a memory
budget rather than an arbitrary time window.
