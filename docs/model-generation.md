# Model Generation

This page records Debrute's current model catalog, configuration, execution,
and security boundaries. CLI syntax and examples remain in
[`cli.md`](./cli.md); durable metadata for successful outputs is documented in
[`generated-assets.md`](./generated-assets.md).

## Model Operations And Results

Every CLI Model Request is accepted as one current-Runtime Model Operation. A
Single contains one Model Request; a Batch contains one or more same-Kind Items
without creating child Operations. An Artifact Pointer identifies a
Project-relative committed output and may carry display metadata; it does not
contain file bytes or an absolute path.

Before acceptance, Runtime reads one Global configuration snapshot and creates
one immutable Accepted Model Binding for each unique Model ID in the Operation.
Repeated requests for the same Model share that binding. Every binding and
request must validate before Runtime creates the Operation; rejection creates
no Operation and starts no Model Run.

Debrute currently exposes model generation for images, videos, TTS, music, and
sound effects. It is not a generic text-LLM proxy and has no text-LLM catalog,
configuration, executor, CLI command, or Workbench settings surface.

Generated file assets are implemented per Debrute Model. Brand or service names
inside a Model ID identify that exact integration; they do not create a shared
provider, account, credential, request, or response abstraction.

## Model Catalogs

Image, video, and audio catalogs are compiled product contracts. Each Debrute
Model owns a stable ID, selection guidance, official default base URL and request
model ID, concise list parameters, capabilities, a machine-readable argument
schema, usage notes, and a Debrute request example. Audio models additionally
own exactly one kind: TTS, music, or sound effect.

`models ... list` is local configuration screening. It returns only catalog
entries whose Model ID has a configured API key; it performs no network request
and does not prove the key, account, endpoint, or requested parameters will
succeed. `models ... describe` returns the selected catalog contract together
with official source URLs, a repository snapshot, captured documentation text,
and examples. Agents use list to choose a candidate and describe to construct
the exact request.

Catalog list parameters and argument schemas use the selected model's own
parameter names. Debrute does not invent a universal image-input schema or ask
callers to construct an upstream Seedance content array. Official documentation
snapshots and deterministic mocked tests are the admission evidence for a
supported catalog entry; source code from unrelated wrappers is not authority.
Catalog schemas describe and type-check the fields Debrute knows; they are not a
local allowlist. An unlisted parameter is forwarded by that exact Model adapter
to the remote endpoint instead of being rejected merely because its name is
new. The remote endpoint remains the authority on whether it supports the field.

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

An Accepted Model Binding keeps the effective base URL, request model ID, API
key, and Model Kind together for the lifetime in which its accepted Operation
can use them. Settings changes affect only later Operations; stopping pending
use in an accepted Operation requires explicit Operation cancellation. The
binding exists only in Runtime memory and never appears in public or terminal
Operation data, logs, Agent Records, Project data, or generated-asset
provenance.

## Image Generation

Image requests use original model parameters and direct image values only where
the selected Model adapter maps them. Known media fields may accept one or more
Project-relative paths, safe public `http(s)` URLs, supported image data URLs,
or an exact model-specific object shape. Runtime rejects only shapes it cannot
transform safely and losslessly; it does not reject an empty image array, a
mask-only request, or an unknown parameter name when the remote endpoint can
make the authoritative decision. There is no numbered reference-code or
reference-sheet capability.

When an adapter must download a public input URL into request bytes, Runtime
accepts only a `2xx` response; any other status fails that request without
treating the response body as media or substituting another input.

One static Project image registry defines first-class image formats across
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
compatibility list. Debrute validates its own request structure, Project paths,
and supported local MIME contract, while model-specific byte size, dimensions,
aspect ratio, alpha, mask compatibility, and account limits remain upstream
constraints.

## Video Generation

Video requests use Debrute-native `prompt`, `intent`, and `references`. The
selected model normalizer validates media types, counts, and intent, then builds
the exact upstream request internally. Project-local image and audio references
may become supported data URLs. A Project-local video reference requires the
runtime upload-service boundary; safe public `http(s)` and `asset://` references
can already be upstream-reachable.

