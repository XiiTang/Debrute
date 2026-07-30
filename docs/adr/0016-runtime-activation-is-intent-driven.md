# Runtime Activation Is Intent Driven

Every trusted entry point activates the single Runtime with one explicit
intent: ensure Runtime, open Desktop, open a browser, or open a known/explicit
Project in an explicitly selected frontend. A launcher first connects to
the existing owner or starts Runtime only after winning ownership, waits for
`Ready`, sends its intent once, and does not replay it after connection loss.

One absolute fifteen-second Ready deadline starts before the launcher first
tries to acquire or connect to Control. Endpoint acquisition, optional process
launch, handshake, and `Starting` inspection polling share that single budget;
no stage restarts it. Expiry closes that client, returns
`runtime_ready_timeout`, and submits no intent. It does not start a replacement
Runtime, terminate the Runtime owner, select another frontend, retry the intent,
or convert the result to generic unavailability. Runtime lifecycle is separate
from one launcher's failed wait. The explicit `debrute runtime stop` command
connects only to an existing owner and requests Product Quit without waiting for
`Ready`, so it also works while Runtime reports `Starting`.

Runtime has no default frontend, implicit frontend selection, or fallback from
one frontend to another. It also has no pre-ready activation queue, intent id,
deduplication cache, or cross-instance replay.

Desktop Project activation first focuses an existing Desktop window already
routed to the target. Otherwise Runtime may bind one live, root-routed Desktop
document which has never accepted a Project binding: the initiating window when
it is eligible, or the sole eligible empty window for an activation without a
source window. A Project-bound or detached document is never reused, and an
ambiguous set of empty windows causes Runtime to open a new Project-routed
window. Browser ownership transfer and detached Desktop **Open Here** remain
Workbench binding operations defined by
[ADR 0033](./0033-workbench-session-lifetime-follows-its-container.md). Focus,
empty-window binding, window creation, or ownership transfer is a direct
outcome of the submitted intent, not a retry, second destination confirmation,
or timeout fallback.
