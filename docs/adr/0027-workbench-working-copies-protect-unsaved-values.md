# Workbench Working Copies Protect Unsaved Values

Workbench persists each unsaved text buffer and the active feedback draft to
Runtime as a complete Working Copy whenever it changes. Runtime stores them
atomically in its private state directory under a hash of the stable Project
id. A successful save of the matching text value, explicit text discard,
successful feedback submission, or feedback cancel clears the corresponding
Working Copy.

Project binding includes the current Working Copies so a new Workbench can
restore them as dirty frontend state. They have no TTL, size/count policy,
frontend-session identity, unload checkpoint, or compatibility representation.
Reconstructible view state, terminal state, and arbitrary component memory are
outside this boundary.

Closing or crashing a Workbench therefore does not run an asynchronous
save/discard protocol. Desktop window close, Desktop exit, Product Quit,
Product update, reload, and Project preemption do not ask the renderer for a
blocker decision. Runtime never assumes a Workbench exists during shutdown.
