# Architecture Decisions

ADRs preserve current decisions that are difficult to reverse, surprising
without context, and based on a real trade-off. Implementation details and
domain definitions belong in source-backed technical docs and context
glossaries instead.

## System-Wide Decisions

### Established Baseline

- [Structured Project Documents Use Owner-Checked Transactions](./0001-structured-project-document-transactions.md)
- [Local Runtime Owns Privileged Application State](./0002-local-runtime-owns-privileged-state.md)
- [Project Sessions Use Typed Uses And Ordered Revisions](./0003-project-sessions-use-typed-uses-and-ordered-revisions.md)
- [Browser API Uses Same-Origin Sessions](./0004-browser-api-uses-same-origin-sessions.md)
- [Global Settings Use One Serialized Store](./0005-global-settings-use-one-serialized-store.md)
- [Product Version Is Runtime Owned](./0006-product-version-is-runtime-owned.md)
- [Workbench Owns Its Visual Primitive Layer](./0007-workbench-owns-its-visual-primitive-layer.md)
- [Signed Manifest Authenticates Product Updates](./0008-signed-manifest-authenticates-product-updates.md)
- [Photoshop Bridge Uses A Link-Scoped Protocol](./0009-photoshop-bridge-uses-link-scoped-protocol.md)
- [Integration Operations Are Catalog-Defined](./0010-integration-operations-are-catalog-defined.md)
- [Remote Media Fetches Bind Validated DNS](./0011-remote-media-fetches-bind-validated-dns.md)
- [Project Paths Are Realpath-Bound](./0012-project-paths-are-realpath-bound.md)
- [Tests Own Their External Resources](./0013-tests-own-their-external-resources.md)

### Runtime, Desktop And Web Final State

These decisions define the current architecture initiative. Its implementation
scope ends at ADR-0033. The packaged connection topology is defined jointly by
ADR-0004, ADR-0009, and ADR-0020: deterministic private native control, one
dynamic same-origin Workbench listener, and one narrow fixed Photoshop
discovery listener.

- [Runtime Lifetime Is Independent Of Frontends](./0014-runtime-lifetime-is-independent-of-frontends.md)
- [Runtime Uses One Process](./0015-runtime-uses-one-process.md)
- [Runtime Activation Is Intent Driven](./0016-runtime-activation-is-intent-driven.md)
- [Desktop Lifetime Follows Its Windows](./0017-desktop-lifetime-follows-its-windows.md)
- [Product Quit Closes Runtime And Desktop](./0018-product-quit-closes-runtime-and-desktop.md)
- [Product Quit Has No Blocker Gate](./0019-product-quit-has-no-blocker-gate.md)
- [Native Hosts Use A Narrow Runtime Control Channel](./0020-native-hosts-use-a-narrow-runtime-control-channel.md)
- [Runtime Credentials Are In-Memory Role Sessions](./0021-runtime-credentials-are-in-memory-role-sessions.md)
- [Unexpected Runtime Exit Is Not Automatically Restarted](./0022-unexpected-runtime-exit-is-not-automatically-restarted.md)
- [Runtime Coordinates Platform-Specific Product Replacement](./0023-runtime-coordinates-platform-specific-product-replacement.md)
- [Runtime Product Is Materialized By Version](./0024-runtime-product-is-materialized-by-version.md)
- [Product Update Commits Desktop Before Current](./0025-product-update-commits-desktop-before-current.md)
- [Product Update Relaunch Follows Its Initiating Surface](./0026-product-update-relaunch-follows-its-initiating-surface.md)
- [Workbench Working Copies Protect Unsaved Values](./0027-workbench-working-copies-protect-unsaved-values.md)
- [Runtime Exposes Four Statuses](./0028-runtime-exposes-four-statuses.md)
- [Runtime Owns The Tray](./0029-runtime-owns-the-tray.md)
- [Linux Is Best-Effort Distribution Only](./0030-linux-is-best-effort-distribution-only.md)
- [Desktop Windows Use One-Use Launch Tickets](./0031-desktop-windows-use-one-use-launches.md)
- [Desktop Does Not Recover Lost Connections](./0032-desktop-does-not-recover-lost-connections.md)
- [Workbench Connection Lifetime Follows Its Document](./0033-workbench-session-lifetime-follows-its-container.md)

### Deferred Operation Subsystem

These accepted decisions belong to a separate follow-up initiative and are not
acceptance criteria for the Runtime, Desktop and Web refactor.
When implemented, exact request, result, and event shapes belong to
`packages/app-protocol` source and contract tests rather than these ADRs.