Task submission, polling, response parsing, primary video download, and optional
last-frame download belong to the exact video integration. The runtime does not
change intent, drop references, downgrade output, switch models, or fall back to
another request shape when validation or execution fails.

## Audio Generation

Audio has three public Model Kinds:

- TTS;
- music; and
- sound-effect.

Every cataloged audio Model owns an independent adapter module even when another
Model uses the same service or a similar endpoint. Catalog resolution, Operation
filtering, timeout selection, and Artifact Role retain the distinct TTS, music,
and sound-effect semantics. Shared code is limited to model-agnostic HTTP,
encoding, media detection, and Project artifact utilities.

There is no generic `models audio` or `request audio` command. Kind mismatch,
missing key, unknown model, missing required arguments, and known fields with a
JSON shape the adapter cannot consume fail before the remote request. Unknown
parameter names and provider business values are sent to the remote endpoint.

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

Image, TTS, music, and sound-effect Model Runs default to 10 minutes; video
defaults to 30 minutes. `--timeout` uses a positive `s`, `m`, or `h` duration and
bounds active Model execution, including task polling and Artifact download. It
does not bound queued Operation time or the short non-interruptible output
commit.

All five Model Kinds support Single and Batch through the same strict JSONL
input. Batch concurrency defaults to one and belongs only to that Operation;
Runtime has no global count-based Model Run capacity or waiting room. Every Item
runs once without automatic retry. Batch reaches `succeeded` when all accepted
Items settle, even when some Item Outcomes failed. Stdout emits sparse settled
Item records, and `operation wait` replays retained Item Outcomes before
following later ones. A caller that needs a file copy retains the Agent Record
stream with ordinary stdout redirection.

Model output naming is outside model `arguments`. Runtime combines optional
Project-relative `output.directory` and extension-free `output.filename` with
actual Artifact count and MIME type at commit. Without `--replace`, publication
is create-only; with it, the file present at commit is replaced. A Model Run's
files and Generated Asset provenance form one in-process Item commit. Ordinary
errors restore outputs changed by that Item, while a Runtime or OS exit may
leave partial state and is not recovered on Project open.

Before acceptance, unknown or unconfigured models use `model_unavailable` and
Debrute-owned structural or safety failures use `invalid_input`. Unknown
parameter names are not an acceptance failure. After acceptance, task, timeout,
request, unsafe remote input, download, and filesystem causes become one bounded
redacted log on the failed Operation or Batch Item. A non-success HTTP response
retains its status and useful remote JSON or text error; model business errors
retain the remote code, message, and trace identifier when the exact response
contract supplies them. Runtime does not hide an upstream failure by switching
Model ID, endpoint, key, format, or adapter.

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
Model Run is recorded as Project metadata, rather than relying on UI masking or
the generated-asset service to repair unsafe data later.

Secret storage, browser/Runtime authentication, and outward-facing redaction
surfaces are documented together in [`security.md`](./security.md).

## Executable Authorities

- Model Operation and Artifact Pointer shapes: `apps/runtime/src/model_operation.rs`.
- Catalogs and model settings views: `apps/runtime/src/global/models.rs` and
  `assets/runtime-model-catalog.json`.
- Exact model execution, adapters, redaction, public remote URL policy, and
  output commit: `apps/runtime/src/generation/`.
- Official model documentation: `assets/model-docs/snapshots/` and
  `apps/runtime/src/cli/model_docs.rs`.
- Global settings and secret persistence and generated-asset recording:
  `apps/runtime/src/global/` and `apps/runtime/src/project/generated_assets.rs`.
- CLI parsing, Runtime CLI services, and Agent Record rendering:
  `apps/runtime/src/cli/` and `apps/runtime/src/bin/debrute.rs`.
- Settings UI: `apps/web/src/workbench/settings/`.
- Source-backed coverage: colocated tests, `tests/contracts/`, and
  `apps/runtime/src/generation/` tests.
