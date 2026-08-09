# Model Requests

This page records Debrute's current model catalog, configuration, execution,
and security boundaries. CLI syntax and examples remain in
[`cli.md`](./cli.md); durable metadata for successful outputs is documented in
[`model-artifacts.md`](./model-artifacts.md).

## Model Operations And Results

Every CLI Model Request is accepted as one current-Runtime Model Operation. A
Single contains one Model Request; a Batch contains one or more same-Kind Items
without creating child Operations. An Artifact Pointer identifies one committed
output by its zero-based response index and canonical absolute path, and may
carry display metadata; it does not contain file bytes.

Each accepted Model Operation is also projected into the Runtime-global
Activity stream and updated in place through its terminal state. The Activity
Card source label is **Model Request** for user-facing brevity; this presentation
label does not rename the authoritative Model Operation or turn an individual
Batch Item into an Operation. Single progress is indeterminate. Batch progress
uses the real settled Item count over total Item count. Cancelling is
indeterminate, and the internal `queued` handoff is presented as running rather
than exposing a queue state that Runtime does not otherwise provide.

Before acceptance, Runtime reads one Global configuration snapshot and creates
one immutable Accepted Model Binding for each unique Model ID in the Operation.
Repeated requests for the same Model share that binding. Every binding and
request must validate before Runtime creates the Operation; rejection creates
no Operation and starts no Model Request execution.

Debrute currently exposes Model Requests for images, videos, TTS, music, and
sound effects. It is not a generic text-LLM proxy and has no text-LLM catalog,
configuration, executor, CLI command, or Workbench settings surface.

Model Artifacts are implemented per Debrute Model. Brand or service names
inside a Model ID identify that exact integration; they do not create a shared
provider, account, credential, request, or response abstraction.

## Model Catalogs

The image, video, and audio Catalog is a compiled Runtime view over exact Model
contracts. Each Debrute Model owns one directory containing `definition.json`,
`manual.md`, its exact executor, and Model-specific evidence. The definition
contains only the stable ID, Model Kind, one concise selection summary, the
default base URL, the default request model ID, and the argument schema. Audio
Models own exactly one Kind: TTS, music, or sound effect.

The summary is the first-pass hard-screening surface. It uses short natural
language because constraints such as reference counts, dimensions, ratios, and
cross-field cases are not always represented accurately by one generic flag or
parameter name. The argument schema records the exact Model's known argument
names, shapes, and Debrute-owned defaults. The manual carries the detailed
construction guidance, official-source context, and examples without repeating
the summary.

`models ... list` is local configuration screening. It returns only catalog
entries whose Model ID has a configured API key and emits only `id` and
`summary`; it performs no network request and does not prove the key, account,
endpoint, or requested parameters will succeed. `models ... describe` emits the
selected `id`, serialized `arguments_schema`, and `manual_markdown`. Agents use
list to eliminate candidates that cannot meet hard requirements, then describe
only the remaining candidate to construct the exact request.

There is no separate capability table, list-parameter table, or standalone
central Catalog JSON. One explicit Rust composition root registers every exact
Model-owned contract and forms the unified in-memory Catalog view. Product
assembly compiles definitions and manuals into Runtime rather than packaging a
second editable or generated Catalog artifact.

Argument schemas use the selected Model's own parameter names. Debrute does not
invent a universal image-input schema or ask callers to construct an upstream
Seedance content array. Official primary documentation captured in the
Model-owned manual and deterministic Model-owned tests are the admission
evidence for a supported Catalog entry; source code from unrelated wrappers is
not authority.
Catalog schemas describe the fields Debrute knows; Runtime does not execute
their provider `required`, type, nested-shape, enum, range, cardinality, or
cross-field rules as local admission. They are also not an allowlist. Missing,
explicit `null`, malformed, and unlisted values are forwarded by that exact
Model adapter whenever they can reach the intended upstream position safely and
without coercion, guessing, overwriting, or loss. The remote endpoint remains
the authority on whether it supports the request.

An argument schema may declare a Model-owned default. Runtime recursively
materializes each such value before acceptance and executes the retained
canonical request; explicit values, including explicit `null`, are not replaced.
Defaults are reviewed per Model rather than inherited from a common field name
or Model Kind. Optional fields without a declared default remain absent, and an
acceptable provider-owned default is not redundantly copied into the Catalog.

