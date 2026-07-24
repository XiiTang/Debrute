# Generated Assets And Model Runs

A Generated Asset is an ordinary Project file created by one model-backed
Capability execution and associated with durable model provenance. The file is
user-owned Project content; its metadata is Project-owned structured state.

## Storage And Record Shape

Generated asset metadata lives inside the Project:

```text
.debrute/assets/generated-assets-index.json
.debrute/assets/generated/<record-id>.json
```

The lightweight index owns lookup fields. Each record file owns one complete
record. No fingerprint cache participates in identity or lookup.

One record contains:

- stable record and Model Run IDs;
- the Project-relative output path at recording time;
- creation time;
- Artifact Role and zero-based artifact index;
- full-file SHA-256 fingerprint; and
- redacted Model Run request and output values.

Artifact Roles distinguish primary images, primary videos, optional video last
frames, TTS audio, music audio, sound-effect audio, and other outputs. Multiple
files from one invocation share a Model Run ID and use their role and index to
retain their relationship. Generated asset records contain no provider field,
Agent thread identity, tool-call identity, or embedded file bytes.

Recording verifies that the Project output is an existing file, hashes
its complete bytes, and commits the new record plus index update through one
owner-checked Project Document transaction.

## Content Identity

Generated metadata follows content, not path. The only durable match is equality
of the full-file SHA-256 fingerprint. Path, size, modification time, MIME type,
and dimensions may locate or describe a file, but they do not establish
generation identity.

Lookup starts from one requested current Project path. It always streams the
current file and computes SHA-256. Size and modification time never authorize
reuse of an earlier fingerprint. The index can return multiple records with the
same fingerprint, newest first. A moved or renamed byte-identical file still
matches; an edited, recompressed, transcoded, or re-exported file does not.

Resolving the current file for a record checks its recorded path first, then
streams a bounded traversal of current visible non-protected Project files for
the same fingerprint. File count, visited-entry count, total bytes and elapsed
time are all bounded. This supports moved outputs without rewriting the
immutable provenance record.

## Lookup Results And Failures

Metadata lookup returns one explicit state:

- `matched` with the fingerprint and every readable matching record;
- `unmatched` with the computed fingerprint; or
- `unavailable` because the source is missing, unreadable, or metadata cannot be
  read.

An unreadable matching record is reported as a diagnostic while other matching
records can still be returned. A corrupt authoritative index makes metadata
unavailable.

## Model Run Safety

Model executors create the persistent Model Run copy before calling the
generated-asset recorder. Active API keys, credential fields, secret query
parameters, and inline media payloads are already redacted. Image-specific
large-payload compaction may further preserve shape without storing encoded
media. The metadata service stores the supplied safe request and output; it is
not a fallback credential scrubber.

Generation failure creates no Generated Asset record unless an output file was
successfully written and explicitly recorded.

## Product Surfaces

The Workbench and `generated-asset` CLI surfaces read metadata through the Rust
Runtime. Renderer code does not open metadata files directly.
Artifact Pointers in Capability results lead to the newly written Project files;
Generated Asset records preserve the Model Run relationship and content
identity after that immediate result.

Canvas does not receive Capability output directly. It presents the generated
file after it becomes ordinary visible Project content selected by a Canvas Map.

## Executable Authorities

- Generated Asset, Model Run, Artifact Role, index/record validation, lookup,
  moved-file resolution and source-backed tests:
  `apps/runtime/src/project/generated_assets.rs`.
- Safe request/output construction, generation storage and Artifact Role
  assignment: `apps/runtime/src/generation/`.
- Project Document ownership and visibility rules:
  `apps/runtime/src/project/documents.rs` and
  `apps/runtime/src/project/paths.rs`.
