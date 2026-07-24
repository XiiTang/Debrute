# Model Configuration Is Per Debrute Model

Every supported generation integration is addressed by one Debrute Model ID
with catalog defaults, optional endpoint and request-model overrides, and one
write-only API key stored for that same ID. This was chosen over provider-level
accounts, shared credentials, key pools, enable switches, and generic request
adapters so list, describe, readiness, execution, and errors refer to the exact
model contract the runtime implements. The trade-off is that one upstream
credential may need to be entered for multiple Model IDs and endpoint overrides
explicitly change where that model's configured key is used.

The same ownership boundary applies to implementation and documentation. Each
Debrute Model owns one Catalog schema, one Agent manual contract, one request
constructor, one response parser, and its exact fixtures. Two Models do not
share a provider-family or near-identical semantic adapter, even when their
current endpoints and most parameters happen to match. Their fields, defaults,
wire formats, and response rules are allowed to evolve independently without a
model switch accumulating inside shared code. Some deliberate duplication is
the cost of keeping those contracts closed and separately reviewable.

Only model-agnostic mechanisms may be shared: HTTP execution, authorization
header construction, Base64 and data-URL decoding, MIME detection, public-URL
safety, redaction, and Project artifact commit primitives. A shared utility
stops being model-agnostic when it knows a Model ID, provider field name,
default, endpoint choice, or response path; that behavior belongs in the exact
Model adapter instead.
