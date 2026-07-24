# Workbench Front-End

Debrute Web Workbench is one React application used in browsers and Electron.
It targets pointer-and-keyboard desktop-class environments and presents the
Project, Canvas, Capability, settings, and integration surfaces through one
compact creative-tool interface.

## Design And Source Authority

[`DESIGN.md`](../DESIGN.md) is the durable human-readable design contract.
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
ordered Global and Project revisions. It never reconnects or automatically
replays a command; unexpected connection end becomes a terminal page state and
a manual page refresh creates a fresh connection. When an ordinary Desktop
open targets a Project owned by Web, the root surface requires an explicit
**Open Here** action before requesting preemption.

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

## Shell, Layers, And Floating Windows

The shell is Canvas-first. The layer token order is Canvas, floating bars,
floating panels, title bar, notifications, overlays, and title-bar menus.
Ordinary panel stacking inside the panel layer is controlled by
`workbenchWindowOrder.ts`; floating text editors participate in the same
back-to-front ordering.

The floating dock controls exactly four panel kinds: Explorer, Inspector,
Settings, and Terminal. `WorkbenchFloatingPanelShell` is their single frame. It
renders the panel name once, owns drag and eight-direction resize interaction,
close placement, body overflow, and z-order, while each feature supplies only
its body.

Panel definitions own initial and minimum/maximum dimensions. Dragging and
viewport resize keep a usable drag area visible rather than forcing the entire
panel inside the viewport. Open panel geometry and active Canvas are stored as
tab-local view state keyed by project id and Workbench client id. Accepted HTTP
project opens restore that project's view state and reset unrelated transient
window state.

Canvas floating bars use separate placement helpers because they are attached
to Canvas objects or reserved screen edges. Their collision and viewport rules
do not replace floating-panel geometry.

Canvas camera, selection, pointer drag state, and local layout drafts are owned
by `CanvasEditorRuntime` rather than React component state or Canvas JSON.
Rendering combines durable projection state with the active or pending local
draft so nodes, edges, culling, and overlays observe one interaction geometry.
See [`canvas.md`](./canvas.md) for the Canvas document, layout, registry, and
interaction contract, and [`canvas-rendering.md`](./canvas-rendering.md) for
render scheduling, virtualization, preview resources, and diagnostics.
Text buffers, CodeMirror ownership, inline handoff, and Canvas text preview
capture are documented in [`text-files.md`](./text-files.md).

## Title Bar And Menus

The runtime-backed title-bar state contains the project title, recent project
roots, host/platform presentation flags, and one menu command model. The Web
title bar localizes that model and owns keyboard/pointer menu interaction. The
Electron main process executes native window and menu commands; the browser
surface implements its supported project and document-edit commands directly.

Presentation is host-aware: macOS Desktop reserves traffic-light space and uses
native menus, Windows Desktop renders window controls, and the browser renders
Web menus without native window controls. A failed title-bar refresh
cannot overwrite a newer request; unavailable state removes commands instead of
inventing stale menu data.

Desktop lifecycle, native menu execution, preload scope, and Runtime connection
are documented in [`desktop-shell.md`](./desktop-shell.md).

## Settings, Theme, And Language

Settings has one directory and one content surface. Its current pages are
General; Image, Video, TTS, Music, and SFX Models; Integrations; and Adobe
Bridge. `SettingsResourcePanel` renders one page title and the loading, retryable
error, or ready body. Persisted Adobe Bridge enablement comes from global
settings while discovery, clients, links, and transfers remain a separate live
resource.

The runtime persists `system`, `dark`, or `light` as the Workbench theme
preference. `system` follows `prefers-color-scheme`; the resolved value is
applied to the document root as `data-theme`. Both theme branches live in the
single token file. Electron derives the pre-render window background from the
same runtime setting and native system theme.

Workbench product copy supports `en` and `zh-CN`. Translation keys are semantic
identifiers shared by complete typed dictionaries. Missing keys and missing
interpolation parameters are implementation errors, not English fallbacks.
Brand names, paths, model identifiers, protocol values, user content, and raw
external errors remain untranslated. Locale and theme changes arrive through
the runtime-owned global settings response and event path described in
[`runtime-architecture.md`](./runtime-architecture.md).

## Explorer And Context Menus

Explorer derives its tree from the current Project snapshot, excludes `.git`
metadata, sorts directories before files, and naturally sorts names.
Its selection model owns selected paths, focus, and range anchor. Pointer and
keyboard behavior supports single, toggle, range, and context-menu selection,
as well as platform-appropriate copy, cut, paste, delete, and permanent-delete
commands.

Internal drag and drop uses the selected entry set and resolves copy or move
against a target directory. It rejects self/descendant moves, no-op moves, and
batch conflicts before mutation. External drops use native local paths when the
Electron shell exposes them; browser drops create upload entries and walk
dropped directories. Whole batches are validated before the operation begins.

One context-menu model describes Explorer and Canvas path targets. It enables
actions from target kind, selection cardinality, clipboard state, active Canvas
projection, host platform, and Adobe Bridge availability. File commands are
dispatched through Explorer-owned semantic commands even when invoked from a
Canvas target. Copy Path, reveal, and recoverable deletion cross Runtime's
validated native-file boundary; project-relative paths remain the browser's
normal identity.

Integrations Settings behavior and the Photoshop transfer boundary are
documented in [`integrations.md`](./integrations.md) and
[`photoshop-bridge.md`](./photoshop-bridge.md).

## Executable Authorities

- Design rules: `DESIGN.md`.
- Tokens and primitives: `apps/web/src/workbench/ui/`.
- Shell and placement: `apps/web/src/workbench/shell/` and
  `apps/web/src/workbench/services/workbenchViewportLayout.ts`.
- Settings, theme, and language: `apps/web/src/workbench/settings/`,
  `apps/web/src/workbench/services/workbenchTheme.ts`, and
  `apps/web/src/workbench/i18n/`.
- Explorer interactions: `apps/web/src/workbench/project-explorer/` and
  `apps/web/src/workbench/services/workbenchContextMenuCommands.ts`.
- Runtime-backed title-bar model: `packages/app-protocol/src/workbenchChrome.ts`.
- Composition and project state: `apps/web/src/workbench/WorkbenchApp.tsx` and
  `apps/web/src/api/httpWorkbenchApiClient.ts`.
