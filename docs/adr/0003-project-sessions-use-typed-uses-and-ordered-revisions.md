---
status: accepted
---

# Project Sessions Use Typed Uses And Ordered Revisions

Runtime owns one loaded Project Session for each canonical absolute root. The
root is the Project identity defined by
[ADR-0067](./0067-project-identity-is-the-canonical-root.md). A Workbench
receives a temporary `bindingId` only as Project-scoped command authority; the
binding is never stored or used as durable identity.

## Session lifetime

A session remains open while at least one typed Project Use exists. The closed
use vocabulary is Workbench, request, running terminal, and transfer. Uses
express ownership of live Project resources; they are not client sessions,
transport credentials, idle timers, or a public reference count.

Releasing the last use closes the session immediately. Runtime marks the root
as closing before watcher and Project-state cleanup begins. A cleanup failure
remains the result for that root and for final Registry shutdown; the root
cannot reopen in the same Runtime. An unexpected cleanup panic terminates the
Runtime. Sessions have no retention timer, reconnect reservation, grace worker,
or arbitrary count limit.

Terminals retain their own running-terminal use. Closing or preempting a
Workbench therefore does not end a terminal process. Its Workbench Terminal
WebSocket ends with the binding; explicit terminal closure or Runtime shutdown
ends the PTY.

## Ordered Project state

The session serializes Project mutations and increments `projectRevision` only
when authoritative state changes. The Project stream carries complete current
snapshots or typed events at that revision. HTTP returns the command outcome;
the ordered stream is the only input that advances Workbench Project state. A
missing response never authorizes replay of a state-changing request.

`project.bound` establishes the complete snapshot and revision baseline for a
new Workbench binding generation. Within that generation, the next accepted
Project event must have exactly the current binding ID and revision `R + 1`.
A repeated, older, skipped, or differently bound event fails the projection,
removes Project command authority, and requires an explicit page refresh. The
client does not ignore the event, fetch a gap, reconnect, or infer state.

`WorkbenchProjectProjection` owns the current binding generation, canonical
root, revision, complete snapshot, and Working Copies. It replaces the snapshot
as a whole after each accepted snapshot-affecting event. The Workbench derives
Canvas Scene geometry from that snapshot and holds transient presentation state
in the owning Canvas or UI module; the Project projection has no Canvas merge,
optimistic overlay, or parallel authoritative/presented snapshot.

A Project mutation exposed to Workbench completes only after its HTTP outcome
arrives and the stream has accepted that outcome's `projectRevision` or a later
contiguous revision. This wait lets subsequent selection, activation, and
centering read the accepted snapshot without treating the HTTP body as state.
If the binding ends first, the caller fails without replaying the mutation.

Project-wide `baseRevision` compare-and-swap locks are not part of this
protocol. A domain may still use a file-specific revision, such as for a text
save, without serializing unrelated Project mutations together.

## Binding replacement

Every Workbench has at most one current Project binding, and every Project has
at most one Workbench owner. Runtime fully prepares a requested target before
changing either owner. Preparation opens the target Workbench use, establishes
the snapshot-first subscription barrier, builds the public snapshot, loads
Working Copies, and prepares the first `project.bound` frame. Failure leaves
both bindings unchanged. Selecting the already bound canonical root is a no-op.

Once a concrete target enters replacement, Workbench closes new Project command
admission for the presented binding. Already admitted commands retain their
captured binding ID and generation, and Runtime waits for their request leases
before committing replacement. A failed preparation restores admission to the
unchanged binding. Browser transport abort does not cancel or roll back a
command already accepted by Runtime.

The commit atomically changes the connection binding, unique Workbench owner,
and Workbench Project Use, then advances the connection-local generation. If
streaming fails after commit, Runtime closes that Workbench connection and
releases its current use; it does not roll back to the source Project.

When routing requires ownership transfer, Runtime sends `project.preempted`,
clears the displaced binding and Workbench use, and retargets a displaced
Desktop window to the root route. It does not close the native window or
transfer renderer state. Native and browser routing rules are defined by
[ADR-0033](./0033-workbench-session-lifetime-follows-its-container.md).

React keys Project-scoped presentation by binding generation. Accepting a new
`project.bound` disposes the previous Project subtree and mounts a fresh one.
Connection state, product settings, global notifications, and the unbound open
surface remain outside that subtree. Detach removes command authority and keeps
the last confirmed snapshot frozen; it does not create a new generation.

## Working Copies

Runtime Working Copies protect unsaved text values and Canvas Feedback values
independently of a Workbench connection. They are private, persistent, keyed by
canonical root, and restored in `project.bound`. Feedback Working Copies are
also keyed by Feedback item identity. A matching save, accepted Feedback
mutation, explicit discard, or Feedback deletion clears only that value.
Working Copies have no TTL or count limit. Reconstructible view state, terminal
state, and arbitrary component memory are not Working Copies.
