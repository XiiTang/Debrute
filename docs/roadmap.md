# Roadmap

This document records planned product and engineering work that is not yet a
current Debrute contract. Items have no release commitment unless a target is
stated explicitly.

## Runtime Cache And Temporary Storage Lifecycle

Debrute should own the complete lifecycle of large cache and temporary
resources created by Runtime workflows. The first scope is browser-to-Runtime
file uploads, Canvas preview caches, and Product download or extraction
directories. Small best-effort atomic-write temporary files are not by
themselves a reason for a repository-wide cleanup abstraction.

The design should:

- inventory each Runtime-owned cache and temporary root, its size limit, active
  lifetime, and final owner;
- give disposable directories an unmistakable Runtime-owned identity so a
  cleanup sweep cannot delete unrelated user or operating-system files;
- remove expired abandoned resources during bounded startup or maintenance
  sweeps while preserving resources held by active operations;
- record actionable warnings when large-resource cleanup fails, including the
  owning workflow and path, without changing an already committed user action
  from success to failure;
- preserve the primary operation error when an uncommitted operation and its
  cleanup both fail, while retaining the cleanup failure as secondary
  diagnostic context; and
- cover interrupted processes, held-open files, permission failures, active
  resources, and expired resources with focused macOS and Windows tests.

This work does not require every ignored cleanup error in the repository to
become user-visible, does not make Project an operating-system sandbox, and
does not change ordinary editor-style partial copy semantics without a separate
product decision.

## Photoshop CEP Plugin

Debrute may add a Photoshop CEP Plugin for Photoshop environments or workflows
that cannot use the current UXP Plugin. Both Plugins belong to the same
Photoshop Integration; CEP does not create a second Integration. CEP is not
currently implemented or supported, so the shipped Photoshop Integration
remains UXP-only.

Before the CEP Plugin can become a current product contract, the work should
define and verify its supported Photoshop versions, installation and packaging
model, Runtime connection lifecycle, transfer behavior, platform coverage, and
real-Photoshop acceptance plan. It must not be presented as an alias or
fallback for the existing UXP package until that independent implementation
and verification exist.
