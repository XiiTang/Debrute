# Structured Project Documents Use Owner-Checked Transactions

Debrute classifies structured `.debrute/` state by descriptor role and allowed
service owner, then commits service-owned multi-document changes through
hash-verified, lock-backed Runtime transactions. This was chosen over generic
Project Tree mutation or a monolithic schema registry so Project remains
filesystem-backed, cross-context writes commit together, and Canvas and
Capability services retain their own validation semantics.
