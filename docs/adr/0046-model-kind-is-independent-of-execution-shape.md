# Model Kind Is Independent Of Execution Shape

Debrute Models have five peer `ModelKind` values: `image`, `video`, `tts`,
`music`, and `sound-effect`. `audio` is an implementation and settings group
for the latter three, not a Model Kind. Every Model Operation also has an
orthogonal `ExecutionShape` of `single` or `batch`; a shape never becomes
another Model Kind.

The Runtime dispatches `tts`, `music`, and `sound-effect` directly into that one
internal audio execution family. Empty per-Kind forwarding modules would not
preserve a domain boundary: catalog resolution, the resolved Model Kind, and
the resulting Artifact Role already retain the three distinct contracts.

The closed protocol accepts both `single` and `batch` for all five kinds.
Kind-specific Batch Item input and result variants remain closed and validated
during `SubmitModelOperation` before an Operation is accepted; shared execution
shape does not erase the different model contracts. Every Model Request names
one globally unique Debrute Model. Runtime resolves its Model Kind from the
model catalog rather than requiring the CLI to repeat the kind.

A Single contains one Model Request. A Batch may contain requests for different
models, but every named model must resolve to the same Model Kind. Mixed-kind
input is rejected atomically before the Operation is accepted. The intent to
generate, edit, extend, or perform another supported action remains part of
each model's closed request contract. Runtime does not impose a universal
cross-model action field or infer the Operation's Execution Shape from the
input serialization.

Both shapes create exactly one Model Operation. Batch Items are internal typed
work items of that Operation, share its cancellation boundary, and do not
receive Operation IDs. Runtime defines no generic parent-child Operation
hierarchy or Operation DAG. This prevents an accidental asymmetry in today's
CLI from becoming the domain model and lets Agents use one execution-shape
contract across every Model Kind.
