# Operation Registry Retention Is Capacity Bounded

Runtime applies separate count and retained-byte budgets to terminal Operation
summaries and reservations that have not created an Operation, including
reservations bound by a rejected `StartOperation`. Neither budget contains a
time-to-live or last-access component. Reading a record never refreshes or pins
it, and clients are not required to acknowledge or release records.

An Operation becomes reclaimable only after it reaches a terminal state,
finishes cleanup, and releases all Project Uses and lane permits. Under terminal
summary pressure, Runtime retains the newest completion and retires older
summaries in completion order until both budgets are satisfied. Under
reservation pressure, it retires reservations in issue order. Active
Operations are never evicted for registry capacity. The closed Operation
schemas and Runtime budgets must ensure that at least one maximum-sized newest
record can be retained.

Retiring a terminal summary emits `operation.retired` to authorized connected
connections; later access returns `operation_retired`. A disconnected client
has no guarantee that a terminal summary will still exist when it reconnects,
because durable outcomes belong to the owning domain rather than the Operation
registry. This was chosen over elapsed-time retention, access-based LRU, and
client acknowledgements so memory use is bounded without arbitrary clocks or
client-controlled lifetime.
