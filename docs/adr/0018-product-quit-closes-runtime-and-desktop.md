# Product Quit Closes Runtime And Desktop

Quit Debrute is the product-level exit command. Runtime changes to `Exiting`,
rejects new work, notifies Desktop to close its windows and exit, ends browser
and Photoshop connections, terminates owned terminals and operations, releases
native endpoints and workers, removes its tray, and exits. Browser pages remain
open and show that their local Runtime connection ended.

`Command-Q`, the Desktop application-menu Quit action, and
`Quit Debrute` in the Runtime tray, and `debrute runtime stop` all request this
same transition. Closing Desktop windows is not Product Quit and never stops
Runtime. Runtime does not discover or kill Desktop by PID; the live Control
event is the coordination boundary.

External Product Quit requests from Desktop and CLI cross Runtime Control. The
Runtime tray invokes the same transition inside Runtime. Workbench HTTP exposes
no parallel Product Quit route; a browser Workbench observes Product exit but
does not own a command that initiates it.

If Desktop receives Command-Q while its one startup Control acquisition is
still in progress, it records that Product Quit request instead of converting
it to a Desktop-only exit. After Control is ready and Product events are wired,
Desktop sends Product Quit once before creating a Workbench window. It does not
cancel or restart acquisition, open a second connection, retry the request, or
launch a fallback surface. A genuine acquisition failure remains a visible
startup failure rather than a reported Product Quit success.
