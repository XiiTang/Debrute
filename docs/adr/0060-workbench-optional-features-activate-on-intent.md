# Workbench Optional Features Activate On Intent

The Workbench critical JavaScript graph contains only connection projection,
shell, Project presentation, and Canvas presentation needed for the first
committed surface. Settings, Explorer presentation, Inspector, Terminal,
floating text windows, and the CodeMirror editor engine activate from explicit
surface demand and read the current accepted projections when they mount. The
Terminal WebSocket Hub is created only by first Terminal transport use and
binds the latest accepted Project rather than every window creating it during
bootstrap. The
production manifest and gzip budget enforce those boundaries. This was chosen
over eagerly mounting every controller and view because background feature
initialization delayed every window and Project open, while a second cache or
frontend settings store would make late activation fast only by introducing a
competing authority.

Project binding follows the same first-use principle below the renderer:
Runtime establishes the session watcher, computes one shallow Project snapshot,
publishes it, and only then starts the complete file index. The background index
and watcher share nested `.gitignore` plus fixed dependency/cache/build
exclusions. The supported macOS and Windows backends use one native recursive
root subscription, with logical event admission retaining any explicit Canvas
literal or expanded Explorer dependency inside an otherwise excluded tree.
Explicit Canvas directory expansion is cached and refreshed only for a matching
event subtree or a full recovery scan; unrelated Project changes do not rescan it.
Static text filename
patterns are process-cached so Canvas projection cost scales with nodes matched,
not with repeated regular-expression compilation. The Project id captured by
authority preparation is immutable for that session; a different id observed
during or after watcher establishment fails before any mismatched projection
can be published.
