# Global Settings Use One Serialized Store

`GlobalConfigStore` is the sole persistence and serialization boundary for
runtime-wide preferences, recent projects, model overrides and secrets, and the
persisted Adobe Bridge enabled state. Reads and mutations use one process-local
queue, public views redact secrets, and runtime events are emitted from committed
mutation results. This was chosen over per-feature stores and frontend-owned
synchronization so concurrent changes compose into one coherent runtime
snapshot without compatibility, migration, caching, or cross-process locking
layers.

For a connected Workbench, the connection's initial Global snapshot and ordered
change events are the only frontend projection of this store. Settings commands
return their command outcome rather than another complete settings view, and
the Workbench does not perform a duplicate post-connection settings read. This
keeps one Runtime-owned projection instead of reconciling snapshot, command
response, and follow-up read copies in the frontend.
