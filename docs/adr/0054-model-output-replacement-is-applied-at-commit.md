# Model Output Replacement Is Applied At Commit

Optional `output` is the sole explicit Model Request naming policy. Its
`directory` member is a Project-relative directory and its `filename` member
is an extension-free file base name without path separators. Either member may
be omitted independently. Runtime supplies an Operation-unique directory when
`directory` is absent and a generated file base name when `filename` is absent;
`directory: "."` explicitly selects the Project root. Model Request input has
no combined output path or output-path array.

Runtime applies the existing portable Project-path rules rather than defining a
Model Operation validator. `directory` rejects absolute paths, traversal,
backslashes, invalid segments, and Project escape; `"."` maps explicitly to the
Project root, and missing valid directories are created. `filename` must be one
portable basename and cannot contain a path separator. Periods remain literal
basename characters, so `covers.v2` may produce `covers.v2.jpg`. Invalid input
is rejected without character replacement, path correction, or fallback
location. Commit rechecks the accepted stable Project identity and applies the
portable no-symlink path boundary before publication.

Runtime appends the extension that corresponds to each Artifact's actual MIME
type and performs no implicit transcoding. If the Model Run produces exactly
one Artifact, `directory: "generated"` and `filename: "covers"` produce
`generated/covers.jpg`. If it produces multiple Artifacts, Runtime inserts the
one-based Artifact position before each real extension, producing such paths
as `generated/covers_1.mp4` and `generated/covers_2.jpg`. `artifactIndex`
remains zero-based, so index `0` maps to suffix `_1`. Actual Artifact count, not
a requested estimate, decides whether suffixes appear.

Runtime imposes no generic per-ModelRun Artifact-count ceiling. Count follows
the selected Model's validated argument schema and its Adapter's actual output
mapping. The prelaunch implementation removes the existing global `16` check
without a replacement, truncation rule, or fallback selection; a concrete
Model may add a source-backed constraint if a real requirement appears.

Operation acceptance validates and resolves naming input but does not inspect
the current output files. Runtime creates no candidate-output enumeration,
exclusive output claim, reservation, acceptance-time hash, or filesystem
baseline. Independent Operations may select the same explicit name. A Batch
still rejects duplicate explicit `directory` plus `filename` declarations as
`invalid_input`, because allowing them would make concurrent completion order
choose the winning Item. Runtime-generated names remain unique without a
shared output-claim protocol.

The command-level `--replace` option is immutable execution policy and applies
uniformly to every explicit model output. Model Request and Batch Item records
cannot override it. Runtime uses the option only when each actual model output
file is committed, after Artifact count, MIME type, and extension are known.
Without `--replace`, commit uses create-only semantics and an occupied actual target
fails the Single or Batch Item. With `--replace`, commit atomically replaces the
file then present without comparing it with an earlier version. Model Item
commits for one Project share the Generated Asset commit lock, so two
independent replacing Operations resolve by actual commit order and cannot
interleave file rollback with another Item's provenance commit.

There is no silent skip, fallback rename, saved previous version, `--force`,
`--overwrite-existing`, compatibility alias, or pre-acceptance
`output_conflict`. A file created or changed after Operation acceptance is
treated exactly like any other file present at commit. This deliberately trades
early conflict detection and lost-update protection for ordinary local
create-or-replace semantics and a substantially smaller submission protocol.
