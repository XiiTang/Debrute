# Capability

The Capability context names runtime-backed operations and the structured results
they return to Workbench or Agent-facing command surfaces.

## Language

**Capability**:
A discrete runtime-backed operation with a structured success or error result.
Model-backed generation is one capability family; generic filesystem access is
not.
_Avoid_: Workflow, Agent tool

**Artifact Pointer**:
A structured capability-result reference to an output at a project-relative path,
optionally carrying presentation metadata.
_Avoid_: File contents, absolute path

**Debrute Model**:
A cataloged model-specific generation integration addressed by one stable Model
ID and one exact request and result contract.
_Avoid_: Provider, account, generic model adapter

**Configured Model**:
A Debrute Model with a locally stored API key, eligible for model discovery and
execution; routing overrides are optional.
_Avoid_: Enabled model, available provider

**Model Run**:
One generation invocation whose redacted request and output can be shared by
multiple resulting Generated Assets.
_Avoid_: Provider call, Agent turn

**Generated Asset**:
A Project file produced by a Model Run and associated with durable provenance by
its complete content fingerprint.
_Avoid_: Capability result, generated path

**Artifact Role**:
The meaning and ordering of one Generated Asset within a Model Run, such as a
primary image, primary video, last frame, TTS audio, music, or sound effect.
_Avoid_: MIME type, provider output kind
