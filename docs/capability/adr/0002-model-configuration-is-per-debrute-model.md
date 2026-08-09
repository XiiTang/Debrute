# Model Configuration Is Per Debrute Model

Every supported Model Request integration is addressed by one Debrute Model ID
with catalog defaults, optional endpoint and request-model overrides, and one
write-only API key stored for that same ID. This was chosen over provider-level
accounts, shared credentials, key pools, enable switches, and generic request
adapters so list, describe, readiness, execution, and errors refer to the exact
model contract the runtime implements. The trade-off is that one upstream
credential may need to be entered for multiple Model IDs and endpoint overrides
explicitly change where that model's configured key is used.

At Model Operation acceptance, Runtime reads one Global configuration snapshot
and binds the complete effective route and credential once for every unique
Model ID in the submission. Requests for the same Model share that Accepted
Model Binding. Runtime also binds that exact Model's argument-default schema and
executor at the same lookup; execution does not dispatch again by Model Kind or
Model ID. The binding is not a credential reference: later Settings changes
affect only later Operations, while explicit Operation cancellation revokes
pending use already accepted. It remains private Runtime memory and is not
retained with terminal Operation data.

The same ownership boundary applies to implementation and documentation. Each
Debrute Model owns one Catalog schema, one Agent manual contract, one request
constructor, one response parser, and its exact fixtures. Two Models do not
share a provider-family or near-identical semantic adapter, even when their
current endpoints and most parameters happen to match. Their fields, defaults,
wire formats, and response rules are allowed to evolve independently without a
model switch accumulating inside shared code. Some deliberate duplication is
the cost of keeping those contracts closed and separately reviewable.

The exact Model module is the sole machine-consumable authority for those
Model-specific semantics. Central coordination may enumerate exact Model
definitions and provide model-agnostic mechanisms, but it does not maintain a
second Model-ID switch that selects Catalog, Agent manual, request, response, or
fixture behavior. Public documentation, official source snapshots, and
black-box contract tests may repeat a stable public Model ID without becoming a
second Runtime authority.

All Model-specific source for one exact Model lives in one Model-owned
directory: its Catalog source, Agent manual snapshot, request and response
implementation, and exact fixtures. That directory is the Model's physical
ownership and deletion unit; no provider-family directory owns semantic
implementation shared by multiple Models.

The Catalog source is one `definition.json` in that directory. The exact Rust
module binds the parsed definition to its manual and executor; the explicit
central composition root only enumerates those complete module definitions.
The exact Debrute request example belongs in the detailed manual rather than
being duplicated as Catalog data.

Every `definition.json` has the same minimal required shape: exact Debrute
Model `id`, `kind`, Model Selection `summary`, `defaultBaseUrl`,
`defaultRequestModelId`, and `argumentsSchema`. The summary field is the one
Model Selection Summary rather than a second marketing description. The route
defaults participate in Accepted Model Binding and remain overridable through
Settings. The schema carries the complete official generation argument shape
that Debrute can execute, plus only defaults that Debrute itself selects and
materializes. Manual paths and executor symbols are fixed by the sibling module
instead of represented as JSON data; configuration state such as whether an API
key is set does not belong to the definition.

Migration to this ownership model is one complete product cutover. Development
may move and verify Model directories in smaller steps, but the enabled product
does not combine the new registry with the former central Catalog or fall back
to a provider-family executor when an exact definition is missing. The cutover
registers every supported Model through the new composition root, switches all
Catalog, Settings, CLI, acceptance, and execution consumers, and removes the
former semantic authorities in the same completed change. There is no
compatibility reader, dual registration, or old-path fallback.

Existing Debrute Model IDs remain stable across this structural migration unless
current official evidence establishes that an ID is factually wrong for the
exact Model the executor implements. A mistaken upstream request identifier is
corrected in `defaultRequestModelId` without renaming the Debrute Model when its
product identity remains accurate. Cosmetic renaming is out of scope. A retired
Model is not silently retargeted to its successor: the retired exact Model is
removed and the successor is introduced as a new exact Model. Corrected or
removed IDs receive no alias or compatibility fallback.

Every exact Debrute Model pursues Model Contract Parity with the complete
official generation request and response contract of the upstream Model it
identifies. Its definition, manual, executor, and fixtures expand toward that
official surface rather than treating a convenient permanent subset as the
product goal. Provider account, billing, credential, and unrelated management
APIs remain outside the Model contract. Debrute-owned safety, resource,
Operation, and Artifact boundaries still apply. A known limitation remains
explicit rather than hidden by omission, but it does not prevent safe,
lossless unknown arguments from passing through to the official endpoint.
Pass-through alone is not evidence that Debrute has documented or verified the
corresponding capability.

Each exact Model's `manual.md` is its complete Model Manual, including official
sources and capture date, detailed constraints, the exact Debrute command and
request example, and result behavior. It does not repeat the Model Selection
Summary. Describe returns that Model-owned content; central CLI code neither
registers manuals by Model ID nor assembles Model-specific prose.

Each exact Model directory also owns its request, response, error, and Artifact
fixtures and the tests that apply them to that Model's executor. Shared test
mechanics may provide fake HTTP and media adapters without knowing a Model ID or
provider field. Central registry tests assert only cross-Model structure such as
unique IDs, complete definitions, and list and describe projections; they do
not contain provider request or response expectations.

Each exact Model's Catalog source is authored with that Model. Runtime forms the
unified Model Catalog view directly from those exact Model-owned sources. The
Product does not maintain or ship a standalone central Model Catalog JSON, and
the Product Manifest exposes no `modelDocs` file entrypoint. Runtime and its CLI
remain the machine interface for Model discovery and description; Settings and
contract tests consume the same Runtime-owned definitions.

Model definitions and Settings projections contain only fields with a current
product consumer. They do not carry parallel `supports*` flags, capability
maps, parameter-list summaries, or unconsumed `chooseWhen`, `avoidWhen`, and
`usageNotes` copies. Each exact Model owns one source-backed natural-language
Model Selection Summary. Configured-Model list commands return its ID and that
summary for first-pass Agent screening; describe commands add the complete
argument schema and Model Manual. The describe result contains only the exact
Model ID, that machine-readable schema, and the Model-owned manual; official
sources and the Debrute example appear only inside the manual.

The exact Model executor owns the semantic translation from accepted Debrute
arguments to that Model's request and from its response or error back to common
Artifact payloads and safe request metadata. This includes the endpoint suffix,
authentication headers, provider field names, media placement, response paths,
and Model-specific error interpretation. It does not name, stage, publish, or
roll back final Artifact files.

Only model-agnostic execution and delivery mechanisms may be shared: deadline
and cancellation handling, HTTP transport, safe local and public resource
loading, request and output limits, Base64 and data-URL decoding, MIME
detection, bounded redacted logs, nonempty-output checks, Artifact naming and
staging, atomic commit and rollback, and provenance. A shared mechanism stops
being model-agnostic when it knows a Model ID or provider field, default,
endpoint choice, response path, or error structure; that behavior belongs in
the exact Model executor instead.
