# Security Boundaries

Debrute is a local application, but loopback networking and local filesystem
access are still privilege boundaries. Runtime clients, browser sessions,
professional-tool plugins, remote media URLs, Project paths, credentials, and
release artifacts each receive only the authority required by their current
contract.

## Runtime And Browser Authentication

Runtime binds HTTP only to loopback and validates the native peer, Host, Origin,
route group, and role-specific credential before business dispatch. Native CLI
authorization is issued through its live Control connection and becomes invalid
when that connection ends; it is never persisted or accepted in a URL.

An ordinary browser launch establishes an in-memory `debrute_web_session`
cookie marked HttpOnly, host-only, and SameSite-Strict. Desktop obtains a
single-use in-memory launch ticket through its live Control connection and
passes it once to the renderer through preload; the BrowserWindow URL contains
no credential. Consuming a launch ticket creates the same browser session and
removes the ticket atomically.

One POST SSE Workbench connection issues a separate in-memory connection
credential to JavaScript. Project and global commands send it in a custom
same-origin header; it is never written to a URL, cookie, file, Web Storage,
environment variable, or log. Ending the connection revokes the credential and
its Project binding. A Terminal WebSocket is valid only while that same
connection owns the same Project, and closes when either lifetime ends. Passive
media reads require the live browser session, but cannot mutate Project state.
Source development sends the same relative requests through Vite to the exact
Runtime origin without a token file or a second authentication system.

Photoshop routes have their own narrow origin, plugin identity, pairing, and
client-scoped protocol rather than inheriting Workbench or CLI authority. See
[`photoshop-bridge.md`](./photoshop-bridge.md).

## Project Filesystem Boundary

A Project operation accepts a normalized Project-relative path. Absolute paths,
drive-letter paths, backslash escapes, empty segments, and `.` or `..` traversal
are not Project path identities. Normalization alone is not sufficient because
an in-project symlink can still resolve outside the Project.

Project Core therefore distinguishes:

- existing targets, whose full real path must remain under the canonical
  Project root;
- write targets, whose existing target or nearest existing parent must remain
  under that root; and
- internal no-symlink targets, where the target itself must not be a symlink in
  addition to realpath containment.

Unexpected filesystem errors fail closed. Only explicitly expected missing-path
cases become absence; permission, invalid-link, IO, and other resolution errors
are not converted into a successful fallback.

The same boundary protects Project Tree mutations, Project Document
transactions and their lock/temporary/rollback files, generated-asset records,
Canvas preview caches, terminal working directories, native reveal/trash
operations, Adobe Bridge transfers, and image-batch inputs and output logs.
Project Tree commands cannot mutate protected `.debrute/` documents, while
their owning services use registered Project Document paths.

The realpath decision is recorded in
[`0012-project-paths-are-realpath-bound.md`](./adr/0012-project-paths-are-realpath-bound.md).

## Public Remote Media

User-supplied and provider-returned remote media accepted through Debrute's
public-URL path must use HTTP or HTTPS without URL credentials. Hostnames and IP
literals are canonicalized and rejected when they target localhost, private,
loopback, link-local, carrier-grade NAT, multicast, unspecified, IPv4-mapped
private IPv6, or similar non-public ranges.

DNS is part of validation: every returned A or AAAA address must be public. The
policy selects a validated public address and binds it to the actual Rust
HTTP(S) connection while preserving the original hostname for HTTP semantics
and TLS certificate verification. This prevents a second independent DNS lookup
from changing the destination after approval.

Redirects are bounded and each next target is resolved and validated again
before another request. Failure to resolve is a policy failure rather than
permission to fall back to lexical hostname checks. This policy covers remote
model inputs and downloaded media artifacts; compiled or explicitly configured
upstream model API endpoints have their own model-specific execution contract.

The DNS-binding rationale is recorded in
[`0011-remote-media-fetches-bind-validated-dns.md`](./adr/0011-remote-media-fetches-bind-validated-dns.md).

## Secrets And Outward-Facing Data

Model API keys are stored separately from non-secret settings. The configuration
directory is forced to mode `0700`, and secret-file temporary and final writes
use mode `0600` with atomic replacement. A settings read exposes only
`apiKeySet` and a fixed-length non-credential preview; the plaintext input is
write-only. Omitting a key preserves the stored value, a non-empty key replaces
it, and an empty key clears it.

Full keys belong only in secret storage, the server-side execution state that
is making an upstream request, the outbound request itself, or a new settings
write. They do not belong in Workbench state or events, CLI and batch output,
Runtime error details, Project files, Generated Asset records, or Model Runs.

Model execution redacts outward-facing copies before they cross the runtime
boundary. The shared redactor removes sensitive object fields, exact active
secret strings, credential-like URL query values, and image/audio/video data URL
payloads while retaining useful non-secret request and error structure. Generic
Runtime error serialization also structurally redacts sensitive fields and query
parameters. Generated metadata receives an already-redacted Model Run rather
than attempting to repair unsafe provenance after persistence.

## Product And Plugin Trust

Product updates trust the embedded Ed25519 key and signed update manifest, not
GitHub metadata alone. Signed size, SHA-256, URL, asset identity, and macOS
platform checks are enforced before replacement. See
[`releases.md`](./releases.md).

Photoshop plugins receive neither Workbench/CLI authority nor arbitrary filesystem
access. Explicit client-to-Project links, Project-relative paths, client-scoped
state, and short-lived transfer URLs define that separate boundary.

## Executable Authorities

- Native Control identity and role authorization: `apps/runtime/src/control/`.
- Loopback routing, browser sessions, Workbench connections, and launch tickets:
  `apps/runtime/src/workbench/`.
- Project containment and structured document writes:
  `apps/runtime/src/project/paths.rs` and `documents.rs`.
- DNS-pinned public HTTP(S) media policy: `apps/runtime/src/generation/http.rs`.
- Secret settings and public previews: `apps/runtime/src/global/store.rs`.
- Runtime output redaction: `apps/runtime/src/generation/redaction.rs`.
- Signed Product updates: `apps/runtime/src/product/`.
