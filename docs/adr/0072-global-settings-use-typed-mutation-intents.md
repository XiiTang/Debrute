# Global Settings Use Typed Mutation Intents

System ADR-0005 gives Runtime one serialized Global Settings store and one
ordered complete Workbench projection. Settings editing also needs one coherent
front-end boundary: page-local persistence queues would repeat confirmation,
rollback, and event-race rules, while one Workbench-wide FIFO would let an
unrelated slow external effect delay immediate presentation.

Workbench therefore uses one deep Global Settings editing module. Its interface
exposes the effective settings snapshot and one `mutate(intent)` operation. The
app protocol defines the closed typed mutation-intent union used end to end;
callers cannot submit arbitrary mixed-field patches.

The module derives serialization identity, supersession, and settlement from
each closed intent. Same-target edits remain ordered and only unsent,
supersedable values coalesce. Unrelated targets submit independently. Safe
presentation settings use an immediate local overlay. External, privileged, or
secret-bearing effects remain accepted-only. In both cases the HTTP result is
only acknowledgement or failure; ordered complete Global events remain the sole
accepted state. Failure rejects only that submitted intent, removes its overlay,
and restores the latest accepted value without overwriting a newer event.
Already queued intents remain ordered and continue independently; Workbench does
not infer a dependency graph or cancel unsent user intent on Runtime's behalf.

Settings pages submit domain intent and do not own accepted-state caches,
persistence queues, or rollback logic. Runtime retains the one serialized
authority; Workbench does not introduce a second accepted store. Plugin
Integration status, Photoshop transfer operations, Product Update operations,
and transient secret reveal commands remain outside this settings mutation
module.

This deepens the Workbench side of system ADR-0005 while preserving Plugin
Integration lifecycle authority from ADR-0068 and explicit transient Model API
key reveal from ADR-0057.
