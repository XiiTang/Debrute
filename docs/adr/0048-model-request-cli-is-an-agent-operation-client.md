# Model Request CLI Is An Agent Operation Client

Debrute CLI is an Agent-facing, non-interactive Operation client. It uses the
line-oriented Agent Record protocol and adds no competing serialization mode.
Every record block starts with unversioned `debrute ok`, `debrute error`, or
`debrute progress`; `debrute` is only the block marker. Agent Records have no
syntax-version field or negotiation because Runtime, CLI, generated clients,
and official Skills ship and change together. The prelaunch implementation
removes `debrute/1` without an alias or old-format parser. CLI never branches on
TTY state or emits prompts, spinners, ANSI UI, or multi-press shortcuts.

An error header carries the Debrute command or control `code` and has no
`message` field. When no Operation snapshot exists, the result block may carry
one top-level redacted, compacted `log` string with the direct diagnostic text.
When a failed Operation snapshot exists, its `operation` record owns that log
and the result block does not repeat it. A code plus a nonfailed terminal
snapshot, such as `operation_already_terminal`, needs no invented log. Provider
and model failure reasons remain logs rather than becoming public error codes.

Pre-acceptance request errors use only `invalid_input`, `project_invalid`,
`model_unavailable`, and `internal_error`, plus the shared
transport outcomes `runtime_lost` and `submission_outcome_unknown`.
`invalid_input` and `project_invalid` exit with status `2`; the others exit with
status `1`. Once acceptance is possible, loss before the Operation id arrives
uses `submission_outcome_unknown` rather than `runtime_lost`, and CLI never
automatically retries.

Model execution uses one request-oriented command family:

```text
debrute request single <project> --input <request-jsonl-path|->
debrute request batch <project> --input <requests-jsonl-path|->
```

`single` and `batch` explicitly select the Execution Shape; CLI never derives
shape from input format or record count. Both shapes accept only UTF-8 JSONL:
Single requires exactly one Model Request record and Batch requires one or more.
`--input` names a CLI-local file, while `-` reads the same JSONL contract from
standard input. CLI reads the bounded source and sends it as the `input` part
of one authenticated multipart submission; a small `request` field carries
submission
metadata rather than embedding or duplicating the Model Requests. Runtime
stores the arriving part in Runtime-owned temporary storage, reads and validates
the complete input before atomic Operation acceptance, and releases the upload
after constructing the immutable Operation input. Runtime never opens the
CLI-local source path and never starts a Batch while input is still arriving.
There is no upload session, resumable transfer, or alternate JSON-body route.
There is no inline JSON, JSON-array, `--input-json`, or `--input-jsonl` mode.
Each physical UTF-8 line must contain one complete Model Request object. LF and
CRLF are accepted, the final line terminator is optional, and ordinary JSON
whitespace around an object is permitted. Blank or whitespace-only lines,
comments, a byte-order mark, arrays, and pretty-printed objects spanning lines
are invalid rather than skipped or normalized. A malformed or invalid record
rejects the whole submission before creating an Operation or starting paid
work. Runtime enforces one `16 MiB` bound over the complete received JSONL
source. Exceeding it rejects the whole submission before an Operation exists.
There is no separate per-line or Batch Item-count limit: the source-byte bound
prevents unbounded input buffering, while Batch concurrency governs active
execution. The fixed source bound has no configuration or environment override
and is not a Runtime admission or execution-capacity limit.
Each request names its Debrute Model, so the command does not repeat a Model
Kind. Generate, edit, extend, and other model-specific intents remain in that
model's request contract instead of becoming CLI subcommands or one universal
`--action`. The prelaunch CLI removes the old `generate` and `image-batch`
command families without aliases, compatibility parsing, or dedicated
rejection branches.

Every input JSONL line uses the same closed Model Request envelope:

```json
{
  "model": "globally-unique-model-id",
  "arguments": {},
  "output": {
    "directory": "generated",
    "filename": "covers"
  }
}
```

`model` and `arguments` are required. Runtime resolves the globally unique Model
id to its Model Kind and validates the JSON shapes of fields its adapter
consumes; structurally safe unknown parameter names continue to the selected
remote endpoint. Optional `output` has only `directory` and `filename`, and
either member may be omitted independently. Runtime supplies an Operation-unique
directory when `directory` is absent and a generated file base name when
`filename` is absent. The top-level envelope and `output` are closed: there is
no caller `kind`, universal `action`, request or Item id, name, or input digest. Batch
line order supplies stable zero-based `itemIndex` identity; Single's sole line
has no public Item identity. Model schemas contain no `output_path` or
`output_directory`; output naming is a Runtime concern rather than an upstream
model argument.

