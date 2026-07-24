# Generated Results Use In-Process Item Commits

A single Model Run commits all of its generated files and Generated Asset
provenance as one logical Item commit. For batch execution, that boundary is
one `BatchItem`; an already committed Item is never rolled back because another
Item fails.

Runtime prepares every redacted provenance record from the exact returned
artifact bytes and stages the large output bytes through the Project filesystem
capability captured at Operation acceptance. Only then does it take the
Generated Asset service's per-Project lock, read the current index, stage the
small provenance and index documents, and start one short non-interruptible
publication boundary. Without `--replace`, each output publication is
create-only; with it, each output atomically replaces the file present at that
moment. Provenance record files remain create-only and the index is replaced.
Ordinary-error rollback covers the same complete file set. There is no
acceptance-time output claim, version baseline, or output-version revalidation.
Ambient Project path replacement cannot redirect the commit into another
Project.

Within one Batch, Runtime claims the concrete Artifact paths after model output
count and MIME extensions are known but before publication. If two Items derive
the same concrete path, the later claimant fails instead of replacing another
Item's output, including when `--replace` is enabled.
It does not open a Project session or enter the Project mutation queue. An
ordinary error during this live Runtime commit restores outputs changed by the
Item and fails the Item; no other committed Item is affected.

This is an in-process consistency boundary, not a durable transaction protocol.
Runtime does not write model-commit intent, keep a recoverable Model Request
transaction journal, or inspect model-output staging when a Project opens. A
Runtime or operating-system exit during the short commit may therefore leave
partial output or mismatched provenance. Debrute does not repair that extreme
case automatically; the user can remove or regenerate the affected output.
Opening the Project later neither recreates an instance-scoped Operation nor
invokes a Debrute Model again.
