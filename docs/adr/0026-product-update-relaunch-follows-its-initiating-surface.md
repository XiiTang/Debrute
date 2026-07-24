# Product Update Relaunch Follows Its Initiating Surface

Every product update records one fixed continuation derived from its initiating
surface. A Desktop update opens Desktop after the target Runtime is ready, a
browser update opens one newly authenticated browser page, a CLI update restores
Runtime only, and bootstrap completes the Desktop launch that triggered it.
Continuation never reads the default-frontend setting or falls back to another
surface.

The continuation identifies only the initiating surface. It does not migrate
Desktop window topology or bounds, browser sessions, Workbench connections,
Project Uses, terminal processes, revisions, or frontend state. The target
Runtime begins with fresh in-memory authority; persisted Project files, global
state, and Working Copies provide the durable state it may load.

The target Runtime durably claims the update transaction before dispatching the
continuation. A process failure after the claim may suppress the convenience
open, in which case the user launches Debrute normally; Runtime does not replay
the continuation or the update.

Professional-tool plugins are not initiating continuation surfaces. A plugin
that received the planned `runtime_replacing` signal may perform its bounded
replacement discovery and establish a fresh session, but no transfer is
retried.
