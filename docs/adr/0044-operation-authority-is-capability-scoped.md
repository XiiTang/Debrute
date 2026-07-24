# Operation Authority Is Capability Scoped

Runtime owns every accepted Operation; the initiating session and connection do
not own it. Each closed Operation kind declares in source
which fixed Runtime session roles may start, observe, and cancel it. Scoped
Operations additionally require the acting session to be authorized for the
same Product, Project, or Integration scope. Knowing an Operation ID never
grants authority.

Runtime reauthorizes every reserve, start, read, stream, and cancel request
against the caller's current role and scope. Revoking or disconnecting the
initiating session prevents its later requests but neither cancels the
Operation nor removes control from other sessions with the declared
capability. Initiator metadata may appear only as bounded, redacted diagnostics
and never participates in authorization. An observation connection identifies
one stream, not an authorization principal or exclusive controller.

The native Runtime Control Channel receives no generic Operation management
capability. Product Quit terminates active Operations directly. This was chosen over initiator-only ownership because frontend
lifetime is intentionally shorter than Operation lifetime, while capability
and scope checks preserve the fixed-role isolation of Runtime sessions.
