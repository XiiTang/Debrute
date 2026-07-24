# Runtime Lifetime Is Independent Of Frontends

Debrute has one user-session Runtime whose lifetime is independent of Desktop
windows, browser pages, CLI invocations, and Photoshop connections. Any trusted
entry point may ensure that Runtime is running, but none becomes its owner;
closing a frontend therefore never stops Runtime, and Runtime exits only for an
explicit product quit, a coordinated product update, or operating-system session
termination. This was chosen over first-launcher ownership and implicit idle
shutdown so startup order cannot change product exit semantics and background
operations do not acquire hidden frontend or timer dependencies. This decision
refines the client boundary established by
[ADR 0002](./0002-local-runtime-owns-privileged-state.md).
