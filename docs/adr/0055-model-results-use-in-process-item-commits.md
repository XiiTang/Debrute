# Model Results Use In-Process Item Commits

One Model Request execution stages and commits all outputs for its Operation or
Batch Item. Already committed Batch Items are never rolled back because another
Item fails.

Runtime resolves concrete filenames after actual MIME types are known. Naming
counts matching extensions independently. Batch records receive no duplicate-
path preflight; each Item reaches the same ordinary create-or-replace commit
boundary. Output publication is create-only by default and atomically replaces
the file present at commit when `--replace` is set. An ordinary commit error
restores files changed by that Item.

After file publication, Runtime writes one global Model Artifact provenance
record for each output. Provenance failures are combined into one Operation
warning and do not roll back files or change the successful Item outcome.
Failure to remove transient staging or replacement-restore files after all
outputs publish is likewise one bounded Operation warning; published outputs
remain successful and Runtime does not hide the cleanup failure.

This is an in-process consistency boundary, not a durable cross-volume
transaction. Runtime writes no commit journal and performs no recovery when a
Project later opens. A Runtime or operating-system exit may leave a partial file
commit or missing provenance.
