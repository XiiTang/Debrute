# Project Paths Are Realpath-Bound

Project-owned filesystem operations accept Project-relative paths but authorize
their existing target or nearest existing parent only after realpath containment
under the canonical Project root; sensitive internal targets additionally reject
symlinks. This was chosen over lexical prefix checks so an in-project symlink
cannot redirect reads, writes, deletes, locks, caches, or rollback work outside
the Project.
