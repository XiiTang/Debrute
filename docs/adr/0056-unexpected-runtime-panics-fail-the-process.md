# Unexpected Runtime Panics Fail The Process

Expected operational failures remain typed `Result` values at their owning
request or work boundary. An unexpected panic instead terminates Runtime
immediately: Runtime does not convert it into an Operation or preview failure,
recover a poisoned authoritative lock, enter a degraded mode, or run a
panic-specific graceful-shutdown protocol. This deliberately gives up the
current process's availability rather than continue from potentially
inconsistent in-memory authority; a later explicit launch starts a new Runtime
under the existing no-automatic-restart contract.

This includes Adobe Bridge authority and its Workbench socket registry:
poisoned locks and impossible internal transitions panic. They are not exposed
as a recoverable `state_poisoned` protocol or HTTP error.

The boundary is the source of the failure, not merely its data type. An unknown
or replaced plugin session and a duplicate client-supplied upload id remain
typed protocol failures. A missing or duplicate session reverse index, a
duplicate Runtime-generated id, a second socket registration for one accepted
session, or a prepared transfer that cannot settle is an internal invariant
failure and panics. A Project closing between Bridge listing and snapshot is a
normal race and is omitted from that projection. Any other failure to publish
the committed Global Bridge projection is process-fatal; a per-socket
projection error is sent to that still-live socket, and only an invalid session
or an unavailable outbound queue makes the socket stale.

The same process-fatal rule applies when a monotonic Global event revision or
integration-projection generation is exhausted. Those counters preserve one
ordered authoritative projection; they are not recoverable resource budgets.
Runtime does not keep a successful side-effect result while suppressing its
settled state event. A later explicit launch observes external integration state
through the ordinary fresh scan.
