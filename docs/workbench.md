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
shell, focused controllers, Project binding lifecycle, Project projection,
Canvas runtime, editors, and feature views. The HTTP client owns one long-lived
POST SSE Workbench connection, its in-memory command credential, wire delivery,
and command/revision waiting. It does not own the accepted Project projection or
frontend binding lifecycle. Concurrent ordinary-browser tabs share their storage
partition's HttpOnly browser session but retain independent connections,
credentials, and Project bindings. The client never reconnects or automatically
replays a command; unexpected connection end becomes a terminal connection state
and a manual page refresh creates a fresh connection. An accepted Project retains
its last Canvas beneath a blocking connection dialog; an unbound Workbench
presents the connection error directly over its Canvas background.

`WorkbenchProjectProjection` is the accepted frontend authority for Project
identity, binding generation, ordered Project revision, complete snapshot,
detach, and projection failure. One Project binding lifecycle owns a concrete
target's single in-flight open, synchronous Project Path Command admission,
binding-outcome interpretation, and Project-URL commit eligibility. It delegates
transport to the HTTP client and accepted-state publication to the projection;
it does not own React presentation or command completion.

The Terminal hub owns a separate Project-scoped collection projection. It
accepts one initial synchronized snapshot and only contiguous full topology
revisions after it; `TerminalPanel` renders that projection rather than issuing
a parallel HTTP list request. Create and close responses express command
outcomes and activation intent, while topology establishes collection
membership. Output and controls remain explicit per-Terminal observations.

The document does not mount React from guessed defaults. Bootstrap first waits
for the Runtime-owned Global Settings snapshot, applies its resolved theme,
and accepts that frame into `WorkbenchGlobalProjection` before it imports and
mounts the Workbench composition root. Bootstrap keeps following ordered theme
events and remains transparent until the presentation controller commits the
current projection, then hands document-theme ownership to that controller.
Theme, locale, recent Projects, Canvas
Text Appearance, Product, Integration, and Photoshop presentation read that same
ordered in-memory projection rather than receiving copied bootstrap props or
maintaining a second frontend settings store. During that wait the renderer is transparent, so
Electron's authoritative native launch background remains visible. Product,
Integration discovery, and live Photoshop state are separate Global resources;
Integration work starts only when Settings is activated. The initial stream and
subsequent events always project complete live Photoshop sessions and Documents. Accepted results enter
the projection through ordered Global events. Their slower work
cannot delay settings or the first Workbench shell. A
requested Project binding is also prepared after the Global Settings frame and
cannot delay it.

A successful `project.bound` event is one complete Project-open result:
Project id, ordered revision, snapshot, and current Working Copies travel
together from the HTTP client through startup to the composition root. An
unbound or failed startup has no Project result; the Workbench does not split a
successful binding into independently optional fields or reconstruct a partial
Project from them.

In a browser, replacing Project A with Project B is a prepared handoff on the
same Workbench connection. Runtime first opens and validates B while A remains authoritative,
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

A browser open, or **Open Here** from a detached Desktop Workbench, directly
acquires its concrete target at that commit and may displace a different owner.
The requesting destination does not show another ownership confirmation; the
displaced Workbench becomes detached and offers **Open Here**.

Ordinary Desktop opens do not replace the requesting Workbench. Native Desktop
activation focuses an existing window for the same Project. Otherwise it may
bind a live Desktop Workbench only when the current document started at Root and
has never accepted a Project binding, preferring an eligible initiating window
or a sole eligible empty window when no source exists. It opens a new window
instead of reusing a Project-bound, detached, or ambiguous empty window. The
Desktop connection is rejected by `/api/projects/replace`; only detached **Open
Here** deliberately reacquires ownership in that same window.

Only after `WorkbenchProjectProjection` accepts the complete `project.bound`
baseline may the binding lifecycle commit the canonical Project URL. A failed
preparation preserves the requesting Workbench's accepted Project and URL. An
accepted replacement retires the source binding and is never rolled back by a
later frontend completion.

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

- `WorkbenchGlobalProjection` accepts the initial Runtime Global snapshot and
  every ordered Global event, fails closed on a revision gap, and preserves the
  last accepted value when the connection ends.
- `WorkbenchProjectProjection` accepts each complete `project.bound` baseline
  and contiguous Project event, and owns the current identity, binding
  generation, snapshot, detach, and projection failure.
- The Project binding lifecycle owns concrete-target attempts, command
  admission, structured outcomes, and URL eligibility without owning transport,
  accepted Project state, React presentation, or Project-command completion.
