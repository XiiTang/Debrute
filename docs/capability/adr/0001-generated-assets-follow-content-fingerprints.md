# Generated Assets Follow Content Fingerprints

Generated Asset provenance is matched to current Project files only by full-file
SHA-256; the recorded path is only a locator. Lookup hashes the current file
bytes every time, while size and mtime are used only to detect a file changing
during that hash. This was chosen over path-bound sidecars or background Project
scanning so user-owned outputs can be renamed or moved by any local tool without
losing provenance, while edited bytes correctly end the match. The trade-off is
on-demand hashing and possible visible-file scanning when a record's original
path no longer contains the same content.
