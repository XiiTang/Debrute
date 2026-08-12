# Model Artifacts And Provenance

A Model Artifact is an ordinary file produced by a Model Request in its
accepted `output.directory`. Model Requests do not open or bind a Project. If
the directory is inside an open Project, the shared Project Tree discovers the
file through its normal filesystem path.

## Naming And Result Order

Provider response order is the only result order. Naming counts outputs with
the same MIME-derived extension independently. For requested base name `name`:

- one output of an extension is `name.ext`;
- multiple outputs of that extension are `name_1.ext`, `name_2.ext`, and so on.

Thus two MP4 and two JPEG outputs are `name_1.mp4`, `name_2.mp4`,
`name_1.jpg`, and `name_2.jpg`. Runtime discovers those groups from actual MIME
types at commit; the request does not classify or label output roles.

`artifactIndex` is the zero-based response index. An Artifact Pointer contains
that index, the canonical absolute output path, actual MIME type, and optional
image dimensions. The accepted Model Operation's `operationId` is the only
execution identity.

A relative `output.directory` is resolved against the CLI's captured canonical
working directory. Runtime canonicalizes its existing ancestor at admission
and retains the resulting absolute directory for execution, results, and
provenance. Missing suffix directories are created at commit. The accepted path
never follows a directory later renamed or moved by Workbench, an Agent, or
another process. Existing symbolic links are resolved during admission; if a
previously missing component later becomes a file, symbolic link, inaccessible
path, or unsafe component, the affected work fails. Thus renaming `output` to `output-new` while
an Operation runs leaves `output-new` untouched and causes the Operation to
publish beneath a newly created `output` directory.

## Global Provenance

Provenance is private Runtime-global state:

```text
~/.debrute/model-artifacts/<full-file-sha256>.json
```

Each content hash has at most one compact record:

```json
{
  "operationId": "...",
  "itemIndex": 0,
  "artifactIndex": 0,
  "outputPath": "/absolute/output/name.png",
  "createdAt": "...",
  "mimeType": "image/png",
  "request": {},
  "response": {
    "trace": [],
    "output": {}
  }
}
```

The request, trace, and output are redacted before persistence. A later record
for identical bytes replaces the previous record for that hash. Provenance does
not contain Project identity, provider identity, file bytes, a separate record
ID, or an output-role vocabulary.

Lookup hashes the current file with a streaming SHA-256 calculation. Missing
metadata returns the hash with `record: null`; unreadable or malformed metadata
is an ordinary lookup error. Renaming or moving unchanged bytes preserves the
match, while editing, re-encoding, or replacing the bytes changes the hash.
Record JSON is limited to 35 MiB and its trace to 2 MiB. File hashing has no
Debrute byte or elapsed-time limit.

## Commit Boundary

Runtime publishes an Item's files before writing provenance. Provenance is
attempted once for every committed output. Any provenance failures are combined
into one Operation warning; committed outputs and successful Item outcomes are
not rolled back. Runtime does not claim a filesystem transaction across output
and global-state volumes. If the filesystem refuses removal of transient
staging or replacement-restore files after publication, the successful
Operation exposes one `model_artifact_cleanup_failed` warning instead of
silently discarding that failure.

Workbench Inspector exposes the same lookup as the collapsed, file-only
**AI Generation Record** section. It performs no hash or lookup while collapsed;
an expanded section rechecks the currently selected file and quietly omits
lookup failures and files without a matching record. The
`debrute model-artifact lookup --path <absolute-or-cwd-relative-file>` call
Runtime for one current file. Lookup has no Project positional and does not open
a Project. Workbench never reads the provenance directory directly.

## Executable Authorities

- provenance storage and lookup: `apps/runtime/src/model_request/provenance.rs`;
- response-order naming and commit: `apps/runtime/src/model_request/common.rs`;
- Operation and Artifact Pointer schemas: `apps/runtime/src/model_operation.rs`;
- Workbench and CLI lookup: `apps/runtime/src/workbench/` and
  `apps/runtime/src/cli/`.
