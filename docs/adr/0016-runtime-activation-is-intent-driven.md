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

Browser Project activation validates the Project before opening its routed URL
and returns `project_open_failed` when validation fails. Desktop Project
activation does not preflight or bind a Project. If no Desktop host exists,
Runtime launches Desktop with the raw requested root. If a host exists, Runtime
forwards the raw root and optional source window key to that host once.

Electron selects one target before Project opening begins: the live source, the
only live window for a source-free request, or a new ordinary Workbench when no
unique target exists. That Workbench performs the normal binding transaction.
Failure remains in the selected Workbench; it does not trigger target selection,
another window, or a native failure transport. Browser ownership transfer and
detached Desktop **Open Here** remain Workbench binding operations defined by
[ADR 0033](./0033-workbench-session-lifetime-follows-its-container.md).
A new target completes its own initial binding. An existing target may focus a
different Desktop Workbench that already owns the same Project.

Invalid Feedback state fails Project opening. Invalid, unreadable, or
root-mismatched Canvas state leaves Canvas unavailable without blocking the
Project.
