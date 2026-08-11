# Photoshop File Transfer

This is the single current design and product contract for Debrute's Photoshop
integration. ADRs record why durable boundaries were chosen and research notes
provide evidence; neither defines another current contract.

Debrute has one Photoshop-specific UXP plugin. Its only responsibility is
moving file resources between Photoshop and open Debrute Projects through the
local Rust Runtime. It is not a general professional-application layer and
does not expose Canvas, generation, Project administration, or Workbench
authority inside Photoshop.

Professional applications are peer integrations. Photoshop has its own names,
routes, protocol, and modules. A future Premiere Pro, DaVinci Resolve, or other
integration does not inherit Photoshop authority or sit below an Adobe vendor
layer. Shared infrastructure is extracted only after a second implementation
proves the same contract.

## Contract At A Glance

| Direction | User source | Exact target | File representation | Command bounds |
| --- | --- | --- | --- | --- |
| Debrute to Photoshop | One eligible Project file selected through its Workbench or Canvas context menu | One explicitly selected live Photoshop Document | One Embedded Smart Object containing an immutable copy of the source file | One file, at most 256 MiB |
| Photoshop to Debrute | The exact layers and groups selected when Send is pressed | One explicitly selected live Project directory | One independent, full-canvas PNG per selected item, preserving source alpha | At most 50 items, 256 MiB per PNG, and 1 GiB per batch |

The contract has five invariants:

1. Targets are explicit and exact. Focus changes, reconnects, missing targets,
   and stale projections never cause fallback to another Document, Project, or
   directory.
2. Admission captures immutable source and target state. Later edits,
   selections, navigation, or expansion affect only later commands.
3. Runtime owns live sessions, Project visibility, path validation, staging,
   authorization, and settlement. The plugin receives only narrow
   Photoshop-specific authority and Project-relative paths.
4. Transfer is always an explicit user action. There is no automatic Send,
   drag-and-drop command, queue, replay, retry, or offline delivery.
5. Only the Runtime-owned Integration enable choice persists. Session,
   destination, expansion, cache, command, and result state are memory-only at
   their defined lifetimes. There is no transfer history, pairing record,
   recent destination, or other persistent Photoshop state.

## Live Sessions And Discovery

Global Settings persists the closed, default-off
`plugins.photoshop.enabled` choice. Runtime applies it at startup before the
first Workbench Photoshop projection. Off binds no Photoshop port and retains
no gateway route, session, bearer, or command authority. The Workbench
**Plugins** page is the only current setting surface; there is no Plugin
Platform master switch or per-instance connection control.

On immediately attempts the first available loopback port from `32124` through
`32131`. A successful bind publishes `waiting`; full-pool exhaustion keeps the
choice on, publishes `unavailable`, and starts one non-overlapping complete-pool
retry every five seconds. Runtime and Workbench otherwise continue normally.
Disabling an idle Integration stops that retry and gateway, closes every
session, and revokes its authority. Runtime rejects the settings intent
with `photoshop_transfer_in_progress` while either transfer direction owns a
reserved command, so an admitted transfer is not interrupted.

The plugin starts at Photoshop startup, independently of whether its panel is
open. While disconnected it runs one non-overlapping discovery round every
five seconds, including while the Runtime Integration is off. Each ordered port
candidate has a 500 ms deadline inside the five-second whole-round bound, so a
listener which accepts without completing the Photoshop handshake cannot block
later pool entries. The next round starts only after the failed round has ended
and another five seconds has elapsed. Each accepted socket receives a new
memory-only plugin session identity and HTTP bearer. Closing the socket revokes
both, removes its Photoshop Documents from every Workbench, cancels that
session's in-flight HTTP work before any later Photoshop host effect, and fails
its active command. There is no pairing, persistent plugin identity, Project
link, offline queue, retry of transfers, replay, or transfer history.

Each session start declares the exact native formats that its current
Photoshop host can place as Embedded Smart Objects. The closed list is PNG,
JPEG, WebP, PSD, and AVIF. Photoshop 24.4 and newer declare the first four;
only a recognized Photoshop version 26.8 or newer also declares AVIF. An
unrecognized host version stays on that baseline. Runtime validates and stores
this per-session declaration and includes it with the Document projection sent
to every Workbench.

The socket carries only bounded JSON control. Command bytes use two fixed HTTP
routes on the same gateway and the socket's bearer in the `Authorization`
header. UXP WebSocket connections serialize the plugin origin as `file://`, so
the gateway requires that exact Origin together with a loopback peer, exact
numeric Host, fixed socket path, and subprotocol. Photoshop 27.8 UXP `fetch`
omits Origin; HTTP therefore accepts only an absent Origin or exact `file://`,
then requires the same loopback peer and Host, a fixed route, and a live bearer.
HTTP failures use the Photoshop v1 protocol's exact error envelope and closed
error-code set. The plugin rejects unknown codes, fields outside that envelope,
and blank messages rather than treating them as Runtime errors.

