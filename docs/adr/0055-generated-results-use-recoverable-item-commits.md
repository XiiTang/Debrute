# Generated Results Use Recoverable Item Commits

A single Model Run commits all of its generated files and Generated Asset
provenance as one recoverable logical transaction. For batch execution, that
transaction boundary is one `BatchItem`; committed items are never rolled back
because another item fails. Provider results are first staged under a protected
same-filesystem `.debrute/transactions/generation/<commit-id>/` directory, where
Runtime computes fingerprints and prepares redacted Model Run records before
entering the Project mutation queue and revalidating every output baseline.

Before the first visible Project mutation, Runtime durably writes commit intent.
That point is the Operation kind's irreversible commit boundary: cancellation
before it removes staging without visible output, while work after it must
finish the commit. Replacement keeps the prior target as a transaction backup
until all output files, Generated Asset records, and index changes are durable.
The stable outcome therefore contains both files and provenance or neither; a
metadata failure cannot leave an untracked generated file.

Project opening recovers generation transactions before publishing the Project
session. Staging without commit intent is discarded; durable commit intent is
rolled forward. Recovery restores only Project files and provenance and never
recreates an instance-scoped Operation or invokes a Debrute Model again. This
was chosen over the current file-then-metadata sequence and in-memory rollback,
which can expose partial output after an error or process crash.
