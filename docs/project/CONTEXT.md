# Project

The Project context names the local filesystem-backed creative workspace.

## Language

**Project**:
An existing local directory identified by its Canonical Root. Its files remain
authoritative; opening it does not require or create a manifest or Project ID.
_Avoid_: Workspace, registered project, Project instance

**Canonical Root**:
The canonical absolute filesystem path that is the complete durable identity of
one Project.
_Avoid_: Project ID, project URL, registration key

**Root Key**:
An internal association between one Canonical Root and its root-scoped state.
It is not part of the Project's public identity.
_Avoid_: Project ID, binding ID

**Project Path**:
A normalized path relative to the Project root used to identify a file or
directory within Project-scoped operations.
_Avoid_: Canonical Root, File URL

**Project Session**:
The live Project state shared by all temporary bindings for one Canonical Root.
_Avoid_: Workbench connection, Project identity

**Project Binding**:
A temporary relationship granting one Workbench connection access to a Project
Session. It is not Project identity.
_Avoid_: Project ID, session ID, Canonical Root

**Source Revision**:
The Runtime-confirmed content identity of the exact bytes currently stored at
one Project Path. It rejects stale reads, writes, and derived-resource requests.
_Avoid_: modification time, Canvas revision

**Project Path Command**:
A user operation directed at the Project root or Project Paths with the same
meaning whether invoked from Explorer, Canvas, or keyboard.
_Avoid_: Explorer command, Canvas command

**Feedback Document**:
A Project-local collection of review marks and comments associated with Project
Paths.
_Avoid_: Canvas state

**Project Diagnostic**:
A current, non-persisted error or warning produced while Runtime interprets
Project content and root-scoped state for one snapshot.
_Avoid_: validation history, repair record

**Canvas Workspace Snapshot**:
A Project Session's current view of its Canvas Workspace, including whether
Canvas can presently be used. Canvas availability is independent of Project
availability.
_Avoid_: optional Canvas fields, Project-open failure, Canvas diagnostic

**Project Tree**:
A hierarchical view of the Project filesystem shared by Explorer and Canvas.
_Avoid_: files alias, Canvas membership list
