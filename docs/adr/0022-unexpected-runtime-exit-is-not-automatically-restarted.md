# Unexpected Runtime Exit Is Not Automatically Restarted

No live Debrute client automatically restarts a Runtime that exits
unexpectedly. Desktop reports the native failure and exits. A Workbench
connection ends in a terminal page state without a Reconnect action. Terminal
input stops. Photoshop does not retry a transfer.

A later explicit Desktop, CLI, or development activation may run the normal
ensure-and-connect sequence and create a fresh Runtime instance. It does not
reuse connection credentials, browser state authority, Project Uses, revisions,
terminals, or lost request responses, and it never replays an accepted
state-changing request.

Coordinated product replacement is a separate planned lifecycle. The plugin may
follow its one bounded replacement indication to discover the target Runtime,
but ordinary unexpected loss has no automatic reconnect loop.
