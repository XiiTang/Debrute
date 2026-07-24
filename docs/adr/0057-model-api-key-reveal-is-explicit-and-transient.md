# Model API Key Reveal Is Explicit And Transient

Revealing an already configured Model API key is an intentional Settings
capability rather than a compatibility path or credential-recovery mechanism.
Model API keys remain Runtime-owned secrets and ordinary Global settings expose
only whether a key is configured. Workbench may reveal the exact stored value
only through an explicit authenticated command whose response is non-cacheable
and returned solely to the requesting connection; the plaintext is not part of
Global settings, events, logs, Project data, or durable Workbench state. The
requesting settings component retains the value only while it is visibly
revealed and clears it when hidden or unmounted.

Request scoping and transient retention limit routine plaintext propagation and
stale UI state; they are not a defense against an already-compromised Workbench
renderer, which can invoke reveal just as it can observe a newly entered key.
Requiring an operating-system credential prompt or moving secret ownership into
Desktop would add a second authority without protecting the current Browser and
CLI surfaces, so those are not part of the current local-application threat
model.
