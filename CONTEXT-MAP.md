# Context Map

Debrute has three product-domain contexts. They follow stable product language,
not process boundaries or workspace package count.

## Contexts

- [Project](./docs/project/CONTEXT.md) — the local filesystem-backed
  creative workspace and its Project-local Feedback.
- [Canvas](./packages/canvas-core/CONTEXT.md) — the visual organization, review,
  comparison, and feedback surface projected from Project paths. Canvas-owned
  decisions live under `packages/canvas-core/docs/adr/`.
- [Capability](./docs/capability/CONTEXT.md) — runtime-backed operations
  and their structured results, including Model Requests and artifact pointers.

## Relationships

- **Project → Canvas**: the Canvas projects the shared Project Tree. Folder
  Disclosure controls which descendants are visible, while sparse visual
  state remains Canvas-owned.
- **Capability → Project**: Project capabilities operate on files beneath a
  canonical Project root. Model Requests accept explicit local inputs and an
  absolute or invocation-working-directory-relative output directory and
  basename independently of any open Project. Outputs written beneath a
  Project root enter its Project Tree as ordinary files.
- **Canvas reads Capability output through Project**: Canvas presents Project
  Tree files regardless of how they were created. It does not own model
  execution or Model Artifact provenance.

## Application Surfaces

Rust Runtime, Workbench, CLI and Skills, Desktop, and professional-tool plugins
are application surfaces, runtime layers, or adapters.
They consume the contexts above but do not define additional domain vocabularies.
Use the [documentation index](./docs/README.md) to navigate their current
technical contracts. See [`docs/agents/domain.md`](./docs/agents/domain.md) for
durable documentation and ADR ownership.
