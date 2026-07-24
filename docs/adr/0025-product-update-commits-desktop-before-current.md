# Product Update Commits Desktop Before Current

A whole-product update first stages and validates one complete inactive Runtime
Product version, then records one bounded pending commit, closes Desktop, installs
the matching Desktop version, and only afterward atomically retargets `current`.
The new Runtime must become ready before the pending record and previous version
are removed. If the process stops after Desktop installation but before pointer
commit, the exact new Desktop seed or the old Runtime may validate and continue
that one pending commit; an older Desktop may never downgrade `current`, and
mismatched Desktop-host sessions are rejected. This was chosen over switching
Runtime first because a failed Desktop install would otherwise make every GUI
entry unusable. The pending record is update transaction state, not protocol
compatibility, migration, user rollback, or a multi-version recovery system.