## Model Configuration And Secrets

Every cataloged image, video, and audio model appears in Settings. One Model ID
may have:

- one optional base URL override;
- one optional request model ID override; and
- one Runtime-owned API key.

Null overrides use catalog defaults. A configured override is stored only when
at least one override differs from the default shape. The single API key is
stored separately by Model ID. Omitting `apiKey` from a save keeps the existing
key, a non-empty string sets or replaces it, and an empty string clears it.
There are no key lists, labels, enable switches, key rotation, provider-level
credential reuse, automatic key disabling, or retry with another key.

Model IDs and non-null overrides must already be canonical. Runtime rejects
leading or trailing whitespace instead of trimming request or persisted values;
Workbench may trim its editable text fields before submitting them. API keys
are opaque secrets: Runtime stores every non-empty value exactly as submitted
and never trims or interprets it. Persisted key-map entries must name a current
catalog Model and contain a non-empty value.

Non-secret model settings live as one Model-ID-keyed override list in
`<debruteHome>/config/global_settings.json`. All Model IDs are globally unique
across image, video, TTS, music, and sound effect Models, so
`<debruteHome>/config/secrets.json` stores one Model-ID-keyed API-key map rather
than repeating the Model Kind in separate maps. Runtime resolves the Model Kind
from the Catalog. The configuration directory is forced to mode `0700`; secret
writes use an atomic temporary file forced to `0600`. Reads and mutations share
the runtime's serialized global-configuration queue.

The public settings view projects that single stored collection into direct
`image`, `video`, and `audio` record arrays for Workbench presentation. A model
settings mutation identifies only the globally unique Model ID and its setting;
the caller does not also select a kind-specific mutation branch. Persisted files
using any other shape are invalid rather than migrated or repaired.

Public settings contain only `apiKeySet`; they contain neither plaintext nor a
credential-derived preview. The input is intentionally empty even when a key
already exists. When the user explicitly asks to reveal that stored key,
Runtime returns it only to the requesting authenticated Workbench connection in
a non-cacheable response. Workbench keeps it only in the visible settings
component and clears it when hidden or unmounted; the value never joins Global
settings, events, logs, Project data, or durable browser state. A base URL
override changes the endpoint used by that Debrute Model and its configured key;
it is an explicit per-model setting, not an origin-preserving provider
credential abstraction.

`minimax-h3` defaults to the global `https://api.minimax.io` contract. A user of
the China platform explicitly overrides it with `https://api.minimaxi.com` and
configures that regional account's key. Debrute neither treats the origins as
failover peers nor filters forwarded fields by origin; for example, the
China-documented `aigc_watermark` field may be supplied as an unlisted argument
and the selected endpoint decides whether to accept it.

An Accepted Model Binding keeps the effective base URL, request model ID, API
key, and Model Kind together for the lifetime in which its accepted Operation
can use them. Settings changes affect only later Operations; stopping pending
use in an accepted Operation requires explicit Operation cancellation. The
binding exists only in Runtime memory and never appears in public or terminal
Operation data, logs, Agent Records, Project data, or Model Artifact
provenance.

## Image Model Requests

Image requests use original model parameters and direct image values only where
the selected Model adapter maps them. The selected Model's description names
the exact argument fields that accept local paths. In one of those fields, an
ordinary string that is not a supported `data:` value, safe public `http(s)`
URL, or model-native reference is a local filesystem path. It may be absolute
or relative to the CLI's captured working directory. The adapter converts that
file only into the exact request representation owned by the selected Model.
There is no separate upload flag, CLI media-kind classification, universal
input schema, numbered reference code, or reference-sheet capability.

Runtime rejects only shapes it cannot transform safely and losslessly; it does
not reject an empty image array, a mask-only request, or an unknown parameter
name when the remote endpoint can make the authoritative decision.

When an adapter must download a public input URL into request bytes, Runtime
accepts only a `2xx` response; any other status fails that request without
treating the response body as media or substituting another input.

One shared image media registry defines first-class image formats across
Project classification, Canvas, Runtime MIME serving, image and video model
references, and generated-image extensions:

- PNG;
- JPEG, including `.jpg`, `.jpeg`, `.jpe`, and `.jfif`;
- WebP;
- AVIF;
- TIFF;
- SVG and SVGZ.

