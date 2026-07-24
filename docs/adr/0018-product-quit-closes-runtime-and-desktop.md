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
