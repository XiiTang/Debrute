# Security Boundaries

Debrute is a local application, but loopback networking and local filesystem
access are still privilege boundaries. Runtime clients, browser sessions,
professional-tool plugins, remote media URLs, Project paths, credentials, and
release artifacts each receive only the authority required by their current
contract.

## Runtime And Browser Authentication

Runtime binds HTTP only to loopback and validates the native peer, Host,
protocol-appropriate Origin policy, route group, and role-specific credential
before business dispatch. Native CLI
authorization is issued through its live Control connection and becomes invalid
when that connection ends; it is never persisted or accepted in a URL.

An ordinary browser storage partition establishes one in-memory
`debrute_web_session` cookie marked HttpOnly, host-only, and SameSite-Strict.
Concurrent tabs reuse that live session instead of replacing one another's
cookie. Desktop obtains a single-use in-memory launch ticket through its live
Control connection and passes it once to the renderer through preload; the
BrowserWindow URL contains no credential. Consuming a launch ticket creates the
browser session in that window's isolated storage partition and removes the
ticket atomically.

Every loaded document's POST SSE Workbench connection issues a separate
in-memory connection credential to JavaScript. Project and global commands send
it in a custom same-origin header and Runtime validates it together with the
shared browser session; it is never written to a URL, cookie, file, Web Storage,
environment variable, or log. Ending one connection revokes only its credential
and Project binding. A Terminal WebSocket is valid only while that same
connection owns the same Project, and closes when either lifetime ends. Passive
media reads require the browser session to contain a live connection bound to
the requested Project, but cannot mutate Project state. Source development
sends the same relative requests through Vite to the exact Runtime origin
without a token file or a second authentication system.

Photoshop WebSockets require the exact `file://` origin emitted by UXP together
with a loopback peer, exact gateway Host, fixed route, and subprotocol. UXP HTTP
requests are accepted only when Origin is absent, as observed in Photoshop
27.8, or exactly `file://`; file bytes additionally require the ephemeral socket
bearer. Photoshop routes do not inherit Workbench or CLI authority. See
[`photoshop.md`](./photoshop.md).

The Runtime-owned Photoshop Integration setting controls whether that complete
authority surface exists. Off binds no fixed-pool listener and retains no
Photoshop route, session, credential, or command authority. Idle disable closes
all sessions and invalidates their bearers before returning. Workbench can
request the closed setting mutation but cannot keep a listener or session alive
independently of Runtime.

## Project Filesystem Boundary

A Project operation accepts a normalized Project-relative path. Absolute paths,
drive-letter paths, backslash escapes, empty segments, and `.` or `..` traversal
are not Project path identities. Normalization alone is not sufficient because
an in-project symlink can still resolve outside the Project.

Runtime Project filesystem services therefore distinguish:

- existing targets, whose full real path must remain under the canonical
  Project root;
- write targets, whose existing target or nearest existing parent must remain
  under that root; and
- internal no-symlink targets, where the target itself must not be a symlink in
  addition to realpath containment.

Unexpected filesystem errors fail closed. Only explicitly expected missing-path
cases become absence; permission, invalid-link, IO, and other resolution errors
are not converted into a successful fallback.

Once a Runtime filesystem mutation has committed, a later Project refresh
error cannot make that completed mutation fail closed. Runtime preserves the
filesystem result, does not retry or roll it back, and reports the refresh
failure as an Error diagnostic on the successful command result. That outcome
describes the already committed mutation; it is not a successful fallback for
the failed refresh.

The same boundary protects Project Tree mutations, Feedback writes and derived
artifacts, Canvas preview reads, terminal working directories, native
reveal/trash operations, and professional-tool transfers. `.debrute/` is visible Project content; only version-control
internals, fixed operating-system debris, managed temporary files, symbolic
links, and non-regular entries are excluded from the Project Tree. Feedback
mutations separately reject every `.debrute/**` target so Feedback cannot review
its own source or artifacts.

