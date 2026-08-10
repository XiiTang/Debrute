# Global Settings Use One Serialized Store

`GlobalConfigStore` is the sole persistence and serialization boundary for
runtime-wide preferences, the Feedback Mark Catalog and Action Bar, recent
projects, model overrides, Plugin Integration enablement, and secrets. The
Photoshop enable choice enters this store, while
gateway health, sessions, Documents, credentials, commands, and transfer state
remain ephemeral. Reads and mutations use one process-local
queue, public views redact secrets, and runtime events are emitted from committed
mutation results. This was chosen over per-feature stores and frontend-owned
synchronization so concurrent changes compose into one coherent runtime
snapshot without compatibility, migration, caching, or cross-process locking
layers.

Mutations enter this store as closed domain intents rather than arbitrary
partial object patches. ADR-0072 defines their Workbench settlement model.

For a connected Workbench, the connection's initial Global snapshot and ordered
change events are the only frontend projection of this store. Settings commands
return their command outcome rather than another complete settings view, and
the Workbench does not perform a duplicate post-connection settings read. This
keeps one Runtime-owned projection instead of reconciling snapshot, command
response, and follow-up read copies in the frontend.
