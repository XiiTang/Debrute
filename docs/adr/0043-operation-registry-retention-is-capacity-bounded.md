# Operation Registry Retention Is Capacity Bounded

Runtime retains at most `100` terminal Operation observation records. Each
record owns its terminal snapshot and, for Batch, settled Item Outcomes in
settlement order so a later wait can replay them without a Project log. It uses
no retained-byte budget, time-to-live, last-access component, configuration
value, environment override, or CLI override. This bounds retained record
count, not an independently calculated byte total; Runtime adds no second retention policy
for Batch Item, Artifact Pointer, or serialized record size. Reading a record
never refreshes or pins it, and clients are not required to acknowledge or
release records.

An Operation becomes reclaimable only after it reaches a terminal state and
finishes cleanup. Model Operations never hold Project Uses. Under terminal
record pressure, Runtime retains the newest completion and retires older
records and their Item Outcomes in completion order until the count limit is
satisfied. Active Operations are never evicted for registry capacity and do not
consume the 100 terminal-record slots. This retention count is not an execution
admission or concurrency limit.

Retiring a terminal record is silent; later access returns
`operation_not_found`, the same as every id absent from the current registry. A
disconnected client has no guarantee that a terminal record will still exist
when it reconnects, because durable outcomes belong to the owning domain rather
than the Operation registry. Runtime adds no tombstone, retirement event, or
acknowledgement protocol. This was chosen over elapsed-time retention,
access-based LRU, and client acknowledgements so retained-record count has one
clear bound without arbitrary clocks or client-controlled lifetime.
