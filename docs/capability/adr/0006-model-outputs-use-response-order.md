---
status: accepted
---

# Model Outputs Use Response Order

Every public Model output is identified by its zero-based `artifactIndex` in
response order. MIME type determines each extension. Naming counts outputs with
the same extension independently: one uses `name.ext`, while multiple use
`name_1.ext`, `name_2.ext`, and so on. Thus two MP4 and two JPEG outputs have
independent MP4 and JPEG suffix sequences; no requested classification or role
is involved.

Artifact Pointers, CLI records, filenames, and provenance use this same index.
The Model Operation's `operationId` remains the only execution identity.
Runtime commits files before attempting one provenance record per output, and
reports provenance failures as one Operation warning without rolling back
published files.
