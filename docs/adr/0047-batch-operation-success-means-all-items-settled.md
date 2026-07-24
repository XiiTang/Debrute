# Batch Operation Success Means All Items Settled

A batch generation Operation promises to settle every accepted `BatchItem`,
assign each one a successful or failed terminal item outcome, and durably
append its terminal result record and the batch terminal marker to the result
JSONL. Item outcomes are result data, not child Operation lifecycle states.
Once that contract is complete, the Operation is `succeeded` regardless of
`failedCount`, including when every item has a failed outcome.

The Operation is `failed` only when batch coordination itself cannot complete
its contract, such as an internal scheduling failure, unreadable remaining
input, missing item outcome, or inability to write and finalize the result
JSONL. Cancellation before every item is settled produces `cancelled`.
Successful artifacts are never rolled back, and Runtime adds neither a
`partially_succeeded` lifecycle state nor a `batch_items_failed` Operation
failure.

CLI process status follows the Operation lifecycle, so a succeeded batch exits
successfully and callers inspect the typed counts or result JSONL when item
outcomes matter. The current `failedCount > 0` exit-code override is removed in
the final CLI. This was chosen so Operation success describes whether its own
contract completed rather than conflating orchestration health with the
independent business outcome of each batch item.
