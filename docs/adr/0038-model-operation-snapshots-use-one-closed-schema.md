# Model Operation Snapshots Use One Closed Schema

`ModelOperationSnapshot` is one closed Rust-owned schema rather than a generic
Operation-kind registry or five duplicated model snapshots. Its common envelope
contains only Operation `id`, Model Kind, canonical `projectRoot`, lifecycle
state, UTC RFC 3339 `acceptedAt`, and shape-specific `execution`. Runtime may
retain the stable Project id internally, but the Agent contract neither exposes
nor consumes it. There is no terminal, queued, started, updated, or
per-transition timestamp and no stored duration. `acceptedAt` supports
approximate lost-submission lookup; issued Operation sequence, not wall-clock
time, defines list order.

`execution` is a closed union selected by `shape`. Single contains Model id,
effective `timeoutSeconds`, and successful terminal Artifact Pointers. Batch
contains `itemCount`, effective `concurrency`, effective `timeoutSeconds`,
`active`, `succeeded`, and `failed`. A common redacted, compacted `log` string
appears only when the Operation itself is failed; failed Batch Items do not
create it. Runtime uses the most relevant source failure record directly,
without a source prefix, error code, diagnostic object, or complete log
sequence. It reuses the Model Runtime's existing redaction, response compaction,
and response-log size policy rather than adding an Operation-specific
truncation limit. Model Request arguments, output policy, replace policy, Item
records, percentages, durations, Provider logs, and other submission input are
excluded. Rust definitions own HTTP serialization,
while the Agent Record renderer owns its deterministic text projection. The public
snapshot has no revision because clients neither submit conditional state
changes nor consume delta or replay protocols. It also has no schema-version
field: Runtime, CLI,
generated clients, and official Skills ship as one Product and change this
contract together.

The HTTP JSON schema retains the nested `execution` union. Its Agent Record
rendering flattens the common envelope and the selected execution variant into
one primitive `operation` named record with `shape` as discriminator; it does
not add a second `execution` record or repeat fields at result-block scope. A
successful Single's `artifact` records immediately follow that `operation`
record. In `operation list`, the next `operation` starts the next group, so an
Artifact Pointer does not repeat `operation_id` merely to encode parentage in a
sequential text format. A failed snapshot renders the same string as the
`operation` record's `log` field.

The flattened `operation` record uses exactly `id`, `model_kind`,
`project_root`, `state`, `accepted_at`, and `shape` for its common fields. A
Single adds `model` and `timeout_seconds`, plus following `artifact` records
only when succeeded. A Batch adds `item_count`, `concurrency`,
`timeout_seconds`, `active`, `succeeded`, and `failed`. A failed
Operation alone adds `log`. Agent Record field names are snake case and are a
deterministic rendering of the camel-case HTTP JSON contract, not a second
domain schema.

`id` is the canonical lowercase UUID v4 issued at acceptance. Clients treat it
as opaque and do not parse or derive list order from it. A malformed UUID and a
well-formed id absent from the current Runtime registry both produce
`operation_not_found`; there is no `invalid_operation_id` branch.

The snapshot has no `canCancel`, `cancellable`, or cancellation-availability
field. Such a value can become stale between inspection and a cancel request,
and there is no snapshot revision or conditional cancellation contract. An
Agent issues the idempotent cancel command directly; Runtime linearizes it
against execution and returns the latest snapshot when cancellation has already
started, completed, or lost to a successful or failed terminal transition.

An active Single snapshot has no progress value: media model requests normally
have no reliable intermediate result. An active Batch snapshot reports only
actual Item counts. `settled` is derived as `succeeded + failed`, `unsettled` as
`itemCount - settled`, and unscheduled pending work as
`itemCount - active - settled`; none is stored as a duplicate field. Runtime
never estimates a percentage from elapsed time, provider polling, phase count,
or typical duration. Clients may derive a Batch percentage only from actual
counts.

Batch Item settlement is a separate closed record carrying `itemIndex`, typed
outcome, and bounded result references. Its Agent Record rendering uses one
`batch_item` named record and repeated `artifact` named records rather than a
JSON-valued field. Snapshots and Item records cannot emit arbitrary key/value
bags as control state. A Model Item failure contains the same redacted,
compacted `log` string as an Operation failure; it has no `message` wrapper,
diagnostic `details`, or Provider error code. Raw Provider payload collections,
secret-bearing values, and unbounded diagnostics never enter either contract.
Debrute-owned command and Operation-control errors retain
their closed codes. Model Requests remain a closed union by Model Kind rather
than becoming free-form input. Product Update, Integration, and
professional-tool states remain separate domain contracts.

Every result surface uses one `ArtifactPointer` shape: zero-based
`artifactIndex`, Artifact Role, Project-relative path, actual MIME type, and
optional known width and height. The prelaunch contract removes the random
`artifactId`, always-true `available`, and path-derived `title` fields. Generated
Asset record ids, Model Run ids, and fingerprints remain provenance metadata
looked up from Project content rather than being copied into an immediate
Capability result.

Each `artifact` Agent Record uses exactly `artifact_index`, `role`,
`project_relative_path`, `mime_type`, and optional `width` and `height`. A
settled Batch progress group begins with one `batch_item` record containing
exactly `item_index`, `model`, and `status`; failed Items add `log`, while
succeeded Items add following `artifact` records. Parent records and sequential
grouping supply identity, so child records add no Operation or Batch id.
