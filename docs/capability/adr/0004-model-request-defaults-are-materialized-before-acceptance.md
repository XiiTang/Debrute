# Model Request Defaults Are Materialized Before Acceptance

Each optional Model Request argument that has a Debrute default declares that
value in its Debrute Model catalog schema. Runtime materializes omitted defaults
before validating and accepting a Single or Batch Model Request, so the
canonical request retained by the Model Operation, consumed by the exact model
adapter, and recorded in redacted Model Run provenance has one complete shape.
This was chosen over provider-owned defaults and adapter-local insertion so
Agent documentation, validation, execution, observation, and provenance cannot
silently disagree. Explicit Agent values are never replaced, and default
materialization is not a retry or failure fallback. A required argument cannot
be omitted; an optional argument without a default remains absent. Explicit
`null` never means omission and never activates a default. A model schema may
accept `null` only when that model's official contract gives it a distinct
meaning; otherwise Runtime rejects it like any other unsupported value.

A declared default always exists in the canonical request. Materialization is
recursive and creates a missing object path when a descendant property declares
a default. Catalog authors therefore reserve defaults for the minimum stable
values needed to make Debrute's executable request or generated-artifact
contract unambiguous, such as a response transport or output file format. A
creative option, optimization feature, or tuning control that is not always
intended does not receive a default merely because the provider has one; it
remains absent unless the Agent selects it.

A default may also state an intentional normal-artifact property rather than
copy a provider default. For example, a Debrute Model may materialize an
officially supported `watermark: false` so ordinary generated media remains
free of an optional provider watermark even if the provider changes its own
regional or regulatory default. Such a value is still reviewed as part of that
exact Debrute Model contract and an explicit Agent value wins.

Default selection remains part of each Debrute Model's exact contract. Runtime
does not infer a default from a common argument name, copy one model's value to
another model, or impose a Model Kind-wide default such as `n: 1`. Each value is
reviewed against that model's provider contract, adapter behavior, artifact
semantics, cost, and recommended Agent use before it enters the Catalog.

Catalog authors do not materialize a value merely to repeat a provider default
that already produces Debrute's desired normal behavior. When omission is
unambiguous and the provider-owned value is acceptable, the canonical Model
Request keeps the argument absent and the Agent manual documents the provider's
current behavior. Debrute materializes only when it needs to choose a different
value, guarantee a product-owned request or artifact invariant, or remove an
otherwise ambiguous executable result. The explicit watermark-free artifact
decision is one such invariant; matching a provider's ordinary JPEG preference
is not.
