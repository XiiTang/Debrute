# Product Quit Has No Blocker Gate

Product Quit is accepted and committed without a blocker inventory, frontend
round trip, confirmation dialog, deferred-exit state, or save/discard protocol.
Running terminals, transfers, generation, and other Runtime-owned work are
terminated as part of shutdown. Runtime first stops accepting Workbench HTTP
connections and cancels every live Workbench stream so shutdown cannot wait on
a frontend connection.

Unsaved text values and the active feedback draft are not exit blockers because
Workbench persists their complete Working Copies to Runtime as they change. A
later Project binding restores them. Runtime does not ask a connected Workbench
to submit a checkpoint during quit, and a Workbench is not required to exist.

This deliberately favors simple, deterministic product shutdown over trying to
make every asynchronous task finish perfectly. Product update has one separate
durable commit boundary: Product Quit wins before it, replacement wins after it.
