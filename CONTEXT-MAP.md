# Context Map

Debrute has three product-domain contexts. They follow stable product language,
not process boundaries or workspace package count.

## Contexts

- [Project](./docs/project/CONTEXT.md) — the local filesystem-backed
  creative workspace and its Debrute-owned project metadata.
- [Canvas](./packages/canvas-core/CONTEXT.md) — the visual organization, review,
  comparison, and feedback surface projected from Project paths. Canvas-owned
  decisions live under `packages/canvas-core/docs/adr/`.
- [Capability](./docs/capability/CONTEXT.md) — runtime-backed operations
  and their structured results, including model generation and artifact pointers.

## Relationships

- **Project → Canvas**: a Canvas Map selects Project paths; a Canvas stores visual
  state for the resulting nodes while file and folder hierarchy remains
  Project-owned.
- **Capability → Project**: capabilities may read Project inputs and produce
  outputs identified by project-relative artifact pointers; the Project folder
  remains the source of truth for files.
- **Canvas reads Capability output through Project**: Canvas presents Project
  files regardless of how they were created. It does not own model execution or
  generated-asset provenance.

## Application Surfaces

Rust Runtime, Workbench, CLI and Skills, Desktop, and professional-tool plugins
are application surfaces, runtime layers, or adapters.
They consume the contexts above but do not define additional domain vocabularies.
Use the [documentation index](./docs/README.md) to navigate their current
technical contracts. See [`docs/agents/domain.md`](./docs/agents/domain.md) for
durable documentation and ADR ownership.
