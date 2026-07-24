# Workbench Front-End

Debrute Web Workbench is one React application used in browsers and Electron.
It targets pointer-and-keyboard desktop-class environments and presents the
Project, Canvas, Capability, settings, and integration surfaces through one
compact creative-tool interface.

## Design And Source Authority

[`design-system.md`](./design-system.md) is the durable human-readable design contract.
`apps/web/src/workbench/ui/styles/tokens.css` is the executable authority for
theme colors, spacing, type sizes, control sizes, radii, motion, focus, shadows,
and layer roles. `apps/web/src/styles.css` is only the ordered stylesheet import
hub.

`apps/web/src/workbench/ui/index.ts` is the public primitive surface. Primitives
own accessible behavior and shared chrome for buttons, fields, menus, tabs,
panels, status, and empty states. Shared cross-feature composition belongs in
`workbench-patterns.css`; feature content and intrinsic geometry remain in the
owning feature component and stylesheet. Canvas and the terminal emulator may
own geometry or media-specific presentation, but they do not define alternate
general-purpose controls or panel shells.

## Composition And Asynchronous State

`WorkbenchApp.tsx` is the composition root. It connects the API client, the
shell, focused controllers, project-session state, Canvas runtime, editors, and
feature views. The HTTP client owns one long-lived POST SSE Workbench
connection, its in-memory command credential, the current Project binding, and
ordered Global and Project revisions. Concurrent ordinary-browser tabs share
their storage partition's HttpOnly browser session but retain independent
connections, credentials, and Project bindings. The client never reconnects or
automatically replays a command; unexpected connection end becomes a terminal
connection state and a manual page refresh creates a fresh connection. An
accepted Project retains its last Canvas beneath a blocking connection dialog;
an unbound Workbench presents the connection error directly over its Canvas
background. When an ordinary Desktop open targets a Project owned by Web, the
root surface requires an explicit **Open Here** action before requesting
preemption.

A successful `project.bound` event is one complete Project-open result:
Project id, ordered revision, snapshot, and current Working Copies travel
together from the HTTP client through startup to the composition root. An
unbound or failed startup has no Project result; the Workbench does not split a
successful binding into independently optional fields or reconstruct a partial
Project from them.

Replacing Project A with Project B is a prepared handoff on the same Workbench
connection. Runtime first opens and validates B while A remains authoritative,
then creates B's Project subscription and uses that subscription's initial
snapshot to build the complete `project.bound` projection. It also loads B's
Working Copies and secures delivery of the first bound frame before changing
ownership. If any preparation fails, the connection remains bound to A and an
existing owner of B is not preempted.

Once preparation succeeds, one commit changes the connection binding, the
unique Workbench owner, and the owning Workbench Project Use; invalidates work
authorized by the old binding generation; and publishes the prepared
`project.bound` result. Desktop route changes caused by ownership follow that
commit. If the prepared Project stream fails after commit, Runtime ends the
exact connection and releases B's Workbench Project Use. It does not roll back
to A because the client may already have observed B. Selecting the already-bound
Project remains a no-op.

Every Project-scoped mutation is authorized against the connection's current
binding generation as well as its Project id. Work begun for A cannot commit to
A after the same connection has switched to B; this applies in particular to
Working Copies, which are persistent Project data but do not have their own
ordered Project event stream.

The bound snapshot already contains current Project health and Project
Diagnostics. Workbench does not
follow binding with duplicate snapshot or health GETs and exposes no manual
Project refresh command. Runtime filesystem watching and internal refreshes
publish their accepted results through the same ordered Project event stream.

Focused units own cohesive state:

- `useWorkbenchSettingsController` owns global settings, Adobe Bridge live
  state, locale, resolved theme, and settings commands.
- `useProjectExplorerController` owns Explorer selection, clipboard, inline
  edits, file commands, and invalidation when the project changes.
- Canvas controllers own Canvas feedback, overlays, and runtime interaction.
- Text services own editor buffers and floating editor windows.
- Shell modules own panel geometry, viewport reconciliation, and window order.

Resources that may load or fail use explicit loading, ready, and error states.
The owner of an asynchronous operation applies request-version or
project-generation checks where overlapping results can occur. Failed loads are
not converted into successful empty data, and failed saves leave the relevant
draft available with an owning error state.

