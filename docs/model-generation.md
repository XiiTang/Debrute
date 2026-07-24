# Model Generation

This page records Debrute's current model catalog, configuration, execution,
and security boundaries. CLI syntax and examples remain in
[`cli.md`](./cli.md); durable metadata for successful outputs is documented in
[`generated-assets.md`](./generated-assets.md).

## Capability Results

Model generation is a Capability family. A Capability returns one structured
success or error result with outputs and optional Artifact Pointers and logs.
An Artifact Pointer identifies a Project-relative output and may carry display
metadata; it does not contain file bytes or an absolute path.

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

## Model Configuration And Secrets

Every cataloged image, video, and audio model appears in Settings. One Model ID
may have:

- one optional base URL override;
- one optional request model ID override; and
- one write-only API key.

Null overrides use catalog defaults. A configured override is stored only when
at least one override differs from the default shape. The single API key is
stored separately by Model ID. Omitting `apiKey` from a save keeps the existing
key, a non-empty string sets or replaces it, and an empty string clears it.
There are no key lists, labels, enable switches, key rotation, provider-level
credential reuse, automatic key disabling, or retry with another key.

Non-secret model settings live in
`<debruteHome>/config/global_settings.json`. Image, video, and audio key maps
live in `<debruteHome>/config/secrets.json`. The configuration directory is
forced to mode `0700`; secret writes use an atomic temporary file forced to
`0600`. Reads and mutations share the runtime's serialized global-configuration
queue.

Public settings contain only `apiKeySet` and a masked `apiKeyPreview`; plaintext
keys never return to Workbench. The input is intentionally empty and write-only
even when a key already exists. A base URL override changes the endpoint used by
that Debrute Model and its configured key; it is an explicit per-model setting,
not an origin-preserving provider credential abstraction.

## Image Generation

Image requests use original model parameters and direct image values only where
the selected catalog schema declares them. Supported fields may accept one or
more Project-relative paths, safe public `http(s)` URLs, supported image data
URLs, or an exact model-specific object shape. Missing paths, wrong single/array
shape, unsupported objects, empty image arrays, and masks without required
images fail before the upstream request. There is no numbered reference-code or
reference-sheet capability.

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

Audio has one shared internal execution family and three separate public kinds:

- `models tts` and `generate tts`;
- `models music` and `generate music`;
- `models sfx` and `generate sfx`.

There is no generic `models audio` or `generate audio` command. Kind mismatch,
missing key, unknown model, undeclared arguments, missing required arguments,
and formats outside the selected catalog entry fail before adapter execution.

`executeAudioModelRequest` coordinates one exact Model ID adapter. Each adapter
owns its documented endpoint, request, response, and task polling fields; the
executor does not guess JSON paths or try a generic parser before a model parser.
Adapters return explicit byte, base64, or URL artifact sources. Low-level shared
code may safely download public URLs and wrap documented PCM parameters in a WAV
container, but it does not transcode, denoise, mix, normalize, split stems, or
infer unknown formats.

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

Single image, video, and audio generation default to a 600-second request budget
covering the model lifecycle and artifact handling. Callers may provide a
positive command timeout.

Image batches use Runtime's `generate image-batch` path. The Project opens once;
Runtime expands a `{ "requests": [] }` manifest or
JSONL source, runs one fixed global worker pool, executes each item once, and
uses a 900-second default timeout for each item. Existing non-empty outputs
are skipped unless overwrite is explicit. Final item outcomes go to the required
JSONL log, an optional summary file receives the aggregate, and stdout remains
sparse Agent-record progress plus the final aggregate. The CLI does not reopen
the Project, spawn one process, or own a scheduler per item.

Unknown models, missing configuration, invalid arguments, task failure, timeout,
request failure, unsafe remote input, download failure, and filesystem failure
retain structured error codes and logs. The runtime does not hide an upstream
failure by switching Model ID, endpoint, key, format, or adapter.

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

- Capability result and Artifact Pointer shapes: `packages/capability-core/src/`.
- Catalogs and model settings views: `apps/runtime/src/global/models.rs` and
  `assets/runtime-model-catalog.json`.
- Exact model execution, adapters, redaction, public remote URL policy, and
  image-batch execution: `apps/runtime/src/generation/`.
- Official model documentation: `assets/model-docs/snapshots/` and
  `apps/runtime/src/cli/model_docs.rs`.
- Global settings and secret persistence and generated-asset recording:
  `apps/runtime/src/global/` and `apps/runtime/src/project/generated_assets.rs`.
- Shared request/settings/generated-asset protocol shapes:
  `packages/app-protocol/src/`.
- CLI parsing, Runtime CLI services, and Agent Record rendering:
  `apps/runtime/src/cli/` and `apps/runtime/src/bin/debrute.rs`.
- Settings UI: `apps/web/src/workbench/settings/`.
- Source-backed coverage: colocated tests, `tests/contracts/`, and
  `apps/runtime/src/generation/` tests.
