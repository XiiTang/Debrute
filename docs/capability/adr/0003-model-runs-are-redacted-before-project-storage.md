# Model Runs Are Redacted Before Project Storage

The exact model executor creates the persistent Model Run copy by removing
credential fields, configured secret strings, secret URL parameters, and inline
media payloads before Generated Asset metadata crosses into Project storage.
This was chosen over raw provenance plus display-time masking so Project
archives, Runtime responses, diagnostics, and future readers cannot expose a
credential that was already persisted. The trade-off is deliberately lossy
secret and large-payload detail while non-secret request, response, status, and
error structure remains available for diagnosis.
