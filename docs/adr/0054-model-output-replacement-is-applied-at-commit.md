# Model Output Naming And Replacement Are Applied At Commit

Every Model Request requires one output object:

```json
{"directory":"generated","name":"covers"}
```

`directory` is an absolute filesystem path or is resolved against the CLI's
captured canonical working directory. Runtime canonicalizes the nearest
existing ancestor at Operation admission and retains the resulting absolute
destination. Missing suffix directories are created during commit. A regular
file, symbolic link, inaccessible path, or unsafe component fails the affected
work; Runtime never repairs the path or chooses a fallback location.

`name` is one ordinary non-empty basename. It may contain periods, so
`covers.v2` can produce `covers.v2.jpg`, but it cannot be `.`, `..`, or contain
a slash, backslash, or NUL. Runtime never generates a missing name and does not
accept a combined output path or output-role map.

Runtime derives each extension from the actual Artifact MIME type. Naming
counts Artifacts with the same extension independently:

- one output of an extension is `covers.ext`;
- multiple outputs of that extension are `covers_1.ext`, `covers_2.ext`, and so
  on.

Two MP4 and two JPEG outputs therefore become `covers_1.mp4`, `covers_2.mp4`,
`covers_1.jpg`, and `covers_2.jpg`. This is a naming rule discovered from the
actual outputs, not an input classification or Artifact role. `artifactIndex`
continues to expose zero-based provider response order independently of each
extension's suffix counter.

Runtime imposes no generic per-request Artifact-count ceiling and does no
implicit transcoding. Model-specific result mapping determines the actual
outputs.

Operation acceptance does not inspect candidate output files, reserve names,
or reject duplicate paths within a Batch. The caller owns the submitted JSONL.
Without `--replace`, publication is create-only and an occupied actual target
fails that Single or Batch Item. With `--replace`, Runtime atomically replaces
the file present at commit without comparing an earlier version. It never
silently skips, renames, saves a previous version, or exposes another overwrite
alias.
