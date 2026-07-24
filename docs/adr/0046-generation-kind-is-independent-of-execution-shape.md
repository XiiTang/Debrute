# Generation Kind Is Independent Of Execution Shape

Model generation has five peer `GenerationKind` values: `image`, `video`,
`tts`, `music`, and `sound-effect`. `audio` is an implementation and settings
group for the latter three, not a generation kind. Every generation Operation
also has an orthogonal `ExecutionShape` of `single` or `batch`; a shape never
becomes another generation kind.

The initial closed protocol accepts `single` for all five kinds and `batch` only
for `image`, matching the product capabilities that exist today. Unsupported
kind-and-shape pairs are rejected during `StartOperation` validation before an
Operation is accepted. Adding another batch-capable kind extends that closed
combination table without changing the generation taxonomy.

Both shapes create exactly one Operation. Batch items are internal typed work
items of that Operation, share its cancellation boundary, and do not receive
Operation IDs. Runtime defines no generic parent-child Operation hierarchy or
Operation DAG. This was chosen so an accidental asymmetry in today's CLI does
not become the domain model, while the Runtime refactor also does not invent
batch features for media kinds that do not currently have them.
