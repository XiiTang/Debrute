# Capability

The Capability context names runtime-backed operations and the structured results
they return to Workbench or Agent-facing command surfaces.

## Language

**Capability**:
A discrete product ability exposed through Runtime with a structured success or
error result. Model execution is one Capability family; generic
filesystem access is not.
_Avoid_: Workflow, Agent tool

**Runtime Operation**:
One accepted, finite, user-visible Capability execution whose lifetime belongs
to the current Runtime instance rather than the initiating client connection.
_Avoid_: Model Request, Task, Job, Workflow, Model Run

**Model Operation**:
A Runtime Operation that executes one Single Model Request or one same-kind
Batch of Model Requests.
_Avoid_: Model Request, Generation Operation

**Model Request**:
One invocation input for a Debrute Model. It becomes part of a Model Operation
only after Runtime accepts it.
_Avoid_: Runtime Operation, universal Generate or Edit action

**Model Request Default**:
A Debrute Model-owned value for an omitted optional argument that becomes part
of the accepted Model Request. It is distinct from a provider-owned default or
a failure fallback.
_Avoid_: Provider default, Adapter default, fallback value

**Model Kind**:
The peer catalog category of a Debrute Model: image, video, TTS, music, or sound
effect. It does not describe whether a request generates, edits, or performs
another model-specific action.
_Avoid_: Audio, Image Batch, Execution Shape

**Execution Shape**:
Whether one Model Operation executes a Single Model Request or a Batch of Model
Requests; every Model Kind supports both shapes.
_Avoid_: Model Kind, Job Type

**Batch Item**:
One independently settled Model Request inside a Batch Model Operation.
_Avoid_: Child Operation, Sub-operation

**Batch Item Outcome**:
The successful or failed result of one settled Batch Item, retained with its
Model Operation for current-Runtime wait replay. It is result data rather than
a child lifecycle state and disappears when the Operation record retires.
_Avoid_: Batch Result file, child Operation, durable history

**Artifact Pointer**:
A structured capability-result reference to a generated Project file and the
media facts needed to consume it immediately. Provenance remains Generated
Asset metadata rather than part of this result reference.
_Avoid_: File contents, absolute path

**Debrute Model**:
A cataloged creative-model integration identified by one stable Model ID and
one exact request and result contract. Every Debrute Model remains a peer,
including Models in the same Model Kind.
_Avoid_: Provider, account, generic model adapter

**Configured Model**:
A Debrute Model with a locally stored API key, eligible for model discovery and
execution; routing overrides are optional.
_Avoid_: Enabled model, available provider

**Accepted Model Binding**:
The immutable effective route and credential bound to one Debrute Model for one
accepted Model Operation.
_Avoid_: Live model settings, per-request configuration copy

**Model Run**:
One execution of a Model Request whose redacted input and output can be shared
by multiple resulting Generated Assets.
_Avoid_: Provider call, Agent turn

**Generated Asset**:
A Project file produced by a Model Run and associated with that run's durable
provenance.
_Avoid_: Capability result, generated path

**Artifact Role**:
The meaning and ordering of one Generated Asset within a Model Run, such as a
primary image, primary video, last frame, TTS audio, music, or sound effect.
_Avoid_: MIME type, provider output kind
