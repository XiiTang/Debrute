# Global Settings Use One Serialized Store

`GlobalConfigStore` is the sole persistence and serialization boundary for
runtime-wide preferences, recent projects, model overrides and secrets, and the
persisted Adobe Bridge enabled state. Reads and mutations use one process-local
queue, public views redact secrets, and runtime events are emitted from committed
mutation results. This was chosen over per-feature stores and frontend-owned
synchronization so concurrent changes compose into one coherent runtime
snapshot without compatibility, migration, caching, or cross-process locking
layers.
