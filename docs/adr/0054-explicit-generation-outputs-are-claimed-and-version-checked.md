# Explicit Generation Outputs Are Claimed And Version Checked

An explicit generation output uses create-only semantics by default. A single
generation request whose target already exists is rejected before Operation
acceptance; an image-batch item with that condition settles
as failed without invoking its model, while other items continue. The existing
batch behavior that silently skips a non-empty target is removed. Runtime-owned
Operation-unique output directories remain the default when no explicit path
is supplied.

One explicit replacement opt-in supersedes the existing overwrite behavior. At
acceptance, Runtime canonicalizes every explicit target and records whether it
is absent or the full-file SHA-256 of its current
content. Commit succeeds only if that state is unchanged; creation, deletion,
or modification by an external tool produces a typed conflict, with no blind
overwrite or fallback rename. The output policy is part of canonical caller
input; the accepted filesystem baseline is immutable Runtime-owned Operation
state.

Runtime also holds an instance-local exclusive claim for every explicit target
while its Operation or BatchItem may still commit. A conflicting Operation is
rejected before paid generation, and duplicate targets
inside one batch are an input error. This was chosen over last-writer-wins and
existence-based batch resumption so concurrent Agents and external editors
cannot silently destroy Project content or mistake an unrelated file for a
completed generation.
Exact option and error names belong to the implemented CLI and protocol
contracts.