## Debrute To Photoshop

For one visible Project PNG, JPEG, WebP, PSD, or AVIF file at or below 256 MiB,
the Workbench context menu shows **Send to Photoshop** only when at least one
live session reports an open Photoshop Document. Off, waiting, unavailable, an
unhydrated projection, and connected sessions with no open Documents hide the
entire submenu. A Canvas context menu uses the clicked projected node's own
availability facts, including its size; it does not depend on the Explorer's
shallow directory listing. Once visible, the submenu lists every open Photoshop
Document reported by every live plugin session.
Titles are presentation only, so duplicate titles remain separate command
targets. A Document row remains visible but is disabled when that session did
not declare the source format. An AVIF row gives the requirement
**Photoshop 26.8 or later for AVIF** instead of removing the Document.

Selecting an enabled row binds the exact plugin session and Document ID
immediately. Runtime revalidates the Project-relative source, derives its
format again, requires the bound session to have declared that format, and only
then copies it into immutable, command-owned staging. Later source edits,
rename, or deletion cannot change the transfer. Photoshop places those exact
captured bytes into the bound Document as an **Embedded Smart Object**
(`linked: false`) and verifies the result. Focus changes cannot retarget it; if
the bound Document closes, the command fails. The plugin never creates another
Document or falls back to a normal pixel layer, linked Smart Object, or other
representation.

One command always contains one source file and creates one Embedded Smart
Object. Sending several files requires several explicit commands. Debrute does
not choose a position, scale, crop, fit, alignment, or post-placement transform;
the initial presentation follows Photoshop's native embedded-placement behavior.

The context menu closes on submission. Runtime creates one non-blocking
Photoshop Activity task before transfer and updates that same record to its
terminal result. Every connected Workbench sees it. A session admits only one
command at a time; another command fails as busy instead of being queued.

## Photoshop To Debrute

The plugin panel is one direct page with three fixed regions: compact
connection and selection state, one flexible always-open destination browser,
and the latest result plus Send action. Only the destination rows scroll. The
selection summary is compact, for example `Poster.psd · 3 selected`; the panel
does not repeat every selected layer name. Its connection presentation has only
`Connected` after a completed Runtime handshake and `Waiting` for every other
internal discovery phase. It cannot distinguish an intentionally disabled
Runtime gateway from an absent Runtime and exposes no manual connection action.

The destination browser is one always-visible Explorer-style directory tree.
Every live Project is an independent top-level root, and Project roots and
directory rows are exact selectable destinations. Clicking the complete row
selects that destination and toggles its expanded state; there is no separate
disclosure hit target, confirmation, directory field, parent page, or **Select
this directory** action. Multiple Projects and directory branches can remain
expanded at the same time. Project roots and directory siblings use
case-insensitive natural ordering, so `folder2` precedes `folder10`, while
identity remains the exact Canonical Root and complete Project-relative directory.
Duplicate displayed names are not merged or supplemented with generated labels.
Rows use the same closed/open folder artwork, left alignment, 24-pixel row
geometry, 14-pixel hierarchy step, guide lines, and selected/focused treatment
as the Workbench Explorer. Neutral colors still come from the Photoshop host
theme, while Debrute clay identifies the selected destination. Expansion has
no separate triangle column.

Runtime initially publishes only live canonical roots, names, and revisions,
so every Project root starts collapsed without an eager directory scan. The
first expansion of one Project requests only that Project's complete current
writable-directory snapshot. While it loads, the Project root is already the
selected valid destination and one muted non-interactive **Loading
directories…** child appears; a valid export to that root does not wait for its
children. An unchanged Project reuses its process-memory snapshot. A revision
change invalidates and, when still expanded or needed to revalidate selection,
reloads only that Project. An empty Project has no invented child row. The
snapshot contains ordinary writable directories even when `.gitignore`
excludes them; Git ignore rules do not define Photoshop transfer targets.
Fixed dependency/build exclusions, symbolic links, `.git`, and the complete
protected `.debrute` namespace remain unavailable.

The loaded plugin Runtime owns the single selected destination, the expanded
node set, pending requests, and same-revision directory caches in memory.
Closing and reopening the panel restores the expanded tree and reveals the
selected row. A transient disconnect preserves expansion intent and the
destination candidate but invalidates directory caches; reconnection reloads
only the required live Projects before a directory selection becomes valid
again. A live snapshot that removes a Project or directory clears that exact
selection and prunes its unavailable expansion entries without selecting a
parent or sibling. Photoshop or plugin restart resets selection, expansion,
cache, and scroll state because none is stored on disk.