Workbench has exactly three page-path shapes: `/`, `/open`, and
`/projects/<project-id>`. Those paths select the application entry document;
existing static-asset paths select their exact files. An unknown page path,
deeper Project path, or missing asset returns `404` instead of falling back to
the Workbench entry document or root surface. Page paths must already be
canonical: trailing slashes and repeated slashes return `404` and are not
removed or redirected. Settings and other feature views remain internal
Workbench state rather than additional URL routes.

The root and Project routes accept no query parameters. `/open` accepts either
no query or exactly one non-empty `path` parameter; unknown parameters,
duplicate `path` values, and an explicit empty `path` return `404`. After a
successful open, Workbench replaces the address with the clean canonical
`/projects/<project-id>` path rather than retaining query parameters from the
entry URL.

Workbench accepts no URL fragment. Because a browser does not send `#...` to
Runtime, bootstrap rejects a non-empty fragment locally with the Not Found
surface before it creates a Workbench connection or attempts a Project open.
It does not ignore, preserve, or remove the fragment automatically.

The Project id path segment uses the same current stable-id contract as Project
metadata: 1–256 ASCII bytes containing only letters, digits, `.`, `_`, `~`, or
`-`, excluding the complete values `.` and `..`. It remains an opaque id rather
than a UUID-only value. Percent-encoded,
Unicode, empty, oversized, or otherwise non-canonical segments return `404`
instead of being decoded or normalized into another id.

## Shell, Layers, And Floating Windows

The shell is Canvas-first. The layer token order is Canvas, floating bars,
floating panels, title bar, notifications, overlays, and title-bar menus.
Ordinary panel stacking inside the panel layer is controlled by
`workbenchWindowOrder.ts`; floating text editors participate in the same
back-to-front ordering.

Every valid Workbench shell paints one Canvas background from the top of the
window through the main viewport. The actual Canvas surface uses the same field
and origin. The title bar is transparent: Canvas Nodes remain visible below its
menus, title, and window controls instead of being covered by a second title-bar
background. Its reserved top hit area still owns window dragging and title-bar
controls, so Canvas interaction cannot begin there. Local text/icon contrast and
control interaction fills preserve chrome legibility without forming a strip.

An unbound Workbench, Project-opening progress, Project-open errors, an absent
Canvas, and Canvas repair place their focused content directly over this
background, centered below the title-bar hit area. Open failures remain visible
below the corresponding Project action until another attempt begins. The shared
appearance does not create a Canvas domain object or admit Canvas interaction
before a real Canvas projection exists. The Not Found page is not a Workbench
shell and keeps its independent error presentation.

When a bound Project is preempted or its Runtime connection ends, the last
accepted Canvas remains visible. A solid, non-dismissible dialog sits on a
transparent blocking layer below the title bar. The Canvas, floating bars, and
panels are inert, Canvas-owned global input is disabled, and transient Canvas
menus are closed while the dialog is present; the title bar remains available
for opening another Project or closing the window.

The floating dock controls exactly four panel kinds: Explorer, Inspector,
Settings, and Terminal. `WorkbenchFloatingPanelShell` is their single frame. It
renders the panel name once, owns drag and eight-direction resize interaction,
close placement, body overflow, and z-order, while each feature supplies only
its body.

Panel definitions own initial and minimum/maximum dimensions. Dragging and
viewport resize keep a usable drag area visible rather than forcing the entire
panel inside the viewport. Open panel geometry and active Canvas are stored in
tab-local session storage keyed by Project id. Each entry is one complete,
closed current view snapshot containing only the active Canvas id and floating
panel state. Saving writes that exact snapshot. Accepted HTTP Project opens
restore that Project's active Canvas and floating-panel layout and reset
unrelated transient window state.
The snapshot is accepted only as one complete closed value. Invalid JSON,
unknown fields, missing panel entries, non-finite geometry, and incorrect field
types reject the whole snapshot rather than preserving valid-looking fields.
When an entry exists, its floating-panel state is required and contains exactly
Explorer, Inspector, Settings, and Terminal with complete open and geometry
values; the active Canvas id alone may be absent when no Canvas is active. An
absent storage entry, rather than a partial object, represents a first open.
Because this state is disposable presentation rather than Project data, Workbench
reports the validation failure once, removes the rejected tab-local entry, and
opens the already-bound Project with its current first-open view defaults. It does
not silently repair or rewrite the rejected value.

