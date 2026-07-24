# Integration Operations Are Catalog-Defined

The Integrations Settings surface submits only an integration id and operation;
the runtime derives a fixed executable and argument vector from the source-owned
catalog after revalidating platform, backend, and current status. Commands run
without a shell under one process-wide operation lock with bounded output and a
timeout. This was chosen over UI-provided commands, editable previews, or a
generic tool installer so the privileged execution surface stays finite,
testable, and consistent across runtime clients.
