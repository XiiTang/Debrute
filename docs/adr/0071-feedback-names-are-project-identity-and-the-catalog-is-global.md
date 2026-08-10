# Feedback Names Are Project Identity And The Catalog Is Global

Canvas ADR-0005 makes the structured Project Feedback Document authoritative
and keeps derived artifacts out of editable state. A closed Feedback Mark enum
would prevent users from creating multilingual review signals, while putting
icon definitions in the Project document would turn machine-local presentation
preferences into portable protocol state. Generated Mark IDs would also make
Agents and people resolve a second registry before understanding a document.

A Feedback Name is therefore the Feedback Mark's exact Project identity and
visible meaning. The Feedback Document stores that Unicode string directly and
stores no generated Mark ID, display-label registry, icon identifier, or icon
library metadata. Exact strings are distinct: case and canonically equivalent
Unicode sequences are not normalized into one identity.

Runtime-owned local Global Settings contains the Feedback Mark Catalog. Each
Catalog entry maps one immutable Feedback Name to one mutable Phosphor Fill icon
identifier. A separate ordered Feedback Action Bar references at most eight
Catalog names. Catalog creation, deletion, icon changes, membership, and order
never write a Project Feedback Document. The same Project name may
intentionally use different icons on different computers.

The Feedback Action Bar is an action palette for setting or clearing the local
selection of Marks, not a complete view of Project Feedback. The Project-scoped
Feedback Panel projects every accepted Feedback Name and Feedback Item in the
current document. A name without a valid local mapping keeps its exact identity
and uses the standard question-mark presentation.

Settings creation uses the strict current local-name contract. Project document
reading is deliberately more tolerant so externally authored Feedback Names
remain intelligible and editable as Project state; Settings neither repairs nor
migrates them. Replacing a local name means deleting its mapping and creating a
new one. Existing Project Feedback is never renamed or deleted as a side effect.

This extends Canvas ADR-0005, uses the serialized Global store from system
ADR-0005, and keeps accepted Project state ordering under system ADR-0003.