GIF, HEIC/HEIF, JPEG XL, JPEG 2000, RAW, PDF, and unlisted image-like formats are
not Project image formats. Photoshop transfer has a separate explicit
compatibility list. Debrute validates its own request structure, declared local
path fields, and supported local MIME contract, while model-specific byte size, dimensions,
aspect ratio, alpha, mask compatibility, and account limits remain upstream
constraints.

## Video Model Requests

Every video Model owns its request language. The three Seedance adapters expose
Debrute `prompt`, `intent`, and ordered `references`, then perform only the
structural transformation needed to build that exact Ark `content` request.
They reject an intent or reference shape only when no unique, lossless mapping
exists; reference counts, non-emptiness, and combinations are left to Ark. In
the reference fields declared by that Model, local image and audio paths may
become data URLs. A local video path still requires a model-reachable upload
boundary; safe public `http(s)` and `asset://` references can already be
upstream-reachable.

`minimax-h3` instead exposes the MiniMax Direct Generation fields `content`,
`resolution`, `duration`, `ratio`, and `callback_url` without a Seedance
intermediate language or generation defaults. Its native `image_url.url`,
`video_url.url`, and `audio_url.url` values preserve HTTP(S), data, and
`mm_file://` references. An existing recognizable local media file in one of
those same fields becomes a data URL. Local paths resolve against the captured
CLI working directory; other strings remain unchanged for MiniMax to judge.
`callback_url` belongs to a public notification service
owned by the caller, not to input upload or output download. Debrute forwards it
but still polls the task itself.

Task submission, polling, response parsing, primary video download, and optional
last-frame download belong to the exact video integration. The runtime does not
change intent, drop references, downgrade output, switch models, or fall back to
another request shape when validation or execution fails.

H3 success downloads `task.content.url` and commits exactly one video output.
Its Model-owned summary and manual record MiniMax's generated-audio behavior;
Runtime does not inspect for an embedded audio track, extract audio, or make
track presence a success condition.

## Audio Model Requests

Audio has three public Model Kinds:

- TTS;
- music; and
- sound-effect.

Every cataloged audio Model owns an independent adapter module even when another
Model uses the same service or a similar endpoint. Catalog resolution, Operation
filtering, timeout selection, and Model Kind retain the distinct TTS, music,
and sound-effect semantics. Shared code is limited to model-agnostic HTTP,
encoding, media detection, and Model Artifact utilities.

There is no generic `models audio` or `request audio` command. Kind mismatch,
missing key, and unknown model fail before the remote request. Provider-required
fields, provider JSON types, unknown parameter names, and business values are
sent to the remote endpoint whenever the exact adapter can place them without
loss. A local adapter error remains only when the value must control a
Debrute-owned URL path, query, response decoder, local-media transform, or
other mapping that cannot proceed without guessing or discarding caller data.

Each audio adapter owns its documented endpoint, request, response, and task
polling fields; the executor does not guess JSON paths or try a generic parser
before a model parser. Adapters return exact byte, base64, hex, or URL artifact
sources. Raw PCM remains raw PCM. Runtime does not add a container, transcode,
denoise, mix, normalize, split stems, or infer an unspecified output format.
Doubao Seed TTS 2.0 forwards an integer `audio_params.sample_rate` without a
local range allowlist; Qwen voice, OpenAI voice, and other required fields have
no manufactured adapter default.

## Remote Inputs And Downloads

Remote model inputs and artifact downloads that use Debrute's public-URL path
must be `http(s)`, contain no URL credentials, and resolve only to public network
addresses. Localhost, private/link-local addresses, unsafe IP literals, and
redirects to unsafe destinations are rejected. The transport uses the resolved
public address so hostname resolution cannot be changed after policy approval.

The full network and filesystem trust model is documented in
[`security.md`](./security.md).

This safety policy does not assert that a remote file satisfies a selected
model's physical constraints. Remote image URLs are not downloaded merely to
pre-validate their extension, dimensions, or byte size.

## Timeouts, Batch Execution, And Errors

Image, TTS, music, and sound-effect Model Request executions default to 10 minutes; video
defaults to 30 minutes. `--timeout` uses a positive `s`, `m`, or `h` duration and
bounds active Model execution, including task polling and Artifact download. It
does not bound queued Operation time or the short non-interruptible output
commit.

