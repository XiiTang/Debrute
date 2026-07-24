# Batch Operation Success Means All Items Settled

Absent accepted cancellation, a Batch Model Operation promises to settle every
accepted `BatchItem`, assign each one a successful or failed terminal Item
Outcome, and retain those Outcomes for current-instance observation. Item
Outcomes are result data, not child Operation lifecycle states. Once that
contract is complete, the Operation is `succeeded` regardless of `failedCount`,
including when every Item has a failed Outcome.

The Operation is `failed` only when batch coordination itself cannot complete
its contract, such as an internal scheduling failure, unreadable remaining
input, or a missing Item Outcome. Cancellation stops scheduling unstarted Items
and asks each active Model Request to abort where its contract permits. Items
without a committed Outcome remain `unsettled`; they are not converted into
failed Outcomes. Already committed Item outputs and Outcomes are never rolled
back.

After local work and cleanup stop, the Operation becomes `cancelled`. That
state does not claim that an
upstream model service lacking a cancellation API stopped its remote work or
reversed a charge. Runtime adds neither a `partially_succeeded` lifecycle state
nor a `batch_items_failed` Operation failure.

CLI process status follows the Operation lifecycle, so a succeeded batch exits
successfully and callers inspect the typed counts or Item Outcomes when results
matter. The current `failedCount > 0` exit-code override is removed in
the final CLI. This was chosen so Operation success describes whether its own
contract completed rather than conflating orchestration health with the
independent business outcome of each batch item.
