# Runtime Owns One Global Activity Stream

Debrute presents finite background work and reviewed terminal notices through
one Runtime-owned Activity stream. The stream is independent of Global and
Project projections, has its own monotonic revision, and publishes one complete
snapshot followed by ordered upsert or remove events to every Workbench
connection. Its in-memory ledger lives for exactly one Runtime instance. It is
not partitioned by Workbench, reset by Project binding, persisted across Runtime
replacement, or bounded by a record-capacity policy.

An Activity record is either a terminal notice or a task updated in place.
Activity is a presentation and observation layer rather than a second work
authority: Model Operations, Photoshop transfers, and Integration operations
retain their existing ownership, cancellation, diagnostics, and result
contracts. Activity projects only their reviewed status, true determinate
progress where available, and closed structured message arguments. It cannot
accept arbitrary frontend prose, raw errors, logs, commands, stdout, or stderr.
The user-facing source label **Model Request** is presentation wording and does
not rename a Model Operation or its Batch Items.

All currently connected Workbenches may float a newly created record and a task
terminal transition, while a later Workbench receives existing records only as
Activity Center history. Floating presentation is local, limited to three cards,
and expires after one fixed eight-second interval; progress events do not renew
it. Activity Center open state is also local. Record removal is global: a card
close removes one terminal record and **Clear All** removes all terminal records,
but neither action cancels work or removes files, logs, Model Operation records,
Project state, or feature-owned results. Active tasks cannot be removed.

The first version has no severity, read/unread state, indicator count, dedupe,
capacity eviction, operating-system notification, or persistent history. A
highest-layer blocking surface suppresses new floating presentation without
changing the ledger or replaying suppressed cards later.

This replaces a Workbench-local Notification controller because local ownership
made the initiating window special, lost history when a page changed, could not
represent CLI-originated work, and could diverge across Workbenches. A separate
Task Center plus terminal Notification Center was also rejected: it would split
one record at its lifecycle boundary and require completion duplication. One
Activity stream keeps task progress and terminal outcome continuous while the
owning operation subsystems remain authoritative.
