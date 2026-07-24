# Asynchronous Work Has Three Lifetime Classes

Runtime classifies asynchronous work by ownership rather than elapsed time.
Bounded `RequestTask` reads, mutations, and saves complete within their caller
and hold only a request Project Use when they need Project state.

User-visible long work such as generation, integration changes, visible
transfers, and update download or staging becomes a Runtime-owned `Operation`
with identity, progress, cancellation, Product or Project scope, and any
required Project Use. It survives its initiating frontend or CLI.

Rebuildable preview, derived-feedback, indexing, and cache work is a
`MaintenanceJob`. It is not shown as an Operation and is canceled when its
owner closes or Runtime transitions. Terminals remain separate stateful
resources whose running instances hold `running-terminal` Project Uses.
Product Quit terminates Operations and terminals directly.

A closed source-defined kind registry chooses the class; work is never promoted
because it crossed an elapsed-time threshold. Product update is an Operation
only through download and staging, after which the Runtime replacement state
owns it.
