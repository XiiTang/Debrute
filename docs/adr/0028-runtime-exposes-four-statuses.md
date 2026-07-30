# Runtime Exposes Four Statuses

Runtime exposes `Starting`, `Ready`, `Exiting`, and `Replacing`. Control exists
during `Starting`, but business services accept work only in `Ready`.
`Exiting` begins when Product Quit wins. `Replacing` begins only after a Product
update crosses its durable commit boundary. Both terminal statuses reject new
activation and business work while resources close. The internal update-admission
state also rejects new mutating work while retaining public Runtime status
`Ready` so existing observation connections can drain.

Update checking occurs while fully `Ready`. Acceptance of a GUI Install action
atomically enters the internal update-admission state, which wins over Product
Quit, closes new mutating Workbench and CLI work and new Photoshop transfers,
drains already admitted mutations and transfers, then downloads, validates, and
stages the complete payload. A reversible preparation failure restores full
Ready admission; users cannot cancel the transition.
Once replacement commits, Runtime exposes `Replacing`. There is no fifth public
Runtime status, blocker-collection round trip, degraded serving state, or
deferred quit.

One internal lifecycle state owns startup, update preparation, exit, and
replacement; the four public statuses and the supervision loop observe that
same state. Startup completion cannot overwrite an already accepted exit.
Operating-system termination ends the process directly.
