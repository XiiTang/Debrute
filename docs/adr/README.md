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

### Product Identity

- [Product Identity Uses One Complete Mascot](./0058-product-identity-uses-one-complete-mascot.md)
- [Expressive Brand Chrome Surrounds Neutral Creative Content](./0059-expressive-brand-chrome-surrounds-neutral-creative-content.md)

### Runtime, Desktop And Web Final State

This section groups Runtime, Desktop, and Web decisions. Model Operation and
Agent Model Request decisions are grouped in the following sections. The
packaged connection topology is defined jointly by ADR-0004, ADR-0009, and
ADR-0020: deterministic private native control, one dynamic same-origin
Workbench listener, and one narrow fixed Photoshop discovery listener.

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
- [Product Supports macOS And Windows](./0030-product-supports-macos-and-windows.md)
- [Desktop Windows Use One-Use Launch Tickets](./0031-desktop-windows-use-one-use-launches.md)
- [Desktop Does Not Recover Lost Connections](./0032-desktop-does-not-recover-lost-connections.md)
- [Workbench Connection Lifetime Follows Its Document](./0033-workbench-session-lifetime-follows-its-container.md)
- [Unexpected Runtime Panics Fail The Process](./0056-unexpected-runtime-panics-fail-the-process.md)
- [Model API Key Reveal Is Explicit And Transient](./0057-model-api-key-reveal-is-explicit-and-transient.md)

### Model Operation Subsystem

These accepted decisions define the implemented current-Runtime Operation
boundary. Exact request, result, and command-record shapes belong to Rust source,
`docs/cli.md`, and their contract tests rather than these ADRs.

The Operation subsystem currently covers only the five Model Kinds, with both
Single and Batch execution. The existing Integration service retains
its domain-specific install, update, or uninstall boundary; Product Update and
professional-tool transfers also retain their own lifecycle contracts. Those
subsystems intentionally remain outside the Operation registry. The
lifecycle refactor adds no interim generic registry or detached-job protocol.

- [Asynchronous Work Has Three Lifetime Classes](./0034-asynchronous-work-has-three-lifetime-classes.md)
- [Operations Have Linearized Submission And Cancellation](./0035-operations-have-linearized-submission-and-cancellation.md)
- [Operation Control State Is Not Domain History](./0036-operation-control-state-is-not-domain-history.md)
- [Operation Observation Uses Command-Scoped Waits](./0037-operation-observation-uses-command-scoped-waits.md)
- [Model Operation Snapshots Use One Closed Schema](./0038-model-operation-snapshots-use-one-closed-schema.md)
- [Operations Are Not Automatically Retried](./0042-operations-are-not-automatically-retried.md)
- [Operation Registry Retention Is Capacity Bounded](./0043-operation-registry-retention-is-capacity-bounded.md)

### Agent Model Request Operations

The Rust CLI and Runtime implement these decisions through the shared Single
and Batch Model Request surface. Exact commands, JSONL input, Agent Records,
output naming, and current-runtime observation are documented in `docs/cli.md`
and enforced by Rust and contract tests.

- [Model Operations Are CLI Only](./0045-model-operations-are-cli-only.md)
- [Model Kind Is Independent Of Execution Shape](./0046-model-kind-is-independent-of-execution-shape.md)
- [Batch Operation Success Means All Items Settled](./0047-batch-operation-success-means-all-items-settled.md)
- [Model Request CLI Is An Agent Operation Client](./0048-model-request-cli-is-an-agent-operation-client.md)
- [CLI Exit Status Is Coarse](./0049-cli-exit-status-is-coarse.md)
- [Operation Listing Is Live And Bounded](./0051-operation-listing-is-live-and-bounded.md)
- [Operation Cancellation Reports Whether Cancellation Won](./0052-operation-cancellation-reports-whether-cancellation-won.md)
- [CLI Model Request Timeout Bounds Active Model Execution](./0053-cli-model-request-timeout-bounds-active-model-execution.md)
- [Model Output Replacement Is Applied At Commit](./0054-model-output-replacement-is-applied-at-commit.md)
- [Generated Results Use In-Process Item Commits](./0055-generated-results-use-in-process-item-commits.md)

## Canvas Decisions

- [Canvas Map Is Source Intent](../../packages/canvas-core/docs/adr/0001-canvas-map-is-source-intent.md)
- [Image Preview State Is Node Local](../../packages/canvas-core/docs/adr/0002-image-preview-state-is-node-local.md)
- [Inactive Text Nodes Use Derived Previews](../../packages/canvas-core/docs/adr/0003-inactive-text-nodes-use-derived-previews.md)
- [Inactive Video Nodes Use Derived Previews](../../packages/canvas-core/docs/adr/0004-inactive-video-nodes-use-derived-previews.md)
- [Feedback State Is Structured And Artifacts Are Derived](../../packages/canvas-core/docs/adr/0005-feedback-state-is-structured-and-artifacts-are-derived.md)

## Capability Decisions

- [Generated Assets Follow Content Fingerprints](../capability/adr/0001-generated-assets-follow-content-fingerprints.md)
- [Model Configuration Is Per Debrute Model](../capability/adr/0002-model-configuration-is-per-debrute-model.md)
- [Model Runs Are Redacted Before Project Storage](../capability/adr/0003-model-runs-are-redacted-before-project-storage.md)

Project currently has no context-only ADR. Its qualifying decisions cross
application or context boundaries and therefore live in the system-wide set.
