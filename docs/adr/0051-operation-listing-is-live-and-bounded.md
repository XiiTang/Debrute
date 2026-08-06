# Operation Listing Is Live And Bounded

`debrute operation list` exposes the Agent-visible portion of the current
Runtime Model Operation registry in newest-first issued order. Its complete
option surface is `--state`, `--model-kind`, `--limit`, and `--cursor`.

`--state` accepts `active`, `terminal`, `queued`, `running`, `cancelling`,
`succeeded`, `failed`, or `cancelled`. `--model-kind` accepts `image`, `video`,
`tts`, `music`, or `sound-effect`. Filters combine with AND. Model Operations
have no Project binding or shared output-directory identity, so listing has
neither a Project positional nor an output-directory filter.

The default page contains 25 records and `--limit` accepts 1 through 100. When
older matches remain, the response contains one opaque `next_cursor`. A cursor
encodes the current Runtime instance and last issued sequence; a malformed
cursor or one from another Runtime is `invalid_cursor`.

Pagination reads the live registry rather than creating a snapshot. Operations
issued after the first page do not enter its remaining older pages, while
retired records may disappear. Callers repeat any desired filters with the
cursor. There is no reverse cursor, offset, page number, `--all`, persistent
history, archive, alternate sort, signature, encryption, or server-side cursor
storage.
