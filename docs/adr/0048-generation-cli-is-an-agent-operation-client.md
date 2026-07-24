# Generation CLI Is An Agent Operation Client

Debrute CLI is an Agent-facing, non-interactive Operation client. It never
branches on TTY state or emits prompts, spinners, ANSI UI, or multi-press
shortcuts. By default, a generation command reserves and starts an Operation,
immediately flushes an Agent Record containing its id and first snapshot, then
streams bounded snapshot records until the Operation reaches a terminal state.

Generation commands also provide an explicit non-waiting submission mode. It
returns successfully as soon as Runtime accepts the Operation and reports its
id and current snapshot; success means acceptance, not successful generation.
A later CLI session has closed inspection, waiting, and cancellation commands.
Waiting starts from a current snapshot and streams to a terminal state. Runtime
provides no Operation-resume command because Operations are instance-scoped and
do not survive Runtime replacement.

Process signals and transport loss carry no domain cancellation meaning.
An operating-system termination signal, a killed Agent tool, or a disconnected
observer terminates only that CLI process and preserves native signal status;
the accepted Runtime Operation continues. The explicit cancellation command is
the sole CLI cancellation path.
This was chosen because Agent hosts use signals for tool timeouts, task
replacement, and shutdown, so translating them into paid-work cancellation
would be ambiguous. The design keeps one-command foreground execution simple
while providing explicit asynchronous orchestration and recovery for Agents.
