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
_Avoid_: Model Request, Task, Job, Workflow

**Model Operation**:
A Runtime Operation that executes one Single Model Request or one same-kind
Batch of Model Requests.
_Avoid_: Model Request, Generation Operation

**Model Request**:
One invocation input for a Debrute Model. It becomes part of a Model Operation
only after Runtime accepts it. It carries model-specific arguments and an output
intent, and has no Project binding.
_Avoid_: Runtime Operation, universal Generate or Edit action

**Invocation Working Directory**:
The local directory from which a Model Operation is submitted. It provides the
meaning of relative local paths and is not Project identity.
_Avoid_: Project root, process-global mutable cwd

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
A structured Capability result that refers to one Model Artifact without
containing the Artifact's bytes or provenance.
_Avoid_: File contents, project-relative path

**Debrute Model**:
A cataloged creative-model integration identified by one stable Model ID and
one exact request and result contract. Every Debrute Model remains a peer,
including Models in the same Model Kind.
_Avoid_: Provider, account, generic model adapter

**Model Contract Parity**:
The product direction of aligning one exact Debrute Model as closely as
practicable with the complete official generation request and response contract
of the upstream Model it identifies. Provider account, billing, credential, and
unrelated management APIs are outside that contract. Known limitations remain
explicit, while safe unknown-field pass-through does not by itself prove
documented parity.
_Avoid_: Best-effort adapter, undocumented subset, unknown-field pass-through

**Model Catalog**:
The Runtime-owned, versioned collection of exact Debrute Model discovery
metadata, Debrute defaults, and request-schema documentation shipped with the
product. It describes supported contracts; it is neither an upstream provider
catalog nor executable provider-business-rule validation.
_Avoid_: Provider model list, executable schema

**Model Selection Summary**:
A concise, source-backed natural-language description that lets an Agent rule a
configured Debrute Model in or out before reading its complete manual. It states
selection-relevant hard capabilities and constraints rather than reproducing a
parameter schema.
_Avoid_: Capability map, parameter list, marketing summary

**Model Manual**:
The source-backed, complete Agent-facing guide for one exact Debrute Model,
returned after selection to explain its detailed request, constraints, example,
and result behavior. It identifies its official sources and capture date without
repeating the Model Selection Summary.
_Avoid_: Provider documentation, list summary, executable schema

**Configured Model**:
A Debrute Model with a locally stored API key, eligible for model discovery and
execution; routing overrides are optional.
_Avoid_: Enabled model, available provider

**Accepted Model Binding**:
The immutable effective route, credential, argument-default schema, and exact
executor bound to one Debrute Model for one accepted Model Operation.
_Avoid_: Live model settings, per-request configuration copy

**Model Artifact**:
An ordinary file produced by a Model Request and optionally associated with
provenance for its current contents.
_Avoid_: Artifact Pointer, Project record

**Artifact Index**:
The response order of one Model Artifact within a Model Request result.
_Avoid_: Provider output label
