# Project

The Project context names the local creative workspace and the Debrute-owned
metadata that describes it without replacing the filesystem as the source of
truth.

## Language

**Project**:
A local folder together with Debrute metadata under its `.debrute/` directory.
The folder remains authoritative for project files.
_Avoid_: Workspace, cloud workspace

**Project Path**:
A normalized path relative to the Project root used to identify a file or
directory without exposing an absolute host path across product boundaries.
_Avoid_: File URL, absolute path

**Project Path Command**:
A user operation directed at the Project root or one or more Project Paths,
with the same meaning whether invoked from Explorer, Canvas, or the keyboard.
_Avoid_: Context-menu command, Explorer command, Canvas command

**Project Document**:
A structured Debrute-owned file under `.debrute/` whose registered role and
owner determine how it participates in Project state.
_Avoid_: Ordinary project file, schema registry entry

**Source Document**:
A Project Document that expresses editable intent from which related state can
be derived.
_Avoid_: Pushed document, cache

**Pushed Document**:
A persisted projection computed from source documents and current Project state;
it is inspectable but is not the primary source of intent.
_Avoid_: Source document, source of truth

**Metadata Document**:
A Project Document containing durable facts that cannot be recreated from source
documents with full fidelity.
_Avoid_: Cache document

**Cache Document**:
A rebuildable Project Document used to avoid repeated computation.
_Avoid_: Metadata document, source document

**Project Diagnostic**:
A current, non-persisted error or warning produced while Runtime interprets
Project files and Project Documents for one Project snapshot.
_Avoid_: Canvas Diagnostic, diagnostic source, validation history

**Push**:
The operation that validates source documents and Project inputs, computes
affected pushed state, and commits the resulting Project Documents.
_Avoid_: Save, file copy
