# Project Sessions Use Typed Uses And Ordered Revisions

Runtime owns one loaded Project session for each canonical root and stable
Project id. The public id is exactly `.debrute/project.json.project.id`; Runtime
rejects invalid ids and rejects a second canonical root that declares an
already-live id. It does not derive aliases from paths, generate replacement
ids, or preserve an old identity format.

A session remains open only while at least one typed Project Use exists. The
closed use vocabulary is Workbench, request, running terminal, transfer, and
Photoshop link. Uses express actual ownership of live Project
resources; they are not client sessions, transport credentials, idle timers, or
generic reference counts exposed on the wire. Releasing the last use closes the
live session immediately and installs a closing transition for its canonical
root before watcher and Project-state cleanup begins. Ending a Project Use is
an ownership event, not a fallible cleanup command and not a claim that final
session cleanup succeeded. Cleanup success removes the transition. Cleanup
failure remains the authoritative result for that root: another open and final
Registry shutdown return the exact failure, and the root cannot reopen in the
current Runtime. An unexpected panic terminates Runtime instead of leaving the
process available to serve further requests.
There is no 30-second retention, reconnect reservation, grace worker, or
arbitrary open-Project cap.

Each Project mutation is serialized by the session, semantically validated,
and assigned a monotonic `projectRevision` only when authoritative state
changes. The ordered Project stream carries complete current projections or
typed events with that revision. HTTP commands return their closed outcome;
the stream, not a duplicated mutation response, advances renderer state. A
missing response is never permission to replay a state-changing request.
An exact mutation or refresh failure is returned to its caller but does not
install a second session-poison or later-command rejection state. Runtime does
not replay the failed effect; a later explicit refresh or new observed
filesystem change operates on the current filesystem state.

Project-wide optimistic `baseRevision` locks are not part of this protocol.
File-specific revisions may still be inputs where the domain needs them—for
example, a text save or a Working Copy's source revision—but they do not turn
unrelated Project mutations into compare-and-swap operations.

Every loaded Workbench has at most one current Project binding, and every
Project has at most one Workbench owner. Opening is valid only from an unbound
connection; replacing is valid only from a bound connection. Runtime validates
and prepares the target before it atomically switches the binding. Preparation
does not modify the source binding or preempt the target's current owner. It
opens the target Workbench Project Use, creates the target subscription, uses
the subscription's snapshot-first barrier to build the public Project
projection, loads Working Copies, and secures delivery of the first
`project.bound` frame. Any preparation failure leaves both Workbench owners
unchanged. Selecting the already bound target is a no-op.

The commit changes the connection's Project binding, the unique owner, and the
owning Workbench Project Use as one Runtime transaction. It advances a
connection-local binding generation so a Project-scoped mutation authorized by
the old binding cannot commit after replacement. Preemption and derived Desktop
routing follow that committed state. If Project streaming fails after commit,
Runtime closes the exact Workbench connection and releases its current Project
Use; it does not roll back to the source Project because the target binding may
already be visible to the client.

For example, suppose A is current, another Workbench owns B, and B's public
projection cannot be serialized. Changing A's binding or preempting B before
serialization would expose a half-completed replacement. The required ordering
returns the preparation error while A and B retain their original owners. If
serialization and first-frame delivery succeed, the later owner change is the
single commit.

When another Desktop window already owns the target, an ordinary Desktop open
focuses that window. When Web owns the target, an ordinary Desktop open remains
unbound on the root surface until the user chooses **Open Here**. A Web
Workbench, or Desktop's explicit **Open Here** command, preempts the previous
Workbench. Runtime sends `project.preempted`, clears the old binding and Project
Use, and retargets a preempted Desktop window to the root route. It does not
close the native window or transfer frontend state.

Runtime Working Copies protect unsaved text values and the current feedback
draft independently of a Workbench connection. They are private, persistent,
keyed by stable Project id, and restored in `project.bound`. A successful
matching save or explicit discard clears the relevant value. They have no TTL
or count cap. Reconstructible view state, live terminal state, and arbitrary
component memory are not Working Copies.

Terminals hold their own `running-terminal` Project Use, so closing or
preempting a Workbench does not imply that a long-lived terminal has ended.
The Workbench's Terminal WebSocket does end with its Project binding; Runtime
shutdown or explicit terminal closure remains the PTY lifetime boundary.
