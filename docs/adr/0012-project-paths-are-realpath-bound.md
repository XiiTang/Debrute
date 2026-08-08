# Project Paths Are Realpath-Bound

Project-owned filesystem operations accept Project-relative paths but authorize
their existing target or nearest existing parent only after realpath containment
under the canonical Project root; sensitive internal targets additionally reject
symlinks. This was chosen over lexical prefix checks so an in-project symlink
cannot redirect reads, writes, deletes, locks, caches, or rollback work outside
the Project.

Runtime parses every external relative-path string into one of two closed value
types before filesystem access. `ProjectRelativePath` is non-empty.
`ProjectDirectoryPath` additionally permits the empty value to denote the
Project root. Both reject absolute paths, traversal, backslashes, control
characters, empty segments, trailing dots or spaces, and Windows device names.
Filesystem Interfaces which require an admitted relative path accept these
types rather than strings.

Canonical Project identity paths remain unchanged for identity, equality,
containment, and native filesystem calls. When an external process cannot
consume Windows verbatim syntax, the owning process Adapter projects only
supported `\\?\C:\...` and `\\?\UNC\...` forms at spawn time. That projection
does not become Project identity and is never fed back into containment checks.
