# Runtime Exposes Six Statuses

Runtime exposes `Starting`, `Ready`, `Exiting`, `Replacing`,
`RemovalPreparing`, and `Removing`. Control exists during `Starting`, but
business services accept work only in `Ready`. `Exiting` begins when Product
Quit wins. `Replacing` begins only after a Product update crosses its durable
commit boundary. `RemovalPreparing` begins after Runtime validates and launches
the one detached whole-Product removal transaction; it closes new work while
the initiating acceptance response is delivered and admitted work drains.
`Removing` begins after those cuts and permits Runtime to close its surfaces so
the detached execution can delete Product state. The four post-Ready terminal
or transition statuses reject new activation and business work while resources
close.

Update checking occurs while fully `Ready`. Acceptance of a GUI Install action
atomically enters an internal update-admission state, which wins over Product
Quit and Product removal, closes new mutating Workbench and CLI work and new
Photoshop transfers, drains already admitted mutations and transfers, then
downloads, validates, and stages the complete payload. This internal state
retains public status `Ready` so existing observations can drain. A reversible
preparation failure restores full Ready admission; users cannot cancel the
transition. Once replacement commits, Runtime exposes `Replacing`.

One internal lifecycle state owns startup, update preparation, exit,
replacement, removal preparation, and removal. The six public statuses and the
supervision loop observe that same state. Startup completion cannot overwrite
an already accepted exit or removal. There is no blocker-collection round trip,
degraded serving state, or deferred quit. Operating-system termination ends the
process directly.