- Bootstrap writes the pre-mount document theme and follows ordered Global
  changes until React commits. It then unsubscribes and
  `useWorkbenchPresentationController` becomes the only document theme writer,
  deriving theme and locale from that projection.
- `useWorkbenchSettingsController` exists only after the first Settings
  activation and then remains alive until that Workbench ends, independently
  of the open Settings panel. It owns Settings commands, Integration retry
  errors, and the Canvas Text Appearance save lifecycle while reconciling
  accepted values from `WorkbenchGlobalProjection`; it does not own theme,
  locale, or another accepted Global snapshot.
- `useProjectExplorerController` loads only after Explorer or a file-command
  surface expresses intent, then owns selection, clipboard, inline edits, file
  commands, and invalidation when the project changes.
- Canvas controllers own Canvas feedback, overlays, and runtime interaction.
- Text services own editor buffers and floating editor windows.
- Shell modules own panel geometry, viewport reconciliation, and window order.

Resources that may load or fail use explicit loading, ready, and error states.
The owner of an asynchronous operation applies request-version or
project-generation checks where overlapping results can occur. Failed loads are
not converted into successful empty data, and failed saves leave the relevant
draft available with an owning error state.

The initial JavaScript graph contains only the bootstrap and critical
Workbench shell. Settings, Explorer presentation, Inspector, Terminal panel
and WebSocket Hub,
floating text windows, Canvas video controls, the CodeMirror engine, and each
CodeMirror language parser load from separate chunks when their owning surface
first needs them. Optional features mount from the current Global and Project
projections, so events accepted before activation are not replayed or lost.
After first activation, the Settings lifecycle host remains mounted while its
panel may close and reopen; other optional feature surfaces keep their owning
lifecycle rules.
Canvas managed fonts gate only active Canvas text surfaces and floating text
windows; they never block the shell, Explorer, Settings, or a Project-open
result. The production build manifest enforces gzip ceilings of 80 KiB for the
bootstrap graph and 250 KiB for the critical Workbench graph, and rejects an
eager Settings, Explorer, Inspector, Terminal panel or Hub, floating-text-window,
video-control, CodeMirror-engine, or language-parser dependency.

Development startup instrumentation is explicit. `pnpm dev -- --startup-perf`
or `pnpm dev:electron -- --startup-perf` records bounded Performance marks and
console entries from the navigation performance origin for main evaluation,
Global snapshot, theme, Workbench chunk, React commit, first surface commit,
first Project-open request and Project-surface commit, and first optional-feature
request and readiness. `shell-fonts-ready` waits only for the Smiley display
face and Noto Sans SC 400/600/700 faces used by the committed shell, while
`canvas-text-ready` records completion of the
managed Font Resource for the first active text Canvas. A text Project is not
reported as fully interactive merely because its shell committed while that
resource is still preparing. The Project request mark is recorded at the HTTP binding
boundary, including initial `/projects/<project-id>` and `/open?path=...`
navigation rather than only post-mount UI actions. Text-editor readiness means
the actual CodeMirror engine chunk is loaded, not merely its floating-window
shell. The native directory picker is a separate selection command: cancellation
records no Project-open mark, and the binding mark begins only after a path is
selected, so human picker time is excluded. Without the flag it records and
publishes nothing, and it never
registers a production debugging global.

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

An unbound Workbench, its Project-opening progress and initial Project-open
failure, an absent Canvas, and Canvas repair place their focused content directly
over this background, centered below the title-bar hit area. The initial failure
remains visible below the corresponding Project action until another attempt
begins. During a browser bound A-to-B open, A's last accepted presentation
remains visible with an opening state and no new Project Path Command admission;
failed preparation restores A and reports a non-blocking notification. Selector
cancel, a repeated open ignored while another attempt is active, and a
superseded attempt report no error.
The shared appearance does not create a Canvas domain object or admit Canvas
interaction before a real Canvas projection exists. The Not Found page is not a
Workbench shell and keeps its independent error presentation.

When a bound Project is preempted or its Runtime connection ends, the last
accepted Canvas remains visible. A solid, non-dismissible dialog sits on a
transparent blocking layer below the title bar. The Canvas, floating bars, and
panels are inert, Canvas-owned global input is disabled, and transient Canvas
menus are closed while the dialog is present; the title bar remains available
for opening another Project or closing the window. If detached **Open Here**
fails, the Workbench remains detached and presents the failure beside that
dialog action.

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
General; Appearance; Image, Video, TTS, Music, and SFX Models; and Integrations.
Appearance composes the Workbench Theme mode with the separate
global Canvas Text Appearance controls; General retains language, product
information, and updates. Runtime-owned Global Settings is
ready before React mounts. Product and Integration projections retain their own
loading and ready states because they arrive independently; connection failure
still ends the Workbench. Photoshop live state has no persisted enablement,
pairing, Project links, or separate refresh request. The initial stream and
ordered Photoshop events are its only Workbench authority.

