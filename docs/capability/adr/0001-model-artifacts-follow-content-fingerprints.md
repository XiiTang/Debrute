---
status: accepted
---

# Model Artifacts Follow Content Fingerprints

Runtime matches one current file to Model Artifact provenance by streaming the
file's full SHA-256 and reading
`~/.debrute/model-artifacts/<full-file-sha256>.json`. The recorded absolute path
is descriptive rather than identity. Unchanged bytes remain attributable after
a rename or move; changed bytes produce a different lookup key. Each hash owns
at most one compact provenance record, and recording identical bytes overwrites
that record.
