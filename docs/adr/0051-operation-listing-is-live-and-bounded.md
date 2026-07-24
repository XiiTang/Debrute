# Operation Listing Is Live And Bounded

`debrute operation list` exposes the Agent-visible portion of the current
Runtime Operation registry. By default it includes active Operations and
retained terminal Operations, ordered from newest to oldest by issued Operation
sequence. Its complete option surface is `--state`, `--model-kind`, `--project`,
`--limit`, and `--cursor`. `--state` accepts one of `active`, `terminal`,
`queued`, `running`, `cancelling`, `succeeded`, `failed`, or `cancelled`;
`active` selects the three nonterminal states and `terminal` selects the three
terminal states. `--model-kind` accepts one of `image`, `video`, `tts`, `music`,
or `sound-effect`. Each filter may appear at most once, and distinct filters
combine with AND.
The Runtime validates a supplied current Project root and matches both its
canonical root and stable Project id against the stored Project reference,
without opening a Project session. Reusing the same path text for a different
Project does not return the previous Project's Operations.

Every response is bounded by record count. The default page contains `25`
records and `--limit` accepts only `1` through `100`; these fixed source values
have no configuration or environment override. When more matching records remain, the response
includes only `next_cursor=<opaque>` in addition to its `operation` groups. It
does not repeat derivable `count` or `has_more` fields. The opaque forward
cursor is the plain string `<runtime-instance-uuid>:<last-issued-sequence>`.
The UUID is canonical lowercase and the sequence is an unsigned decimal
integer. Clients still treat the complete string as opaque; readability does
not make either part a client contract to interpret or modify. A cursor from
another Runtime instance returns `invalid_cursor`. Runtime provides no reverse cursor. The
maximum page can contain all 100 retained terminal records, while the cursor
also covers any additional active Operations.

Pagination reads the live registry and does not create a snapshot. Each page
applies its supplied filters and continues with matching Operations older than
the cursor sequence; the cursor is not bound to one filter set. Operations
issued after the first page therefore do not enter its remaining older pages,
while records retired between pages may disappear without invalidating the
cursor position. This command is a bounded inspection surface for current
control state, not durable history, audit storage, or a complete record of past
Operations. The single forward cursor is retained because active Operations are
never evicted and have no process-wide count limit; without it, active records
older than one response limit could become unreachable when their ids are not
already known. Debrute does not adopt the persistent-history search, archive,
reverse cursor, or multi-sort semantics used by Codex thread listing. There is
also no `--all`, offset, page number, time range, or alternate sort. When
continuing, callers repeat any desired filters; the cursor deliberately remains
valid with a different filter set and only supplies the older sequence
position.

Cursor encoding uses no base64, JSON, schema version, signature, encryption, or
server-side cursor storage. Malformed separators, UUIDs, and sequence values use
the same `invalid_cursor` result as a cursor from another Runtime instance.
