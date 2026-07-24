# Model Business Rules Are Validated by the Remote Endpoint

Runtime validates the parts of a Model Request that Debrute owns: the Debrute
Model exists and is configured; arguments are safe JSON structures; known
arguments use shapes the exact adapter can transform; Project paths, media
references, and public URLs are safe; request and generated-resource limits are
respected; Catalog defaults are materialized; and the Operation, Batch, timeout,
and output-target envelope is valid. Runtime's `required` check tests only
whether a field is present; it does not reinterpret `null` or a blank string as
omission. The remote model endpoint validates parameter-name support and content
constraints once a field is present, including text length, numeric ranges,
current enum values, dimension pairing and divisibility, cross-field
combinations, and options that depend on the model, account, or plan.

For each catalog-exposed argument, Runtime validates the JSON type and nested
shape that its exact adapter can process without coercion or loss. Those stable
structural checks include scalar versus array or object and the supported child
field shapes. Runtime does not enforce provider enum membership, numeric
ranges, minimum container cardinality, non-emptiness, or cross-field rules; a
structurally valid known argument reaches the remote endpoint unchanged for
those decisions. Debrute-owned upper resource limits remain local safety
boundaries.

Those local boundaries distinguish one materialized input from the complete
outbound Model Request. Any input media that Runtime holds as bytes—decoded
from a data URL, read from the Project, or downloaded because an adapter needs
multipart bytes—is limited to 128 MiB per item. Runtime also maintains one
256 MiB budget for the complete Model Request. Inline media consumes that
budget at its Base64-expanded request size, multipart media at its binary size
plus a conservative form-envelope allowance, and a public URL passed through
to the remote endpoint consumes only its URL text. The final serialized JSON
body or conservatively sized multipart body is checked again at the native
transport boundary. A public URL that an adapter passes through is not fetched
locally merely to measure the remote resource; the remote endpoint owns that
resource limit.

Runtime applies these checks while resolving each input, before avoidable
allocation, decoding, Project reads, or remote download where the size is
known, and rejects rather than truncates an oversized request. Input-media
downloads use this input contract and do not consume Generated Asset download
accounting. Generated Assets retain their independent 256 MiB per-asset and
512 MiB per Model Operation limits.

The Catalog is not a parameter-name allowlist. After the adapter removes and
transforms the known fields it owns, remaining structurally safe arguments are
forwarded at that Model's documented request location so the remote endpoint can
accept a newly supported field or return its current authoritative error. Known
arguments still reach the remote endpoint without local range, enum, or
cross-field rejection. Runtime does not coerce a wrong JSON type into a
supported one or guess how an unknown field changes response transport; if the
remote endpoint accepts such a request but returns an unsupported response
shape, the exact adapter reports that response error.

The Catalog and Agent manual list the understood, recommended argument surface.
They do not enumerate fields a Model does not use and do not add negative
statements such as “this model does not use parameter X.” Absence is sufficient;
an Agent may still try a remote field and learn from the original remote result.

This was chosen over duplicating those remote rules in Runtime because a stale
local validator can reject a request that the remote endpoint currently allows
and prevents the Agent from receiving the authoritative rejection needed to
correct its next request. Catalog model manuals still document the known remote
contract, but those descriptions do not become a second business-rule engine.
The trade-off is that an invalid business value can consume one remote request.

When the remote endpoint rejects a request, Runtime preserves its HTTP status,
remote code, and original explanatory message in the Model Operation's single
Agent-visible `log` after applying credential and inline-payload redaction and
an error-text size limit. It does not add a parallel provider-error object,
expose arbitrary response headers or the complete response body, replace a
useful remote rejection with a generic model-business-error message, change
arguments, or submit a fallback request. The otherwise-unobservable
`GenerationError.details` and `GenerationError.logs` layers are removed.
