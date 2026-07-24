# CLI

The Rust `debrute` CLI is an Agent-facing client of the local Runtime. It always
writes unversioned Agent Records on stdout; JSON is an input encoding, not an
alternate output mode.

## Agent Records And Exit Status

Every result starts with exactly one final header:

```text
debrute ok cmd=<command>
debrute error cmd=<command> code=<error-code>
```

A waiting Model Request may first emit sparse blocks beginning with:

```text
debrute progress cmd=<command> event=<event>
```

Named `operation`, `batch_item`, `artifact`, `model`, and diagnostic records
follow on separate lines. Error records may contain a redacted `log`; they do
not have a generic message field. Exit status is deliberately coarse: `0`
means success, `2` means CLI syntax or input is invalid, and `1` means every
other failure. An invalid Project is caller input and also exits `2`. A Batch
whose accepted Items all settled is successful even when
some Items failed, so its final Operation record exits `0` and reports the Item
failures in progress records.

A diagnostic record presents one Project Diagnostic through its `error` or
`warning` severity, code, message, and optional Project path. Project health
counts only errors and warnings. The record has no source field: its name and
command-scoped Project already identify its owner, and Debrute has no generic
cross-domain diagnostic-source taxonomy.

`apps/runtime/src/cli/spec.rs` is the executable public-command inventory used
by `debrute commands`, `debrute help`, the parser, and official Skills. Each
entry is also the single parser contract for positional bounds, the optional
Project positional, options and their value/flag/repeatable form, required
options, Project-path values, simple allowed-value sets, and command-specific
public errors. The exported error inventory merges those entries with the
acquisition, transport, and lifecycle errors shared by each command policy.
The parser does not repeat syntax facts in command-name switches or infer them
from the human-readable input synopsis. Every Runtime-backed policy publishes
`product_update_failed` because a Product replacement can win before its
Control authorization or request; the CLI does not retry that race.

## Runtime Connections

Local and observation commands keep their existing policies. Operational
commands ensure Runtime, create authorization bound to one native Control
connection, and keep that connection open for the command. Model Request
submission uses authenticated `/api/cli/model-operations`; observation uses
`/api/cli/run` and `/api/cli/run-stream`. Closing the CLI connection never
cancels an accepted Operation; it ends only that command-scoped wait observer.
Runtime acquisition, optional launch, handshake, and Ready polling share one
absolute fifteen-second deadline. Expiry emits `runtime_ready_timeout` without
submitting the command, terminating or replacing Runtime, starting another
Runtime, or retrying. `debrute runtime stop` is different: it never starts
Runtime and sends Product Quit to an existing owner without waiting for Ready,
including while the owner reports `Starting`. Because Stop has no Ready gate,
a stalled or invalid handshake remains `runtime_health_failed`; it is never
relabeled as `runtime_ready_timeout`.

The CLI adapter is a required part of every ready Runtime. Product Update is a
separate launch-mode capability: `debrute update` uses it in a packaged Product,
while a source-development Runtime returns `product_update_unavailable` because
that mode has no Product updater. The CLI does not retry the request through
another backend.

## Model Requests

Single and Batch use the same strict UTF-8 JSONL record:

```json
{"model":"gpt-image-2","arguments":{"prompt":"Cover image"},"output":{"directory":"generated","filename":"cover"}}
```

`model` is a globally unique Debrute Model id. `arguments` contains only the
selected Model's arguments. Optional `output.directory` and `output.filename`
are separate Project-relative naming fields; `filename` has no generated-file
extension. Runtime derives the extension from the actual Artifact MIME type.

```sh
debrute request single /path/to/project --input request.jsonl
debrute request batch /path/to/project --input requests.jsonl --concurrency 3
cat request.jsonl | debrute request single /path/to/project --input - --timeout 10m
```

Input is exactly one JSONL record for `single` and one or more records for
`batch`. Blank lines, comments, a UTF-8 BOM, JSON spanning multiple lines, and
input above 16 MiB are rejected. All Batch records must resolve to the same
Model Kind. Batch concurrency defaults to `1` and controls only that Batch;
Runtime has no additional global request-count capacity.

The CLI waits by default. `--no-wait` returns after acceptance; use the returned
Operation id with:

```sh
debrute operation inspect <operation-id>
debrute operation wait <operation-id>
debrute operation cancel <operation-id>
debrute operation list --state active --model-kind image --limit 25
```

A standalone wait on an active Operation first emits
`event=operation.observed` with its current snapshot. A foreground request has
already emitted `operation.accepted`, so its follow-up wait does not repeat that
snapshot. Either wait then replays retained Batch Item Outcomes and follows new
ones until the Operation is terminal.

`--timeout` is a positive integer followed by `s`, `m`, or `h`. It bounds each
active Model Run, not queue time or output commit. The default is 30 minutes for
video and 10 minutes for image, TTS, music, and sound-effect. There is no
automatic retry. `--replace` applies only when actual generated files commit;
without it, an occupied target fails that Single or Batch Item.

When `output.directory` is absent, Runtime uses an Operation-unique directory.
When `output.filename` is absent, it generates a unique basename. One Artifact
named `covers` becomes `covers.<actual-extension>`; multiple Artifacts become
`covers_1.<ext>`, `covers_2.<ext>`, and so on. Runtime imposes no generic
Artifact-count ceiling.

Agent Records on stdout are the only CLI observation stream. A caller may
redirect a foreground request or `operation wait` when it needs to retain that
stream; the redirected bytes remain ordinary caller-owned command output.

## Models And Projects

Use the matching list and describe commands before building a request:

```sh
debrute models image list
debrute models image describe gpt-image-2
debrute models video list
debrute models tts list
debrute models music list
debrute models sfx list
```

Descriptions provide official source URLs, repository snapshots, Debrute
examples, and the authoritative `arguments_schema`. API keys remain in local
Runtime settings and must not be included in Model Request input.

Other common commands include:

```sh
debrute runtime status
debrute runtime doctor
debrute runtime stop
debrute skills status
debrute project init /path/to/project
debrute project validate /path/to/project
debrute workbench start /path/to/project --frontend desktop
debrute canvas-map push /path/to/project canvas-1
debrute generated-asset lookup /path/to/project --path generated/example.png
debrute commands
```

Project commands resolve the supplied root before crossing the local bridge.
Generic filesystem reads and writes remain the external Agent's responsibility.
See [Model generation](./model-generation.md), [Generated Assets](./generated-assets.md),
and [Product model](./product-model.md) for the underlying contracts.
