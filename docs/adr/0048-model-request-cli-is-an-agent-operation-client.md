# Model Request CLI Is An Agent Operation Client

Debrute CLI is an Agent-facing, non-interactive Model Operation client. It
writes only the line-oriented, unversioned Agent Record protocol and never
branches on TTY state or emits prompts, spinners, ANSI UI, or a second output
serialization.

## Request Sources

Single accepts exactly one of these sources:

```text
debrute request single --input <request.jsonl|->
debrute request single --model <id> --arguments <JSON-object> --output <JSON-object>
```

Combining `--input` with any direct request option is
`conflicting_request_sources`. A direct request requires all three options.
`--arguments` and `--output` must each decode as one JSON object. Batch remains
strict JSONL-only:

```text
debrute request batch --input <requests.jsonl|->
```

Single JSONL contains exactly one record and Batch contains one or more. Every
physical UTF-8 line is one complete Model Request object. Blank lines, comments,
a byte-order mark, arrays, pretty-printed multi-line objects, malformed records,
and a source above 16 MiB reject the whole submission before paid work begins.
The caller owns record correctness; CLI and Runtime add no duplicate-output-
path preflight or compatibility normalization.

Request commands have no Project positional and never open or bind a Project.
CLI captures its canonical working directory and submits it with the request.
Runtime resolves relative output directories and Model-declared local argument
paths against that directory. `--input` names a CLI-local file; Runtime receives
its bytes rather than reopening that path.

## Request Envelope

Every request has one closed envelope:

```json
{
  "model": "globally-unique-model-id",
  "arguments": {},
  "output": {
    "directory": "generated",
    "name": "covers"
  }
}
```

All three fields are required. `arguments` is the selected Model's opaque
object. It contains any input media path in the exact field declared by that
Model; CLI does not add upload flags, classify media, or construct a universal
input object. `output.directory` is an absolute or cwd-relative filesystem path.
`output.name` is an ordinary basename; it may contain periods but no path
separator and is never replaced by a generated fallback. Runtime appends the
actual MIME-derived extension at commit.

Model id selects the Model and therefore its Model Kind. Generate, edit,
extend, and other model-specific intents stay inside that Model's arguments;
they are not CLI subcommands or model-specific flags.

## Operation Options And Observation

Single and Batch share `--timeout`, `--replace`, and `--no-wait`; Batch alone
accepts positive `--concurrency`. The timeout covers active execution, not queue
time or the short output commit. Defaults are `30m` for video and `10m` for
image, TTS, music, and sound effect. There is no automatic retry.

By default submission prints acceptance and waits. `--no-wait` returns the
accepted Operation id. `operation inspect`, `operation wait`, and
`operation cancel` address that current-Runtime Operation. Disconnecting or
terminating the CLI ends only the observer; it never implies cancellation.
Transport loss after submission but before the id arrives is
`submission_outcome_unknown`, and CLI does not retry paid work.

Batch concurrency belongs only to that Batch. Runtime has no additional global
request-count scheduler. Batch Items settle independently and retain sparse
outcomes for `operation wait`; Batch terminal success means every accepted Item
settled, not that every Item succeeded.