The selected full path remains in one fixed, ellipsized summary above the tree.
The tree supports Up/Down selection across visible rows, Right to expand or
enter the first child, Left to collapse or select the parent, and Enter/Space
as the same select-and-toggle action as pointer activation. It uses singular
`tree`/`treeitem` selection semantics; there is no modifier or range selection.
The panel keeps one layout at every supported size. Only the tree viewport
scrolls, on both axes; the source and connection region, selected-path summary,
latest result, and Send action stay fixed. Runtime independently revalidates
the protected-path, fixed-exclusion, no-symlink, existence, and exact-revision
boundaries before admitting a transfer.

Send and destination browsing are independent. Clicking Send captures the
exact Photoshop Document, selected layer/group IDs, Project identity and
revision, and Project-relative directory for that command. The browser remains
usable while the transfer runs, while Send itself is disabled. Choosing a new
path prepares the next transfer and cannot retarget the active one; its result
continues to name the captured destination. Connection recovery is automatic
and informational, with no manual reconnect action or transfer retry.

Photoshop host notifications keep the displayed selection current for ordinary
selection changes, Select All Layers, Deselect Layers, Document changes, and
layer-tree changes. The send action still reads the Photoshop selection again
at the click boundary and publishes that captured selection before admission;
it never submits layer IDs retained only from an earlier panel render.

Every explicitly selected layer or group at any tree depth becomes one
independent PNG. A selected group remains one flattened transfer item rather
than expanding into descendants. Photoshop renders only that selected item,
including its native masks, effects, opacity, and alpha, into a transparent
buffer with the complete source-Document canvas dimensions. It does not crop.
Explicit selection overrides only the selected item and its ancestors being
hidden; hidden descendants remain hidden. Capture must not mutate the source
Document or its visibility.

Photoshop Imaging reads an ordinary layer directly by its exact layer ID, but
Photoshop 27.8 rejects a group ID as an unsupported pixel source. For a group,
the plugin therefore creates one modal-scoped transparent internal Document
with the same canvas, duplicates only that group into it, makes only the copied
group root visible, reads the temporary Document composite, and closes it
without saving before the modal operation finishes. Host notifications are
coalesced across that operation, so the internal Document is never published
as an open transfer target. The source Document and its visibility tree remain
unchanged.

The complete batch is captured into immutable plugin-owned temporary files
before the first upload. Uploads are serial and settle independently, so an
earlier success remains after a later failure. Limits are 50 items, 256 MiB per
PNG, and 1 GiB of captured PNG data per batch. Runtime never overwrites an
existing Project file; collisions become `name.png`, `name 2.png`, and so on.
The first candidate comes from the selected layer or group name after Runtime
replaces control and filesystem-invalid characters, trims surrounding
whitespace and trailing dots, and bounds the stem to 120 characters. An empty
safe name becomes `Photoshop File.png`.
Runtime reads each plugin-owned temporary PNG into a Project-owned staging file
and syncs that file before the no-replace commit; the UXP temporary path itself
is never installed as a Project file. Temporary files are deleted after their
terminal result. Project, staging, I/O, and Photoshop host diagnostics remain in
the local Runtime log. Photoshop and Workbench receive only the closed error
code and its reviewed path-free user message; temporary paths, Project roots,
and other absolute host paths never enter the transfer error response.

The final panel result names the destination captured by the admitted command
and summarizes independent item settlement. A failed item does not roll back an
earlier success or stop a later item from being attempted. The result is
transient and is replaced by the next command; it is not copied into Workbench,
system notifications, or persistent history.

## State Ownership And Lifetime

| State | Owner | Lifetime and invalidation |
| --- | --- | --- |
| Photoshop Integration enable choice | Runtime Global Settings | Persists across Runtime restarts; defaults off and is changed only by a closed Runtime settings mutation |
| Gateway port | Runtime | While enabled in one Runtime process; first free port in the closed pool, released on disable |
| Plugin session identity and bearer | Runtime | One accepted WebSocket; revoked immediately when it closes |
| Photoshop Document catalog and placement formats | UXP host snapshot projected by Runtime | Replaced atomically by live session snapshots; removed with the session |
| Live Project identities and revisions | Runtime | Current canonical-root projection only |
| Directory snapshots | UXP plugin runtime | Cached by exact Canonical Root and revision; invalidated on disconnect or revision change |
| Expanded tree nodes and selected destination candidate | UXP plugin runtime | Survive panel detach and transient reconnect; reset on plugin or Photoshop restart |
| Admitted source, target, staging, and progress | Command coordinator | One command; immutable after admission and deleted after terminal settlement |
| User-visible result | Initiating surface | Latest transient result only |

