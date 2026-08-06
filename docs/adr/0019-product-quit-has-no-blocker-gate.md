# Product Quit Has No Blocker Gate

Product Quit is accepted and committed without a blocker inventory, frontend
round trip, confirmation dialog, deferred-exit state, or save/discard protocol.
Running terminals, transfers, Model Operations, and other Runtime-owned work are
terminated as part of shutdown. Runtime first stops accepting Workbench HTTP
connections and cancels every live Workbench stream so shutdown cannot wait on
a frontend connection.

Unsaved text values and Canvas Feedback values not yet reflected in accepted
Runtime state are not exit blockers because Workbench persists their complete
Working Copies to Runtime as they change, and a later Project binding restores
them. Runtime does not ask a connected Workbench to submit a checkpoint during
quit, and a Workbench is not required to exist.

This deliberately favors simple, deterministic product shutdown over trying to
make every asynchronous task finish perfectly. Product update has one separate
admission boundary: once a GUI Install action is accepted, replacement wins,
new mutating work is closed, and already admitted short work drains before the
reversible preparation phase begins.
