# Asynchronous Work Has Three Lifetime Classes

Runtime classifies asynchronous work by ownership rather than elapsed time.
Bounded `RequestTask` reads, mutations, and saves complete within their caller
and hold only a request Project Use when they need Project state.

The initial Operation subsystem covers only Model Requests. Every accepted
Single or Batch becomes a Runtime-owned `ModelOperation` with identity,
observable state, cancellation, a canonical Project root, and a stable Project
id. The Project reference is immutable result scope: Runtime uses a filesystem
capability rooted at that Project to commit Project-relative outputs and
Generated Asset metadata. It is not a live Project ownership object. The
Operation survives its initiating CLI connection without opening a Project
session, holding a Project Use, requiring a Workbench, or keeping the Project
open. Integration changes, Product Update, and professional-tool transfers
retain their existing domain-specific lifetimes unless a later explicit
decision adopts the Operation contract.

Rebuildable Canvas preview, derived-feedback, indexing, and cache work is a
`MaintenanceJob`. These work kinds are excluded from the Operation registry:
they have no public identity or terminal history and may be cancelled,
coalesced, or superseded when their owner closes, their target changes, or
Runtime transitions. Terminals remain separate stateful resources whose
running instances hold `running-terminal` Project Uses. Product Quit terminates
Operations and terminals directly, without asking a Workbench to flush or
confirm. Runtime cancels and joins the worker threads it owns before its
process exits, whether service supervision ended through Product Quit or an
internal Runtime error. Terminal destruction sends one shutdown request; if
that request cannot complete, the owner force-kills the exact process tree and
still joins the actor. It never retries the actor command or detaches the owned
thread.

Source code classifies each known work type; work is never promoted because it
crossed an elapsed-time threshold. A future non-model Operation requires
an explicit protocol and lifecycle decision rather than inheriting Operation
behavior merely because it runs for a long time.
