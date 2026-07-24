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
The accepted `project.bound` frame establishes the complete Project projection
and revision baseline for a new Workbench binding generation. Every later
authoritative renderer transition for that binding comes only from its ordered
Project stream. An HTTP mutation result must not replace or merge a Project
snapshot or Canvas Projection, and HTTP success does not confirm a local
presentation overlay. A local overlay settles only when an accepted Runtime
projection contains its exact state, when its command fails, or when a new
Project binding replaces its scope.

Workbench concentrates that acceptance policy in one in-process Project
projection module. The module owns the current Project identity, binding
generation, accepted revision, complete-snapshot replacement, Canvas-local
projection merge for every Canvas Node kind, and composition of authoritative
state with any local value that actually changes the presented Project
snapshot. Pending Text Viewport is the only such local overlay in the current
design. Manual Layout Drafts, Playback Position interaction, media-resource
state, Feedback Working Copies, camera, and selection retain their existing
Canvas- or interaction-local owners; Workbench does not add a generic overlay
registry for hypothetical future values. This is a replacement seam rather
than an additional state layer: Workbench callers do not retain independent
revision gates, authoritative snapshot stores, or mutation-response commit
paths. Explorer selection, active Canvas, camera and panel state, routes,
notifications, and Working Copy editing lifecycles remain owned by their
existing modules.

The Runtime connection and Project projection module outlive any one Project
binding. React places Project-scoped presentation beneath a subtree keyed by
the accepted binding generation. After the projection module atomically
accepts a new `project.bound` baseline, React disposes the previous subtree and
mounts a new one from that accepted binding. A rebind to the same Project id
still has a new generation and therefore a new subtree. Active Canvas,
Explorer, selection, camera, Project-local panel and route state, and Working
Copy editors begin from the new binding rather than resetting an instance that
belonged to the previous binding. Working Copies and any view state with an
existing explicit persistence contract may initialize the new subtree;
arbitrary component memory is not migrated.

Connection state, the projection module, product settings, global
notifications, and the unbound/open surface remain outside that keyed subtree.
Workbench does not reload the whole renderer, keep the previous Project
subtree alive in the background, define a generic Project-reset interface, or
maintain an imperative reset list. A detach does not advance the generation or
replace the subtree: it removes command authority and preserves that binding's
last presentation read-only. Project-scoped asynchronous work carries its
binding generation, so completion from a disposed generation cannot publish
into the current one.

Within one binding generation, the accepted Project stream is contiguous.
After revision `R`, only revision `R + 1` is valid. A repeated, older, or
skipped revision is a connection protocol failure: Workbench preserves the
last presentation for explanation, removes Project command authority, and
requires an explicit page refresh to create a new connection and obtain a new
complete snapshot. It does not ignore the inconsistency, fetch missing events,
request a replacement snapshot, reconnect, or infer the skipped state. Every
Project-scoped event participates in this ordering even when it does not alter
the Project projection itself.

A Project mutation invocation exposed to a Workbench caller completes only
after both its closed HTTP outcome has arrived and the Project stream has
accepted that outcome's `projectRevision` or a later contiguous revision. This
coordination does not make the HTTP result a renderer-state input. It ensures
that selection, activation, and centering performed after the invocation can
read the corresponding accepted Project projection without each caller
implementing its own revision wait. If the connection ends before both facts
arrive, Workbench ends the surface instead of replaying the command or treating
an unobserved mutation as safe to retry.

The renderer seam sits after the HTTP adapter has decoded a Project frame and
before React presentation. The adapter synchronously delivers each
`project.bound`, Project event, or detach frame to the Project projection
module in wire order. Only after acceptance succeeds may it publish the event
to other Workbench modules or complete a command waiting on that revision.
The adapter does not merge Project state, the projection module does not own
network transport, and React subscribes to accepted state without participating
in acceptance ordering.
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

When a bound Workbench starts replacement, it synchronously closes Project Path
Command admission for the presented binding before asking Runtime to open the
target. Commands already submitted retain their captured Project id and binding
generation; commands not yet submitted do not cross that boundary. The current
native confirmation is synchronous, so Project switching cannot begin while it
is open; if switching begins first, the closed gate prevents opening a new
confirmation. Any future non-blocking confirmation must belong to and disappear
with its Project generation. Runtime replacement waits for active Project
request leases to drain before committing the new binding. A cancelled or failed
open restores command admission to the unchanged binding. A successful open
mounts the new generation with fresh command authority. Neither Web transport
abort nor Project switching claims to cancel or roll back an accepted Runtime
command.

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

Runtime Working Copies protect unsaved text values and the latest Canvas
Feedback values not yet reflected in accepted Runtime state independently of a
Workbench connection. They are private, persistent, keyed by stable Project id,
and restored in `project.bound`. Feedback Working Copies are additionally keyed
by stable Feedback Capsule identity, so editing one comment never replaces
another comment's unsynchronized value. A successful matching save, accepted
feedback mutation, explicit discard, or feedback deletion clears only the
corresponding value. They have no TTL or count cap. Reconstructible view state,
live terminal state, and arbitrary component memory are not Working Copies.

Terminals hold their own `running-terminal` Project Use, so closing or
preempting a Workbench does not imply that a long-lived terminal has ended.
The Workbench's Terminal WebSocket does end with its Project binding; Runtime
shutdown or explicit terminal closure remains the PTY lifetime boundary.