Model Requests are not Project-bound. Runtime resolves required
`output.directory` and Model-declared local input paths against the CLI's
captured canonical working directory. Each local input must already be a
canonicalizable ordinary file. For an output directory, Runtime canonicalizes
the nearest existing ancestor and retains the resulting absolute path across
remote execution. At local publication it safely opens or creates the exact
ordinary directory. Existing symbolic links have already been resolved; a file,
symbolic link, inaccessible path, or unsafe component introduced into the
accepted missing suffix is rejected. Global Canvas state, Working
Copies, settings, secrets, caches, and generated-file provenance use
Runtime-owned global stores and do not inherit Project-relative path authority.

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
`apiKeySet`; it contains neither plaintext nor a credential-derived preview.
Omitting a key preserves the stored value, a non-empty key replaces it, and an
empty key clears it.

An explicit reveal command may return the exact stored key only to the
requesting authenticated Workbench connection. Its response is non-cacheable,
does not publish a Global event, and does not change the ordinary settings
projection. Workbench retains the response only in the requesting settings
component while the value is visibly revealed, then clears it when hidden or
unmounted. This boundary protects routine settings reads and other live
connections; it does not claim to hide a deliberately revealed value from an
already-compromised renderer. The decision is recorded in
[`0057-model-api-key-reveal-is-explicit-and-transient.md`](./adr/0057-model-api-key-reveal-is-explicit-and-transient.md).

Full keys belong only in secret storage, the server-side execution state that
is making an upstream request, the outbound request itself, a new settings
write, or one explicit reveal response and its requesting component's transient
visible state. They do not belong in ordinary Workbench settings or events,
CLI and batch output, Runtime error details, Project files, Model Artifact
records, or Model Request executions.

Model execution redacts outward-facing copies before they cross the runtime
boundary. The shared redactor removes sensitive object fields, exact active
secret strings, credential-like URL query values, and image/audio/video data URL
payloads while retaining useful non-secret request and error structure. Generic
Runtime error serialization also structurally redacts sensitive fields and query
parameters. Model Artifact metadata receives an already-redacted Model Request execution rather
than attempting to repair unsafe provenance after persistence.

## Product And Plugin Trust

Product updates trust the embedded Ed25519 key and signed update manifest, not
GitHub metadata alone. Signed size, SHA-256, URL, asset identity, and macOS
platform checks are enforced before replacement. See
[`releases.md`](./releases.md).

Product installation and removal are current-user operations with closed
layouts. The Product Installer supplies the only accepted installed Desktop
path and a strict manifest-validated Product seed; Desktop first launch cannot
choose an installation root or materialize missing components. Removal accepts
only the fixed current-user layout, validates the selected Runtime and Desktop
registration, and gives its detached Runtime closure a one-shot plan whose
paths are recomputed and checked before deletion. Its optional retained inputs
are fixed to the two configuration files and cannot expand the deletion or
restore scope.

The Photoshop plugin receives neither Workbench/CLI authority nor arbitrary
filesystem access. Its fresh socket identity and bearer, exact Canonical Root
plus Project-relative command targets, bounded gateway routes, and plugin-owned
temporary storage define that separate boundary. Its HTTP errors use one shared
closed Photoshop protocol envelope. Runtime keeps staging, I/O, and Photoshop
host diagnostics in its local log and returns only reviewed path-free error
messages; temporary paths and unrelated absolute host paths do not cross the
protocol. Canonical Root is deliberately present as the understandable Project
identity in both Workbench URLs and Photoshop destinations. The first version
performs no user authorization ceremony; protection against another local
process imitating the plugin remains deferred.

## Executable Authorities

- Native Control identity and role authorization: `apps/runtime/src/control/`.
- Loopback routing, browser sessions, Workbench connections, and launch tickets:
  `apps/runtime/src/workbench/`.
- Project containment and Feedback writes:
  `apps/runtime/src/project/paths.rs` and `apps/runtime/src/project/feedback.rs`.
- Global root-scoped state and Model Artifact provenance:
  `apps/runtime/src/global/root_state.rs` and
  `apps/runtime/src/model_request/provenance.rs`.
- DNS-pinned public HTTP(S) media policy: `apps/runtime/src/model_request/http.rs`.
- Secret settings and public settings projections: `apps/runtime/src/global/store.rs`.
- Runtime output redaction: `apps/runtime/src/model_request/redaction.rs`.
- Signed Product updates: `apps/runtime/src/product/`.
