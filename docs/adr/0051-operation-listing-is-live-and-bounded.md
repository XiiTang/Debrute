# Operation Listing Is Live And Bounded

The Operation-listing command exposes the Agent-visible portion of the current
Runtime Operation registry. By default it includes active Operations and
retained terminal Operations, ordered from newest to oldest by issued Operation
sequence. Callers may filter by lifecycle class, Operation kind, and Project.
The Runtime resolves a supplied Project root to the same canonical Project
scope used for Operation authorization; path text is not used as an independent
identity.

Every response is bounded by both record count and serialized byte size. The
Runtime source defines the default and hard maximum budgets. A caller may lower
the requested record-count bound but cannot raise either Runtime budget. When
more matching records remain, the response includes an opaque cursor bound to
the current Runtime instance, the canonical filters, and the last issued
sequence returned. A cursor from another Runtime instance or a different
filter set is rejected rather than reinterpreted.

Pagination reads the live registry and does not create a snapshot. Records
retired between pages may disappear. The cursor's upper sequence boundary keeps
Operations issued after the first page from entering the remaining pages of
that traversal. This command is a bounded recovery and inspection surface for
current control state, not durable history, audit storage, or a complete record
of past Operations.