The panel is therefore a projection and command surface, not an authority. Its
visibility does not control receiver lifetime, and rebuilding its DOM cannot
reset the process-owned session, destination, expansion, or active command.

## UXP And Packaging

The plugin uses Manifest v5, UXP API 2, and Photoshop 24.4 or newer. That is the
first Photoshop release exposing the non-prerelease `photoshop.imaging` module
used for full-canvas PNG capture. UXP cannot
express this dynamic loopback port pool as a domain allow-list, so its manifest
declares network `domains: "all"`; the implementation still constructs only the
fixed loopback HTTP/WebSocket routes above. It also requests only plugin-owned
filesystem storage. The implementation is entirely under
`apps/photoshop-uxp-plugin`; there is no CEP client or cross-host Photoshop core.

The single panel layout supports a minimum of `300 x 420`, preferred docked or
floating size of `320 x 560`, and maximum of `640 x 900`. These sizes change
only the available tree viewport; they do not select a different layout,
density, or interaction mode.

Run `pnpm package:photoshop-uxp-plugin` to create
`release/photoshop-uxp/debrute-photoshop-uxp-X.Y.Z.ccx`. Packaging builds the
plugin and validates the closed archive. The package is not part of the public
GitHub Release asset contract.

The architectural rationale is recorded in ADRs
[0061](./adr/0061-photoshop-transfers-bind-an-exact-document.md),
[0062](./adr/0062-photoshop-receiver-lifetime-follows-photoshop.md),
[0063](./adr/0063-photoshop-transfers-use-explicit-live-targets.md),
[0064](./adr/0064-photoshop-connections-use-ephemeral-runtime-sessions.md),
[0065](./adr/0065-photoshop-gateway-uses-a-bounded-loopback-port-pool.md), and
[0068](./adr/0068-plugin-integration-enablement-is-runtime-owned.md).

## Explicit Non-Goals

- No crop mode, background forcing, format conversion, AVIF fallback, normal
  pixel-layer fallback, linked Smart Object, or automatic new Photoshop
  Document.
- No Project files in the destination tree, search, breadcrumb navigation,
  favorites, recents, generated duplicate-name labels, drag and drop, native
  filesystem picker, folder creation, rename, delete, or multi-selection.
- No persistent destination, expansion, scroll, cache, plugin identity,
  authorization ceremony, pairing code, Photoshop-panel settings, Project
  link, queue, cancellation, transfer retry, replay, progress percentage, or
  transfer history.
- No manual reconnect action. Discovery and recovery are automatic and never
  restore or redirect an interrupted transfer.
- No CEP implementation, generic professional-application protocol, vendor
  hierarchy, shared Adobe layer, or compatibility surface for superseded
  prelaunch code and data.
- No attempt to disambiguate duplicate Photoshop Document or Project titles in
  the first version. Identity remains exact even when labels are equal.

## Verification Contract

Automated verification must cover default-off persistence, closed Plugin
settings, conditional gateway lifetime, unavailable retry, transfer-safe
disable, strict protocol parsing, port-pool behavior, session and bearer
revocation, exact target binding, immutable staging, live-Document-gated
Workbench menus, isolated full-canvas PNG rendering, independent item
settlement, directory filtering, tree state, keyboard interaction, the
Connected/Waiting panel projection, fixed-region layout, and both-axis tree
overflow. The repository gate is `pnpm verify`, followed by `git diff --check` and
`pnpm package:photoshop-uxp-plugin` for a package candidate.

Automated tests do not substitute for real Photoshop acceptance. macOS and
Windows package candidates must be loaded through UXP Developer Tool or as the
packaged CCX and exercise both start orders, default-off and re-enable behavior,
background receiver lifetime and automatic reconnection without opening the
panel,
exact-Document Embedded Smart Object placement, layer and group export,
full-canvas alpha, deep destination selection, immutable targets while the UI
changes, disconnect behavior, and package reload. AVIF acceptance additionally
requires a real Photoshop 26.8-or-newer host on that platform.

## Executable Authorities

- Photoshop session, transfer, and gateway authority:
  `apps/runtime/src/photoshop/`.
- Project filesystem and exact-revision mutation authority:
  `apps/runtime/src/project/`.
- Workbench projection and Project Path Command:
  `apps/web/src/workbench/`.
- UXP host, transport, process lifetime, and panel:
  `apps/photoshop-uxp-plugin/src/`.
- Package creation: `scripts/package-photoshop-uxp-plugin.mjs`.
