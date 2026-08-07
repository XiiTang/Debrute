# Plugin Integration Enablement Is Runtime Owned

Each supported professional-tool Plugin Integration has one explicit,
default-off field in Runtime-owned Global Settings. Photoshop is the first:
`plugins.photoshop.enabled`. Workbench Settings submits a closed mutation and
renders the ordered settings and live-state projections; it does not own a
second enable value. A Runtime restart reapplies the persisted choice before
the first Workbench Photoshop projection is hydrated.

There is no Plugin Platform master switch. When every explicit Integration is
off, the platform is operationally off because no plugin listener, route,
session, credential, or command authority exists. A future Integration adds a
reviewed peer field and its own lifecycle rather than entering an arbitrary
plugin registry or inheriting the Photoshop protocol.

Enabling Photoshop immediately attempts its bounded loopback port pool. Full
pool exhaustion leaves the choice on, publishes `unavailable`, and drives one
non-overlapping five-second retry loop. Disabling it stops retry, removes the
gateway, and revokes all Photoshop sessions and authority. The loaded UXP
receiver continues bounded discovery while disconnected, including while the
Runtime Integration is off, so reconnection is automatic when both sides are
available. It receives no setting or control connection and its panel exposes
no manual connection action.

A Photoshop transfer owns the Integration from command reservation through
terminal settlement. Runtime serializes transfer admission with enablement and
rejects an on-to-off mutation while either transfer direction is active. Only
the Photoshop switch is blocked; unrelated Settings and future Integration
switches remain independent. This preserves an admitted command without
turning Runtime shutdown, Product update, or unrelated work into plugin busy
state.
