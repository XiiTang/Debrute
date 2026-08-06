# Asynchronous Work Has Three Lifetime Classes

Runtime classifies asynchronous work by ownership rather than elapsed time.

A bounded `RequestTask` read, mutation, or save completes within its caller and
holds only a request Project Use when it needs Project state.

Every accepted Single or Batch Model Request becomes a Runtime-owned
`ModelOperation` with identity, observable state, and cancellation. Its
requests already contain canonical absolute output directories and any admitted
local input paths, all resolved from the submitting CLI's captured working
directory. A Model Operation has no Project identity, opens no Project Session,
holds no Project Use, and survives its initiating CLI connection. It commits
ordinary files and then attempts Runtime-global provenance.

Rebuildable Canvas preview, derived-feedback, indexing, and cache work is a
`MaintenanceJob`. These work kinds have no public Operation identity or
terminal history and may be cancelled, coalesced, or superseded when their
owner closes or target changes.

Terminals remain separate stateful resources whose running instances hold
`running-terminal` Project Uses. Product Quit terminates Operations and
terminals directly and joins owned workers. Source code classifies each known
work type; duration never promotes work into another class. A future non-model
Operation requires an explicit lifecycle decision.
