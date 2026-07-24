# Domain Docs

Debrute uses multi-context domain documentation.

## Before exploring

- Read the root `CONTEXT-MAP.md`.
- From the map, read every `CONTEXT.md` relevant to the requested area.
- Read applicable system-wide ADRs under `docs/adr/`.
- Read applicable context-owned ADRs at the paths declared by the map.
- If a file does not exist, proceed silently.

## Layout

- `CONTEXT-MAP.md`: context boundaries, ownership, and document paths
- `docs/adr/`: decisions spanning multiple contexts
- `<context>/CONTEXT.md`: compact domain terminology for one context
- `<context>/docs/adr/`: decisions owned by one context

Contexts follow product-domain ownership. Runtime processes, application
surfaces, and adapters remain technical architecture unless they introduce an
independent domain vocabulary. Do not create one context per workspace package
mechanically.

## Documentation ownership

| Knowledge | Durable owner |
| --- | --- |
| Public technical-documentation navigation | `docs/README.md` |
| Product purpose and non-goals | `README.md` |
| Cross-context product and storage boundaries | `docs/product-model.md` |
| Domain vocabulary and relationships | `CONTEXT-MAP.md` and its linked `CONTEXT.md` files |
| Exact cross-boundary request, result, event, and settings shapes | `packages/app-protocol` source and contract tests |
| Runtime, process, package, and development architecture | `docs/development.md` and `packages/architecture-rules` |
| Cross-surface security and trust boundaries | `docs/security.md` and their owning source modules |
| Local test architecture and resource ownership | `docs/testing.md` and `tests/config/` |
| Agent-facing commands and structured output | `docs/cli.md` |
| Workbench visual and component ownership | `docs/design-system.md` |
| Packaging, signing, update, and release behavior | `docs/releases.md` |

Context glossaries contain domain language only. Do not duplicate
responsibilities, invariants, application boundaries, executable type fields,
token values, command help, or package dependency lists there. Technical facts
and links belong in their durable technical owner or the Context Map.

## ADR ownership

- Use `docs/adr/` for decisions spanning contexts or application surfaces.
- Use `docs/project/adr/` for Project-only decisions.
- Use `packages/canvas-core/docs/adr/` for Canvas-only decisions, including
  Canvas Map semantics.
- Use `docs/capability/adr/` for Capability-only decisions.
- Create an ADR only when the decision is hard to reverse, surprising without
  context, and the result of a real trade-off.

## Vocabulary

Use the terms defined by the relevant `CONTEXT.md`. Do not introduce synonyms
for concepts whose names are already settled.

If a required concept is missing, either reconsider whether it belongs to the
domain or record the gap for domain modeling.

## ADR conflicts

If proposed work contradicts an existing ADR, identify the conflict explicitly
instead of silently overriding the decision.
