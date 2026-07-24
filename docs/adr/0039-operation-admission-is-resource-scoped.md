# Operation Admission Is Resource Scoped

Runtime admits Operations through resource-scoped lanes rather than one global
queue. The closed specification for each Operation kind declares its dominant
admission lane and permit cost. Lane capacity counts shared resource permits,
not Operation records. An Operation may receive one or more permits from its
current lane, and that grant is its effective parallelism for the phase.
Operations competing for unavailable permits remain observable in `queued` and
are admitted in FIFO order; Operations whose claims do not conflict may run
concurrently. Canceling a queued Operation immediately produces `cancelled`.

Runtime owns every lane's instance-wide permit budget and each Operation kind's
hard maximum. A caller may provide a lower `requestedParallelism` ceiling but
cannot enlarge either budget; Runtime grants at most the requested ceiling,
kind maximum, and currently allocatable permits. The Operation snapshot reports
both requested and effective parallelism. Client count and Project count never
multiply lane capacity, and ordinary settings expose no unlimited mode or hard
maximum override.

Long-running integration mutation, provider execution, transfer, and product
transition work use distinct lanes. An Operation releases one lane before
waiting for another and never holds multiple admission lanes simultaneously,
preventing scheduler deadlock. Admission lanes do not replace domain
serialization: long provider work must not hold a Project write lock, and its
final commit still enters the owning Project mutation queue with revision
validation. Product and global-state commits likewise go through their owning
coordinator. This was chosen over a global FIFO, which would let unrelated work
block each other, and over subsystem-local busy errors, which would expose
inconsistent concurrency semantics to clients.
