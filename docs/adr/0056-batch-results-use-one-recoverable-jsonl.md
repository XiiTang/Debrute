# Batch Results Use One Recoverable JSONL

Batch generation requires one caller-selected Project JSONL result and removes
the existing separate log and summary outputs. The file is an explicit domain
result rather than Runtime-owned Operation history, so its path follows the
same create-only claim and version-checked replacement rules as other explicit
outputs. Its closed, versioned, redacted schema begins with a header containing
the Operation id, input digest, Generation Kind, and item count.

Each settled item appends exactly one item record in completion order
with a stable zero-based item index. A successful item's generated artifacts,
provenance, and result record belong to the same recoverable item commit; a
failed item commits only its result. The generation journal records the
expected append offset and record digest so recovery can complete an append
without duplicating it. Provider payloads and free-form logs are excluded.

Normal terminal handling appends one final terminal record containing
the Operation terminal state and minimal total, settled, succeeded, failed, and
unsettled counts. This record is a durable completeness marker, not a separate
summary artifact. A Runtime crash leaves the valid header and exactly committed
item records without inventing a terminal record. CLI stdout remains the Agent
Record stream and reports only bounded progress, terminal state, and the result
path; JSONL is not an alternate stdout mode. Exact option,
record, and field names belong to the implemented CLI and protocol contracts.
