---
status: accepted
---

# Project Identity Is The Canonical Root

The canonical absolute Project root is the complete Project identity for Recent
Projects, Desktop routes, Workbench URLs, Photoshop targets, session lookup,
Working Copies, and Canvas state. A Model Request instead captures the CLI's
canonical working directory and resolves its own output and declared local
input paths independently of Project identity and Project Sessions.

## Admission and routing

Input surfaces may accept relative paths when their working directory is
defined. Runtime canonicalizes the existing directory before admitting work and
uses only the canonical absolute value afterward. Desktop performs a read-only
preflight before opening or focusing a window; the Workbench binding performs
the full Project Session load.

The only stable Project page route is:

```text
/open?path=<percent-encoded-canonical-root>
```

Recent Projects are an ordered list of canonical roots. Desktop, Browser, Copy
URL, native recent documents, and Photoshop use that root directly.

## Temporary binding authority

One live Project Session, watcher, and Project Tree exists per canonical root.
Each Workbench connection receives an opaque in-memory `bindingId` and accesses
Project-scoped HTTP resources beneath:

```text
/api/workbench/bindings/<bindingId>/...
```

The binding prevents a page from presenting arbitrary absolute filesystem paths
to privileged endpoints. It is capability authority only: it is not Project
identity, is not persisted, and may change on reload. Reload binds the same URL
and canonical root again, so root-scoped Canvas and Working Copy state survives.

## Root-scoped global state

Runtime-global root state is stored under
`~/.debrute/state/roots/<rootKey>/`, where `rootKey` is lowercase
SHA-256 of the canonical-root UTF-8 bytes. Every authoritative root-scoped
document repeats `canonicalRoot` and is rejected when it does not exactly match
the requested root. Working Copies and Canvas state use this boundary; caches
use the parallel `~/.debrute/cache/roots/<rootKey>/` boundary.

## Failure

Opening fails only for path/admission failures such as `project_not_found`, an
unreadable root, or an invalid path kind. Desktop passes the canonical root,
code, and message unchanged.

Malformed Feedback state remains unchanged and fails the Project load or
refresh. Malformed, unreadable, or root-mismatched Canvas state remains
unchanged but does not block Project open; it makes only the Canvas workspace
unavailable until the user resets it.

## Consequences

- Users can understand Project identity from the filesystem and specify output
  destinations without hidden binding configuration.
- Moving a Project to a different canonical root intentionally creates a new
  identity and new root-scoped presentation state.
- A temporary binding is safe to discard on reload because the URL and durable
  state are root-based.
- Canonical-root paths are intentionally visible in native surfaces and URLs;
  `bindingId` remains opaque and temporary.
