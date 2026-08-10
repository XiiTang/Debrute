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

Named `operation`, `batch_item`, `artifact`, `model`, and `diagnostic` records
follow on separate lines. Error records may contain a redacted `log`; they do
not have a generic message field. Exit status is deliberately coarse: `0`
means success, `2` means CLI syntax or input is invalid, and `1` means every
other failure. An invalid command root is caller input and also exits `2`. A Batch
whose accepted Items all settled is successful even when
some Items failed, so its final Operation record exits `0` and reports the Item
failures in progress records.

A diagnostic record presents either one Project Diagnostic or one Model
Operation warning. Both carry severity, code, and message. A Project Diagnostic
may add Project path and stable id; an Operation warning may add Batch item
index. The record has no source field because its surrounding command and
parent record identify its owner.

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

The CLI adapter is a required part of every ready Runtime. The CLI can inspect
its managed Product identity through diagnostics, but it cannot discover,
install, continue, or retry a Product update. Product installation belongs to
the platform Product Installer; Runtime owns installation, update discovery,
and durable Product transactions.

## Product Removal

The non-interactive whole-Product removal command is:

```sh
debrute product uninstall --yes [--keep-config]
```

`--yes` is required; without it the parser returns `missing_argument` before
Runtime is contacted. The command starts or connects to the installed Runtime,
submits one removal request, and exits after Runtime accepts the transaction.
Success reports `accepted=true` and the selected `configPreserved` value; it
does not claim that asynchronous self-removal has already finished.

Removal deletes Desktop, Runtime, the managed CLI, official `debrute-*` Skills,
and all of `~/.debrute` by default. `--keep-config` retains only
`config/global_settings.json` and `config/secrets.json`, including saved API
keys. Project contents are never part of this command's removal scope.
`debrute runtime stop` remains a non-destructive Product Quit command.

## Workbench URLs

`workbench url` returns the exact current credential-free Workbench URL without
activating a frontend:

```sh
debrute workbench url [<project>]
```

The command ensures Runtime is Ready, then sends the CLI-only
`resolve_workbench_root_url` Control request. Runtime returns only the current
Root Workbench URL, selecting the packaged origin or the currently registered
source-development origin. No Project path crosses Control.

With a Project argument, the CLI resolves a relative value against its
canonical invocation working directory and appends the Project route locally.
It does not inspect, canonicalize, or require the target path to exist. The
selected Workbench performs Project admission later. URL resolution does not
open or focus a browser or Desktop window, create a Workbench connection or
Project binding, or change Recent Projects.

Success is one standard Agent Record with no fields other than `url`:

```text
debrute ok cmd=workbench.url
url="http://127.0.0.1:<port>/open?path=..."
```

`workbench start [<project>] --frontend desktop|browser` remains the explicit
frontend-activation command. Its `outcome=opened` reports that the selected
frontend was activated; it does not assert that a Project was admitted.

## Model Requests

Single accepts either one strict UTF-8 JSONL record or one request written
directly as CLI options:

```json
{"model":"gpt-image-2","arguments":{"prompt":"Cover image"},"output":{"directory":"generated","name":"cover"}}
```

`model` is a globally unique Debrute Model id. `arguments` contains only the
selected Model's arguments, including local media paths in the exact fields
declared by that Model. Required `output.directory` and `output.name` are
separate publication fields. `directory` is absolute or relative to the CLI
working directory. `name` is an ordinary basename without a path separator;
Runtime derives the extension from each actual Artifact MIME type.

```sh
debrute request single --input request.jsonl
debrute request single \
  --model gpt-image-2 \
  --arguments '{"prompt":"Cover image"}' \
  --output '{"directory":"generated","name":"cover"}'
debrute request batch --input requests.jsonl --concurrency 3
cat request.jsonl | debrute request single --input - --timeout 10m
```

Input is exactly one JSONL record for `single` and one or more records for
`batch`. Blank lines, comments, a UTF-8 BOM, JSON spanning multiple lines, and
input above 16 MiB are rejected. All Batch records must resolve to the same
Model Kind. Batch concurrency defaults to `1` and controls only that Batch;
Runtime has no additional global request-count capacity.

`request single` rejects `--input` combined with any of `--model`,
`--arguments`, or `--output` as `conflicting_request_sources`. Direct options
must supply all three values, and both JSON option values must be objects.
Batch remains JSONL-only. The caller is responsible for the contents of every
JSONL record; the CLI does not add a duplicate-output-path preflight layer.

The CLI captures its canonical working directory when it submits the
Operation. Runtime resolves `output.directory` and every Model-declared local
path in `arguments` against that directory. Model Requests have no Project
positional and do not open or bind a Project.

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
active Model Request execution, not queue time or output commit. The default is 30 minutes for
video and 10 minutes for image, TTS, music, and sound-effect. There is no
automatic retry. `--replace` applies only when actual generated files commit;
without it, an occupied target fails that Single or Batch Item.

For each actual extension independently, one Artifact named `covers` becomes
`covers.<actual-extension>`; multiple Artifacts of that extension become
`covers_1.<ext>`, `covers_2.<ext>`, and so on. For example, two MP4 and two JPEG
outputs become `covers_1.mp4`, `covers_2.mp4`, `covers_1.jpg`, and
`covers_2.jpg`. Runtime does not classify outputs before their actual MIME
types are known and imposes no generic Artifact-count ceiling.

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

Each list command returns only exact Models that currently have an API key in
local Runtime settings. Every record contains only the Model `id` and its short
selection `summary`; listing is a local screening step and does not contact the
remote endpoint or prove that the key is valid.

Each describe command reads the selected exact Model definition directly and
returns only its `id`, authoritative `arguments_schema`, and complete
`manual_markdown`. The schema supplies the machine-readable request surface;
the manual owns detailed constraints, examples, and source-backed usage
guidance. API keys must not be included in Model Request input.

Other common commands include:

```sh
debrute runtime status
debrute runtime stop
debrute product uninstall --yes
debrute skills status
debrute project status /path/to/project
debrute project validate /path/to/project
debrute workbench url /path/to/project
debrute workbench start /path/to/project --frontend desktop
debrute model-artifact lookup --path generated/example.png
debrute commands
```

`runtime status` reports only Runtime lifecycle state. Model availability is
reported by the matching `models ... list` command instead.

Project roots and Model Artifact lookup paths may be absolute or relative to the
CLI working directory. The CLI makes root arguments absolute; commands that
admit a Project then use its canonical absolute path. Generic filesystem reads
and writes remain the external Agent's responsibility.
See [Model Requests](./model-requests.md), [Model Artifacts](./model-artifacts.md),
and [Product model](./product-model.md) for the underlying contracts.
