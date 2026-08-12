# Photoshop Directory Browsing Reuses The Project Tree

Photoshop destination browsing reuses each live Project Session's existing
Project Tree rather than maintaining a second recursive directory catalog.
The plugin requests the direct directory children of the parents it expands.
Runtime loads those parents through the ordinary revision-ordered Project Tree
command lane, then projects only their directory children into the Photoshop
protocol. A result identifies both the exact base revision requested by the
plugin and the resulting Project revision, so the plugin can install or discard
the page without guessing whether its own load caused the revision change.

The shared tree keeps one filesystem visibility, identity, watcher-interest,
cache, and revision authority for Workbench, Canvas, and Photoshop. Photoshop
adds only its protected destination rule: any path containing a
case-insensitive `.debrute` segment is unavailable. It does not add another
watcher, polling loop, Project revision, recursive snapshot, or persisted
catalog. Ordinary dependency, build, and gitignored directories remain visible
when the Project Tree exposes them. Symbolic links, junctions, VCS internals,
managed temporary entries, and other paths already excluded by the Project
Tree remain excluded everywhere.

Loading a directory for Photoshop may warm the shared Project Tree and advance
the same Project revision visible to Workbench. That is filesystem state, not
Photoshop UI state: destination selection, expanded rows, pending page
requests, and page caches remain process-memory state owned only by the plugin.
This trade-off avoids duplicate filesystem truth and makes watcher-driven
deletion invalidate a selected destination through the same loaded-parent
dependency that discovered it.
