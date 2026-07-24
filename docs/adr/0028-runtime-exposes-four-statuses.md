# Runtime Exposes Four Statuses

Runtime exposes `Starting`, `Ready`, `Exiting`, and `Replacing`. Control exists
during `Starting`, but business services accept work only in `Ready`.
`Exiting` begins when Product Quit wins. `Replacing` begins only after a product
update crosses its durable commit boundary. Both terminal statuses reject new
activation and business work while resources close.

Update checking, download, validation, and staging occur while `Ready`; they are
not public lifecycle statuses. Product Quit wins while update preparation is
still reversible. Once replacement commits, update wins and Product Quit is not
started in parallel. There is no public Preparing status, blocker-collection
phase, cancellation back to Ready after a quit request, degraded serving state,
or deferred quit.

One internal lifecycle state owns startup, update preparation, exit, and
replacement; the four public statuses and the supervision loop observe that
same state. Startup completion cannot overwrite an already accepted exit.
Operating-system termination ends the process directly.