Canvas floating bars use separate placement helpers because they are attached
to Canvas objects or reserved screen edges. Their collision and viewport rules
do not replace floating-panel geometry.

Canvas camera, selection, pointer drag state, and Manual Layout Drafts are owned
by `CanvasEditorRuntime` rather than React component state or Canvas JSON. An
internal Manual Layout lifecycle module owns active and submitted drafts,
submission identity, confirmation, and rejection. `CanvasSurface` supplies DOM
pointer facts and the latest Canvas Projection; `CanvasEditor` wires the existing
Runtime mutation action into the lifecycle. Neither owns a parallel draft
lifecycle. Rendering combines the
Canvas Projection with submitted drafts in submission order and then the active
draft, so nodes, edges, culling, and overlays observe one interaction geometry
while earlier submissions await confirmation.
See [`canvas.md`](./canvas.md) for the Canvas document, layout, registry, and
interaction contract, and [`canvas-rendering.md`](./canvas-rendering.md) for
render scheduling, virtualization, preview resources, and diagnostics.
Text buffers, CodeMirror ownership, inline handoff, and Canvas text preview
capture are documented in [`text-files.md`](./text-files.md).

## Title Bar And Menus

The title bar is a Web presentation derived directly from current Project
state, the Runtime-owned recent-Projects projection, current language, and host
presentation flags. Workbench does not store a second mutable title-bar model,
keep refs that duplicate those inputs, or rebuild it through a separate refresh
path. A recent-Projects event updates its one projection and normal rendering
derives the corresponding menu immediately.

The Workbench build contains one closed `darwin` or `win32` platform constant
selected by the native Product build. Web-owned shell code defines and
localizes menu labels and presentation models. The shared protocol contains
only semantic command ids and payloads that cross the Web/Electron boundary.
The Electron main process executes native window and menu commands; the browser
surface implements its supported project and document-edit commands directly.
Workbench does not infer the platform from browser APIs or receive a duplicate
platform value from Runtime.

The shared Desktop command ids describe only commands that can actually cross
the renderer boundary. Electron executes that closed set exhaustively and does
not acknowledge an unknown command as successful. macOS speech commands remain
native application-menu roles rather than unused Web title-bar command ids.

Presentation is host-aware: macOS Desktop reserves traffic-light space and uses
native menus, Windows Desktop renders window controls, and the browser renders
Web menus without native window controls. Title-bar presentation is derived
synchronously from the host-fixed platform.

Desktop lifecycle, native menu execution, preload scope, and Runtime connection
are documented in [`desktop-shell.md`](./desktop-shell.md).

## Settings, Theme, And Language

Settings has one directory and one content surface. Its current pages are
General; Image, Video, TTS, Music, and SFX Models; Integrations; and Adobe
Bridge. Runtime-owned Global Settings and Product projections have only loading
and ready states because connection failure ends the Workbench. The Adobe Bridge
live resource additionally owns its retryable error state. Persisted Adobe
Bridge enablement comes from global settings while discovery, clients, links,
and transfers remain a separate live resource.

Workbench sends closed partial settings mutations. Editable model text fields
are trimmed before submission; Runtime accepts only already-canonical values
and does not repeat that normalization. Empty settings objects and unknown
fields are errors, while submitting a valid value that is already current is an
idempotent no-op.

The runtime persists `system`, `dark`, or `light` as the Workbench theme
preference. `system` follows `prefers-color-scheme`; the resolved value is
applied to the document root as `data-theme`. Both theme branches live in the
single token file. Each Desktop launch response carries the current Runtime
preference as a launch-time presentation snapshot. Electron resolves `system`
with its native system theme and applies the matching pre-render window
background before loading the document. It does not persist another settings
copy or fall back to a default background when that snapshot is absent or
invalid. After bootstrap, the ordinary Runtime global snapshot and event path
continue to own live theme changes.