Accepted Operation cancellation remains authoritative for Debrute: it stops
unstarted Batch Items and cooperatively aborts local polling, downloads, and
later commits. Exact adapters also make one separately bounded, best-effort
remote cancellation attempt when their provider and last observed remote state
permit it: H3 and Seedance use DELETE before running is observed, and the two
FAL Stable Audio adapters use their trusted `cancel_url`. The remote request has
a fresh token, a five-second deadline, no retry, and no follow-up poll. Missing
support, a state race, rejection, timeout, or network failure is ignored, so
local `cancelled` never promises that provider computation stopped, a remote
record was deleted, or billing was reversed.

All five Model Kinds support Single and Batch. Single accepts either one strict
JSONL record or the direct `--model`, `--arguments`, and `--output` option set;
Batch is JSONL-only. Batch concurrency defaults to one and belongs only to that Operation;
Runtime has no global count-based Model Request execution capacity or waiting room. Every Item
runs once without automatic retry. Batch reaches `succeeded` when all accepted
Items settle, even when some Item Outcomes failed. Stdout emits sparse settled
Item records, and `operation wait` replays retained Item Outcomes before
following later ones. A caller that needs a file copy retains the Agent Record
stream with ordinary stdout redirection.

Model output naming is outside model `arguments`. Every request supplies
`output.directory` and `output.name`. Runtime resolves the directory against
the CLI's captured working directory and combines the basename with actual MIME
types at commit. Outputs sharing one actual extension receive their own
one-based suffix sequence; a sole output of an extension has no suffix. Without
`--replace`, publication is create-only; with it, the file present at commit is
replaced. Runtime commits the Item's output files first and restores changes if
that file commit fails. It then attempts Runtime-global provenance once for
each output. Provenance failure is one bounded Operation warning: it does not
roll back published files or change a successful Item into failure. A Runtime
or OS exit may leave a partial file commit and is not recovered when a Project
later opens that directory. A post-publication staging or replacement-restore
cleanup failure is also one bounded warning and never changes already-published
outputs into a failed Item.

Before acceptance, unknown or unconfigured models use `model_unavailable` and
Debrute-owned structural or safety failures use `invalid_input`. Unknown
parameter names, missing provider-required fields, and provider-invalid values
are not acceptance failures. After acceptance, task, timeout, request, unsafe
remote input, download, and filesystem causes become one bounded redacted log
on the failed Operation or Batch Item. A non-success HTTP response retains its
status and useful remote JSON or text error; model business errors retain the
remote code, message, and trace identifier when the exact response contract
supplies them. Runtime does not hide an upstream failure by switching Model ID,
endpoint, key, format, or adapter.

## Secret Redaction

The real upstream request uses the configured key, but every persistent or
returned diagnostic copy is redacted at the model-runtime boundary. The shared
redactor:

- replaces sensitive object fields;
- replaces every exact configured secret string;
- redacts credential-like HTTP query parameters; and
- replaces image, audio, and video data URL payloads while preserving their
  useful type prefix.

Model-specific compaction may additionally replace large inline image payloads
with compact shape information. Non-secret request structure, model arguments,
status, and upstream error shape remain available. Redaction happens before a
Model Request execution is exposed through Operation records or written into Runtime-global
provenance, rather than relying on UI masking or a later storage repair.

Secret storage, browser/Runtime authentication, and outward-facing redaction
surfaces are documented together in [`security.md`](./security.md).

## Executable Authorities

- Model Operation and Artifact Pointer shapes: `apps/runtime/src/model_operation.rs`.
- Exact Model definitions, manuals, executors, and Model-owned tests:
  `apps/runtime/src/models/<model>/`.
- Unified Model Catalog and exact executor registration:
  `apps/runtime/src/models/mod.rs`.
- Shared acceptance, redaction, public remote URL policy, and output commit:
  `apps/runtime/src/model_request/`.
- Global settings and secret persistence: `apps/runtime/src/global/`.
- Model Artifact provenance: `apps/runtime/src/model_request/provenance.rs`.
- CLI parsing, Runtime CLI services, and Agent Record rendering:
  `apps/runtime/src/cli/` and `apps/runtime/src/bin/debrute.rs`.
- Settings UI: `apps/web/src/workbench/settings/`.
- Source-backed coverage: Model-owned tests under `apps/runtime/src/models/`,
  shared-mechanism tests under `apps/runtime/src/model_request/`, and
  cross-boundary contracts under `tests/contracts/`.
