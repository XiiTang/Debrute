---
status: accepted
---

# Canvas Workspace Contains One Canvas State

Each canonical Project root has exactly one Canvas. Canvas is a Project view,
not a user-created collection, so it has no ID, name, catalog position, active
selection, or create, activate, rename, reorder, and delete operations.

Runtime computes `rootKey = lowercaseHex(SHA256(UTF8(canonicalRoot)))` and
stores the complete machine-local Canvas Workspace Document at:

```text
~/.debrute/state/roots/<rootKey>/canvas.json
```

The document has one closed shape:

```json
{
  "canonicalRoot": "/Users/me/Projects/campaign",
  "expandedDirectories": [],
  "nodeStates": {},
  "occlusionOrder": []
}
```

`canonicalRoot` must exactly match the requested root. The remaining members
are the Canvas State itself. Every Canvas mutation validates and atomically
replaces this document. The root is structurally expanded and never appears in
`expandedDirectories`.

Missing state creates the empty document above. Invalid, unreadable, or
root-mismatched state remains unchanged and makes Canvas unavailable without
blocking Project open. Runtime does not repair, migrate, salvage, or fall back
to another shape. **Reset Canvas** atomically writes the empty state without a
confirmation or backup; a write failure leaves Canvas unavailable.

The available Project snapshot publishes this document and one
`canvasResources` view derived from it. Workbench derives scene geometry and
keeps Selection, camera, and Manual Layout Drafts transient. Durable changes use
one `patchCanvasState` operation; no Canvas identity is carried through the
protocol, Runtime commands, Workbench actions, preview requests, diagnostics,
or performance traces.

Rebuildable preview caches remain in the same root bucket but are scoped by
Project path and content or target identities, never Canvas identity:

```text
~/.debrute/cache/roots/<rootKey>/canvas/canvas-text-previews/
  <path-key>/<target-key>/...

~/.debrute/cache/roots/<rootKey>/canvas/canvas-video-previews/
  <path-key>/<source-revision>/<canonical-source-identity>/...
```

Moving or renaming the Project root changes its canonical identity and selects
a different state and cache bucket. Project-local `.debrute/` continues to
contain only shareable Feedback source and derived Feedback artifacts.