Workbench product copy supports `en` and `zh-CN`. Translation keys are semantic
identifiers shared by complete typed dictionaries. Missing keys and missing
interpolation parameters are implementation errors, not English fallbacks.
Each key has a current product-copy consumer; dictionaries do not reserve
generic vocabulary for possible future UI, and tests do not keep otherwise
unused keys alive.
Brand names, paths, model identifiers, protocol values, user content, and raw
external errors remain untranslated. Locale and theme changes arrive through
the Runtime-owned Global snapshot and event path described in
[`runtime-architecture.md`](./runtime-architecture.md).

## Explorer And Context Menus

Explorer derives its tree from the current Project snapshot, excludes `.git`
metadata, sorts directories before files, and naturally sorts names.
Its selection model owns selected paths, focus, and range anchor. Pointer and
keyboard behavior supports single, toggle, range, and context-menu selection,
as well as platform-appropriate copy, cut, paste, delete, and permanent-delete
commands.

External drag handling consumes the browser's complete `DataTransfer`
contract: `files`, `types`, and `items` are required collections. The optional
non-standard directory-entry method is detected per item; when it is absent,
the standard `FileList` remains the browser upload source. Missing DOM
collections are not interpreted as an empty drop.

Every platform-dependent interaction receives the required closed build
constant; missing, Linux, or unknown defaults are not interaction states.

Internal drag and drop uses the selected entry set and resolves copy or move
against a target directory. It rejects self/descendant moves, no-op moves, and
batch conflicts before mutation. External drops use native local paths when the
Electron shell exposes them; browser drops create upload entries and walk
dropped directories. Whole batches are validated before the operation begins.

One Project Path Command model describes operations on the Project root and on
single or multiple Project Path targets. Explorer pointer interaction, Project
Tree keyboard shortcuts, and Canvas context menus only supply command intent;
they do not define different command meanings. One Project-scoped coordinator
owns availability, target interpretation, confirmation, stale-result rejection,
and accepted follow-up selection, clipboard, and Canvas state.

The coordinator delegates effects rather than absorbing their implementations:
filesystem mutation and native path access cross Runtime's validated native-file
boundary, Canvas navigation remains Canvas-owned, Terminal opening remains
Terminal-owned, and Photoshop transfer remains integration-owned. Project Paths
remain the browser's normal file identity across all invocation surfaces.

The coordinator admits a Project Path Command only while its Project binding is
current and no replacement Project is opening. Starting Project replacement
closes that admission gate synchronously across Explorer, Canvas, keyboard,
inline editing, and drag-and-drop entry points. Workbench closes unsubmitted
context menus, inline edits, and Photoshop pickers, then shows that the target
Project is opening. If target selection or preparation is cancelled or fails,
the existing binding's command gate opens again.

A command submitted before that boundary remains owned by its captured Project
id and binding generation. Runtime's Project binding lease lets the accepted
request finish before the replacement binding commits; switching does not
retarget, retry, roll back, or imply cancellation of that command. Accepting the
new binding may abort a remaining Web-side wait, but transport abort is not
Runtime cancellation. After replacement, an old generation cannot update the
new Project's selection, internal clipboard, Canvas presentation, dialogs, or
notifications.

Integrations Settings behavior and the Photoshop transfer boundary are
documented in [`integrations.md`](./integrations.md) and
[`photoshop-bridge.md`](./photoshop-bridge.md).

## Executable Authorities

- Design rules: [`design-system.md`](./design-system.md).
- Tokens and primitives: `apps/web/src/workbench/ui/`.
- Shell and placement: `apps/web/src/workbench/shell/` and
  `apps/web/src/workbench/services/workbenchViewportLayout.ts`.
- Settings, theme, and language: `apps/web/src/workbench/settings/`,
  `apps/web/src/workbench/services/workbenchTheme.ts`, and
  `apps/web/src/workbench/i18n/`.
- Explorer interactions: `apps/web/src/workbench/project-explorer/` and
  `apps/web/src/workbench/services/workbenchContextMenuCommands.ts`.
- Title-bar and Web menu presentation:
  `apps/web/src/workbench/shell/`; shared semantic command protocol:
  `packages/app-protocol/src/workbenchChrome.ts`.
- Composition and project state: `apps/web/src/workbench/WorkbenchApp.tsx` and
  `apps/web/src/api/httpWorkbenchApiClient.ts`.