Workbench sends closed partial settings mutations. Editable model text fields
are trimmed before submission; Runtime accepts only already-canonical values
and does not repeat that normalization. Empty settings objects and unknown
fields are errors, while submitting a valid value that is already current is an
idempotent no-op. Settings resources and commands remain private to the
Settings feature instead of being added to the shared Workbench state and
action bags.

Canvas Text Appearance mutations always carry the complete font ID, font size,
line-height ratio, requested weight, letter spacing, and ligature value. Valid
control changes update the local Canvas immediately. Each Workbench window
serializes its own submissions and replaces only an unsent appearance with the
newest complete value. A successful mutation response is not confirmation: the
local value remains presented until an ordered `globalSettings.changed` event
contains the same complete Canvas Text Appearance. Earlier mismatching events
do not clear it, and a newer local submission retires any older value still
awaiting confirmation. After a match, later Runtime events win. Runtime event
order remains authoritative across windows, and a rejected submission cancels
its unsent coalesced work and restores the latest Runtime-confirmed value.

The runtime persists `system`, `dark`, or `light` as the Workbench theme
preference. `system` follows `prefers-color-scheme`; the resolved value is
applied to the document root as `data-theme`. Both theme branches live in the
single token file. Each Desktop launch response carries the current Runtime
preference as a launch-time presentation snapshot. Electron resolves `system`
with its native system theme and applies the matching pre-render window
background before loading the document. It does not persist another settings
copy or fall back to a default background when that snapshot is absent or
invalid. After bootstrap, the ordinary Runtime global snapshot and event path
continue to own live theme changes. The renderer remains transparent until the
authoritative Global Settings projection has applied its latest ordered theme
and the React presentation controller commits that same projection; only then
does bootstrap remove its marker and paint normal content.

Workbench product copy supports `en` and `zh-CN`. Translation keys are semantic
identifiers shared by complete typed dictionaries. Missing keys and missing
interpolation parameters are implementation errors, not English fallbacks.
Each key has a current product-copy consumer; dictionaries do not reserve
generic vocabulary for possible future UI, and tests do not keep otherwise
unused keys alive.
Brand names, paths, model identifiers, protocol values, user content, and raw
external errors remain untranslated. Locale, Theme, and Canvas Text Appearance
changes arrive through the Runtime-owned Global snapshot and event path
described in [`runtime-architecture.md`](./runtime-architecture.md).

## Explorer And Context Menus

Explorer derives its tree from the current Project snapshot, excludes `.git`
metadata, sorts directories before files, and naturally sorts names.
Opening a Project loads only the root's direct visible children. Expanding a
collapsed directory issues one revisioned Runtime directory-load command and
adds only that directory's direct children to the current snapshot without
reloading unrelated Project documents; repeated expansion is a no-op. Creating
inside a collapsed directory first loads that parent. After the shallow
`project.bound` snapshot is queued and its event stream is running, Runtime may
build its complete Canvas/file index in a session-owned background task. That
private index is not serialized into Explorer, does not inflate the initial
tree, and never delays the first bound Project view.
Closing the Project cancels and joins the task; scan failure keeps the shallow
tree usable and appears as a retryable Project diagnostic. Automatic indexing
and filesystem events share one filter: nested `.gitignore` rules and standard
dependency, cache, and build directories are excluded. An explicit Explorer
expansion still reads one requested directory and keeps its direct children as
session watch dependencies, so exclusion removes background work rather than
making the path inaccessible or stale.
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
they do not define different command meanings. One Project-scoped intake
authority owns admission and atomically captures the accepted Project id and
binding generation in an opaque command scope. Every context-menu, keyboard,
inline-edit, drag-and-drop, and Canvas Project Path entry point must obtain that
scope. A command effect cannot be submitted without it.

The intake authority does not own interaction state or command implementations.
Explorer retains selection, clipboard, and inline-edit presentation; drag and
drop retains `DataTransfer` and modifier interpretation; Canvas retains
selection and camera behavior. Shared target and conflict rules remain pure
policies. A menu and keyboard router only translates those surfaces into the
same commands and is not an admission authority.

