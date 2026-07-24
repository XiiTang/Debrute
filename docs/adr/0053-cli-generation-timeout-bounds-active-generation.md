# CLI Generation Timeout Bounds Active Generation

Generation commands replace the ambiguous whole-request timeout with a
dedicated active-generation timeout. It bounds one continuous active phase:
from invoking the Debrute Model through submission, provider-job polling,
response reads, and generated-artifact download. It does not include lane
queueing, Project commit, cleanup, or CLI observation. A single Operation uses
one clock rather than resetting it for individual HTTP requests. An image batch
uses an independent clock for each item; its top-level value is the item
default, and an item may provide its own override.

Runtime defines a default and hard maximum for each Generation Kind. An omitted
value uses the Runtime default. CLI may provide a positive value no greater
than that maximum; an excessive value is rejected before Operation acceptance
rather than silently clamped. The effective value is part of canonical
Operation input, so changing it for an already bound Operation id is an input
conflict. Exact option and error names belong to the implemented CLI contract.

Expiration produces a typed phase-deadline failure and kind-owned cleanup. A
single generation Operation fails; a batch records a failed item and continues to
settle its other items under the batch-success contract. This preserves Agent
control over paid model waiting without reintroducing a queue, whole-Operation,
or observer timeout.