Both request commands accept optional `--timeout <duration>`. The duration is a
positive integer followed by exactly one of `s`, `m`, or `h`; bare numbers,
milliseconds, decimals, and compound values are invalid. An omitted option uses
the Runtime default for the resolved Model Kind. For a Batch, the command-level
value is the active model-execution timeout applied independently to every
Item, not a deadline for the whole Operation. Model Request JSON and Batch Item
records cannot override it. An omitted value uses `30m` for `video` and `10m`
for `image`, `tts`, `music`, and `sound-effect`; there is no product-defined
maximum for an explicit representable duration.

Both request commands also accept one command-level `--replace` opt-in. It
applies uniformly to every explicit model output. Model Request JSON and Batch
Item records cannot override it. The prelaunch CLI removes
`--overwrite-existing` and adds no `--force` or compatibility alias. Runtime
stores the option at acceptance but applies it only when actual model output
files are committed. Submission performs no output existence check, hash
baseline, reservation, or active-Operation claim.

By default, a request command submits one Model Operation, immediately flushes
a `debrute progress` block with `event=operation.accepted`, its id, and first
snapshot, then waits for its terminal result. A Single produces no other
intermediate progress records; a Batch sparsely prints each Item outcome as one
multi-line `debrute progress` block.
Each such block contains exactly one `batch_item` named record and, on success,
zero or more `artifact` records; failure carries redacted, compacted source text
directly in its `log` field, with no Provider error code, message wrapper,
diagnostic object, or retained log sequence. It does not repeat the whole Operation snapshot or
embed an escaped JSON result. Every invocation writes exactly one final
`debrute ok` or `debrute error` result block containing its latest snapshot;
Batch counts appear only through that snapshot rather than as duplicate
top-level fields. The CLI exits immediately after writing the block
and waits for no acknowledgement. This is structured result output, not a
termination handshake; EOF alone does not claim a domain result because it may
also follow a signal, transport loss, or process failure. Runtime and CLI
diagnostics remain on stderr and never interrupt the stdout record grammar.

Agent Record rendering flattens each snapshot's common envelope and selected
execution variant into one primitive `operation` named record discriminated by
`shape`. It emits no separate `execution` record. Successful Single Artifact
Pointers immediately follow their owning `operation`; sequential grouping also
applies when `operation list` contains multiple snapshots, so Artifact Pointers
do not repeat the Operation id.

Request commands also provide explicit `--no-wait` submission. It returns
successfully as soon as Runtime accepts the Operation and reports its id and
current snapshot in its one final result block; it emits no preceding accepted
progress block. Success means acceptance, not successful model execution. A
later CLI session uses four closed management commands:

```text
debrute operation list
debrute operation inspect <operation-id>
debrute operation wait <operation-id>
debrute operation cancel <operation-id>
```

`inspect` always returns immediately. The separate `wait` command starts from a
current snapshot and streams to a terminal state; it is the explicit blocking
surface for observing a request submitted with `--no-wait` or after an earlier
observer ended. Runtime provides no Operation-resume, retry, reconnect, `get`,
or `status` alias because Operations are instance-scoped and do not survive
Runtime replacement.

Batch requests accept optional positive-integer `--concurrency`. When omitted
it is `1`, so Items execute sequentially unless the caller explicitly chooses
parallel execution. Effective concurrency is the smaller of the supplied value
and the Batch Item count. There is no separate maximum: a per-Batch ceiling
would not bound Runtime load because callers may submit multiple Operations,
while a real process-wide capacity or permit scheduler is deliberately absent.
The value controls only that Batch, and an explicitly excessive value carries
its ordinary local-resource and upstream-rate-limit consequences.

Process signals and transport loss carry no domain cancellation meaning. An
operating-system termination signal, a killed Agent tool, or a disconnected
observer terminates only that CLI process and preserves native signal status;
the accepted Runtime Operation continues. The explicit cancellation command is
the sole CLI cancellation path. This was chosen because Agent hosts use signals
for tool timeouts, task replacement, and shutdown, so translating them into
paid-work cancellation would be ambiguous. The design keeps one-command
foreground execution simple while providing explicit asynchronous
orchestration and later observation for Agents.