One scoped effect boundary is the only Workbench module that invokes Runtime
Project Path adapters. It verifies that the captured scope is still admitted at
the instant an effect is submitted. The Workbench composition root constructs
that boundary from the full API; the generation subtree's API type omits the raw
Project Path adapter methods, so feature modules cannot bypass the boundary.
Filesystem mutation and native path access then cross Runtime's validated
native-file boundary, Canvas navigation remains Canvas-owned, and Photoshop
transfer remains integration-owned. A context-menu Terminal request carries the
same accepted scope through lazy feature loading and rechecks it immediately
before Terminal creates the requested session. Project Paths remain the
browser's normal file identity across all invocation surfaces.

For one Project-backed PNG, JPEG, WebP, or PSD file whose snapshot `sizeBytes`
is at most 256 MiB, the shared Explorer/Canvas context menu adds **Send to
Photoshop**. A bounded keyboard-accessible submenu lists every live Photoshop
Document, including equal titles, and each row owns the exact plugin-session
and Document identity. Selection closes the menu and sends immediately; there
is no dialog, remembered target, or Photoshop Settings page. One notification
is updated in place from sending to its terminal result.

Browser target selection and detached Desktop **Open Here** enter the Project
binding lifecycle. While the selector is open, the current binding remains
admitted; cancel submits no binding attempt and changes nothing. Once a concrete
target enters the lifecycle, it closes Project Path Command admission
synchronously, before transport or any asynchronous preparation, across
Explorer, Canvas, keyboard, inline editing, and drag-and-drop entry points.
Workbench closes unsubmitted context menus and inline edits, then shows that the
target Project is opening. Failed preparation reopens the unchanged binding's
gate. An accepted `project.bound` retires the old gate and mounts fresh admission
with the new generation. A second open in the same Workbench does not start
another concurrent transport attempt. Ordinary Desktop selectors submit native
activation instead. If the initiating document is a true empty-window candidate,
Runtime commits the ordinary `project.bound` lifecycle there; otherwise its
gate remains unchanged while Runtime focuses or opens the destination window.

A command submitted before that boundary remains owned by its captured Project
id and binding generation. Runtime's Project binding lease lets the accepted
request finish before the replacement binding commits; switching does not
retarget, retry, roll back, or imply cancellation of that command. Accepting the
new binding may abort a remaining Web-side wait, but transport abort is not
Runtime cancellation. Project-local Explorer, selection, inline-edit, and Canvas
presentation state lives beneath the generation-keyed subtree and retires with
the old generation. Only a completion that can escape into shared clipboard,
Canvas navigation, or global-notification state performs a narrow current-scope
check through its accepted command scope. This Web capability is in-memory,
unforgeable by ordinary callers, and contains only Project identity and binding
generation checks; it is not a queue, Runtime lease, cancellation token, retry,
or rollback mechanism. The Project binding lifecycle owns admission state and
does not own command completion.

Product Quit has a narrower completion boundary. Runtime first stops accepting
new work and signals every Workbench connection and Project request lifetime.
An HTTP request still reading or awaiting its body, preview, or another
pre-command stage is dropped and never enters a Project command. A synchronous
Project command that has already begun remains an accepted atomic transaction
and finishes normally; Quit does not kill, roll back, retry, or redirect it.

HTTP-originated connection retirement and Product Quit drain through one
Runtime-owned `ConnectionCloser` thread. An SSE response guard only enqueues its
connection credential, so dropping that guard on the single-thread Workbench
HTTP runtime cannot synchronously wait for another future on the same runtime
to release its Project binding lease. Product Quit waits at most 500 ms for the
connection drain. A timeout records one redacted numeric diagnostic containing
only the duration, connection count, and bound-Project count, then Quit
continues successfully. The accepted transaction and queued close continue on
the owned closer, which is joined during Runtime service teardown. The
Workbench HTTP runtime likewise gives graceful connection drain at most 500 ms
before dropping remaining request futures; neither deadline hard-kills a
Project transaction or changes an accepted modification.

Integrations Settings behavior and the Photoshop transfer boundary are
documented in [`integrations.md`](./integrations.md) and
[`photoshop.md`](./photoshop.md).

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
- Composition: `apps/web/src/workbench/WorkbenchApp.tsx`.
- Project binding lifecycle and accepted Project projection:
  `apps/web/src/workbench/services/projectBindingLifecycle.ts` and
  `apps/web/src/workbench/services/WorkbenchProjectProjection.ts`.
- Workbench transport and revision waiting:
  `apps/web/src/api/httpWorkbenchApiClient.ts`.
