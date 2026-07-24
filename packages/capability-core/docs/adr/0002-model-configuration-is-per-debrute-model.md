# Model Configuration Is Per Debrute Model

Every supported generation integration is addressed by one Debrute Model ID
with catalog defaults, optional endpoint and request-model overrides, and one
write-only API key stored for that same ID. This was chosen over provider-level
accounts, shared credentials, key pools, enable switches, and generic request
adapters so list, describe, readiness, execution, and errors refer to the exact
model contract the runtime implements. The trade-off is that one upstream
credential may need to be entered for multiple Model IDs and endpoint overrides
explicitly change where that model's configured key is used.
