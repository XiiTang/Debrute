# Canvas Source Settlement Is Path Local

ADR 0069 makes saved-file Source Resolution demand-driven and serializes exact
digest work. Each resolution response now returns only the requested path's
source token, availability, and resolved video text tracks when present. Media
classification, intrinsic geometry, and other stable Canvas Resource facts
remain owned by the Project snapshot and are not repeated in the response.

Workbench owns one imperative Source Resolution Runtime per Canvas surface. It
keeps the idle-gated, viewport-distance queue outside React state, admits one
request at a time, uses Project path as the exact distance tie-breaker, and
publishes each settlement through a Project-path external-store subscription.
Only the matching node shell and its media-preview target can observe that
settlement. The accepted Canvas Scene Projection, Project Tree, spatial index,
and unrelated node shells keep their existing identities.

Source settlement does not publish a Project revision, replace the Canvas
Resource View, rebuild the scene, or introduce a timer, batch window, second
cache, compatibility response, or fallback refresh. Folder Disclosure still
controls membership; all disclosed known-media sources, including offscreen
ones, remain eligible for eventual resolution.