Recorded follow-up: the existing Integration service currently owns one
domain-specific install, update, or uninstall command through completion even
when its initiating Workbench disconnects. The Operation initiative must
replace that boundary with the closed Operation model or deliberately retain
the exception before it is considered complete. The lifecycle refactor does
not add an interim generic registry or detached-job protocol.

- [Asynchronous Work Has Three Lifetime Classes](./0034-asynchronous-work-has-three-lifetime-classes.md)
- [Operations Have Linearized Submission And Cancellation](./0035-operations-have-linearized-submission-and-cancellation.md)
- [Operation Control State Is Not Domain History](./0036-operation-control-state-is-not-domain-history.md)
- [Operation Observation Uses Client Snapshot Streams](./0037-operation-observation-uses-client-snapshot-streams.md)
- [Operation Snapshots Are Closed By Kind](./0038-operation-snapshots-are-closed-by-kind.md)
- [Operation Admission Is Resource Scoped](./0039-operation-admission-is-resource-scoped.md)
- [Operations Have Kind-Specific Deadlines](./0040-operations-have-kind-specific-deadlines.md)
- [Operation Queue Pressure Rejects Before Acceptance](./0041-operation-queue-pressure-rejects-before-acceptance.md)
- [Operations Are Not Automatically Retried](./0042-operations-are-not-automatically-retried.md)
- [Operation Registry Retention Is Capacity Bounded](./0043-operation-registry-retention-is-capacity-bounded.md)
- [Operation Authority Is Capability Scoped](./0044-operation-authority-is-capability-scoped.md)

### Deferred Agent Generation CLI

These accepted decisions describe a later Operation-backed Agent generation
initiative. The current Rust CLI already owns its direct command spelling,
Agent Records and caller-bounded generation timeout. Image-batch executes each
item once; Runtime never automatically retries generation.
It does not implement the deferred generic Operation reserve, start, observe,
list, or cancel model. When that model is implemented, its exact request,
result, and event shapes belong to `docs/cli.md`, `packages/app-protocol`, and
their contract tests rather than these ADRs.

- [Model Generation Operations Are CLI Only](./0045-model-generation-operations-are-cli-only.md)
- [Generation Kind Is Independent Of Execution Shape](./0046-generation-kind-is-independent-of-execution-shape.md)
- [Batch Operation Success Means All Items Settled](./0047-batch-operation-success-means-all-items-settled.md)
- [Generation CLI Is An Agent Operation Client](./0048-generation-cli-is-an-agent-operation-client.md)
- [CLI Exit Status Is Coarse](./0049-cli-exit-status-is-coarse.md)
- [Agent Operation Streams Use Full Snapshot Records](./0050-agent-operation-streams-use-full-snapshot-records.md)
- [Operation Listing Is Live And Bounded](./0051-operation-listing-is-live-and-bounded.md)
- [Operation Cancellation Reports Whether Cancellation Won](./0052-operation-cancellation-reports-whether-cancellation-won.md)
- [CLI Generation Timeout Bounds Active Generation](./0053-cli-generation-timeout-bounds-active-generation.md)
- [Explicit Generation Outputs Are Claimed And Version Checked](./0054-explicit-generation-outputs-are-claimed-and-version-checked.md)
- [Generated Results Use Recoverable Item Commits](./0055-generated-results-use-recoverable-item-commits.md)
- [Batch Results Use One Recoverable JSONL](./0056-batch-results-use-one-recoverable-jsonl.md)

## Canvas Decisions

- [Canvas Map Is Source Intent](../../packages/canvas-core/docs/adr/0001-canvas-map-is-source-intent.md)
- [Image Preview State Is Node Local](../../packages/canvas-core/docs/adr/0002-image-preview-state-is-node-local.md)
- [Inactive Text Nodes Use Derived Previews](../../packages/canvas-core/docs/adr/0003-inactive-text-nodes-use-derived-previews.md)
- [Inactive Video Nodes Use Derived Previews](../../packages/canvas-core/docs/adr/0004-inactive-video-nodes-use-derived-previews.md)
- [Feedback State Is Structured And Artifacts Are Derived](../../packages/canvas-core/docs/adr/0005-feedback-state-is-structured-and-artifacts-are-derived.md)

## Capability Decisions

- [Generated Assets Follow Content Fingerprints](../../packages/capability-core/docs/adr/0001-generated-assets-follow-content-fingerprints.md)
- [Model Configuration Is Per Debrute Model](../../packages/capability-core/docs/adr/0002-model-configuration-is-per-debrute-model.md)
- [Model Runs Are Redacted Before Project Storage](../../packages/capability-core/docs/adr/0003-model-runs-are-redacted-before-project-storage.md)

Project currently has no context-only ADR. Its qualifying decisions cross
application or context boundaries and therefore live in the system-wide set.
