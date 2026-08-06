# Photoshop Transfers Use Explicit Live Targets

Connected Photoshop plugin sessions and Workbenches discover live targets
through Runtime, and each transfer names its exact target: Workbench selects a
Photoshop Document, while the plugin selects a Debrute Project Directory.
Runtime validates those command-scoped targets at execution instead of
requiring a persistent Photoshop-to-Project link. This preserves stable target
identity, Project-relative paths, protected-directory filtering, and explicit
failure when a target disappears.

Runtime continuously projects only the identities, names, and revisions of
currently open Projects to the background plugin. The panel requests one
selected Project's filtered writable directory snapshot on demand. That
snapshot is presentation rather than write authority: submission still binds
its exact Project identity, revision, and relative directory, and Runtime
revalidates the target before commit.
