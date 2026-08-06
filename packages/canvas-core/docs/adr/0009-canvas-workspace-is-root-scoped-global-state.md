---
status: accepted
---

# Canvas Workspace Is Root-Scoped Global State

The canonical absolute Project root is the complete Project identity. For root
`R`, Runtime computes `rootKey = lowercaseHex(SHA256(UTF8(R)))` and stores one
Canvas Workspace Document at:

```text
~/.debrute/state/roots/<rootKey>/canvas.json
```

Rebuildable Canvas caches live under:

```text
~/.debrute/cache/roots/<rootKey>/canvas/**
```

The authoritative document contains the ordered Canvas catalog and every
Canvas's sparse state:

```json
{
  "canonicalRoot": "/Users/me/Projects/campaign",
  "activeCanvasId": "main",
  "canvases": [
    {
      "id": "main",
      "name": "Main",
      "expandedDirectories": [],
      "nodeStates": {},
      "occlusionOrder": []
    }
  ]
}
```

`canonicalRoot` must exactly match the requested root. `canvases` is non-empty
and ordered, Canvas IDs are unique, and `activeCanvasId` identifies one member.
Every Canvas catalog or state mutation atomically replaces this one document.
The root is structurally expanded and never appears in `expandedDirectories`.
Missing state creates this default `main` Canvas. Invalid, unreadable, or
root-mismatched state remains unchanged and makes the complete Canvas workspace
unavailable without blocking Project open. Runtime does not repair, migrate, or
fall back to another document. An explicit Reset Canvas Workspace action
atomically writes the default document without confirmation or backup; a write
failure leaves Canvas unavailable.

Canvas state is machine-local presentation. Working Copies and rebuildable
preview caches are also Runtime-global. Project-local `.debrute/` contains only
shareable Feedback source and derived Feedback artifacts:

```text
.debrute/feedback/feedback.json
.debrute/feedback/artifacts/**
```

`.debrute/` is visible in Explorer and Canvas. Feedback cannot target
`.debrute/**`, preventing recursive review state. Moving or renaming the Project
root changes its canonical identity and therefore selects a different global
Canvas Workspace bucket.
