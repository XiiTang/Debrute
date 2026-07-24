# Workbench Working Copies Protect Unsaved Values

Workbench persists each unsaved text buffer and the latest value of every
Feedback Capsule that is not yet reflected in accepted Runtime state as a
complete Working Copy whenever it changes. Runtime stores them atomically in
its private state directory under a hash of the stable Project id. Feedback
Working Copies use stable Capsule identities and creation timestamps, so
multiple comments and files synchronize independently without response order
changing their presentation order. A successful matching text save, explicit
text discard, accepted feedback mutation, or feedback deletion clears only the
corresponding Working Copy.

Project binding includes the current Working Copies so a new Workbench can
restore them as dirty frontend state. They have no TTL, size/count policy,
frontend-session identity, unload checkpoint, or compatibility representation.
Geometry or a video time without non-empty comment text is transient Canvas
composition rather than a Feedback Item. Reconstructible view state, terminal
state, and arbitrary component memory are outside this boundary.

Closing or crashing a Workbench therefore does not run an asynchronous
save/discard protocol. Desktop window close, Desktop exit, Product Quit,
Product update, reload, and Project preemption do not ask the renderer for a
blocker decision. Runtime never assumes a Workbench exists during shutdown.
