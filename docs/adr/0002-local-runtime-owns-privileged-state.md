# Local Runtime Owns Privileged Application State

Debrute uses one shared loopback Workbench runtime as the authority for project
sessions, global configuration, credentials, integrations, generated assets,
terminals, managed CLI and Skills, and product updates. Browser Workbench,
Electron Desktop, and CLI are clients: trusted entry points may ensure that the
Runtime is running, but no frontend owns or supervises its lifetime and none
duplicates its services. This was chosen over per-window backends,
renderer-owned filesystem access, and Desktop-owned application state so every
surface observes one runtime truth. Runtime lifetime is defined separately by
[ADR 0014](./0014-runtime-lifetime-is-independent-of-frontends.md).
