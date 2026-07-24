# Runtime Activation Is Intent Driven

Every trusted entry point activates the single Runtime with one explicit
intent: ensure Runtime, open the configured default frontend, open Desktop,
open a browser, or open a known/explicit Project. A launcher first connects to
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

Only the default-open intent reads the Runtime-owned frontend preference.
Explicit intents never fall back to another frontend. Runtime has no pre-ready
activation queue, intent id, deduplication cache, or cross-instance replay.

Opening a Project applies the Workbench single-owner rule. If another Desktop
window owns it, an ordinary Desktop activation focuses that window. A browser
activation creates its requested Workbench and may preempt the current owner.
Desktop's explicit **Open Here** action also preempts. These are direct outcomes
of the submitted intent, not retries or timeout fallbacks.
