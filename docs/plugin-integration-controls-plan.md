# Plugin Integration Runtime Controls

Status: implemented

## Outcome

Debrute will persist one Runtime-owned enable setting for each supported
professional-tool Plugin Integration. Photoshop is the first Integration and is
off by default. Enabling it starts the Runtime Photoshop gateway; disabling it
stops that gateway and revokes every Photoshop connection and its authority.
The Photoshop plugin continues automatic loopback discovery while disconnected,
so it reconnects without a manual action when both sides become available.

There is no separate Plugin Platform master setting. When every explicit Plugin
Integration is off, the platform is operationally off because no plugin gateway,
connection, route, bearer, or command authority remains. Future Integrations add
their own reviewed, default-off fields and lifecycle controllers; they do not
join an arbitrary plugin registry or inherit the Photoshop protocol.

## Terms And Authority

**Plugin Integration** is one supported professional-tool plugin family, such
as Photoshop. It owns its protocol, gateway lifecycle, sessions, commands, and
host-specific behavior.

**Plugin Connection** is one current ephemeral session between Runtime and a
running plugin host. It is not a persistent installation or identity and has no
manual Connect or Disconnect action.

Runtime is the only settings and connection authority. Workbench Settings sends
commands and renders Runtime projections. The Photoshop panel observes only
whether its own connection handshake has succeeded.

The removed `adobeBridge` contract remains removed. This change does not restore
CEP support, pairing, stable plugin identity, Project links, saved destinations,
offline delivery, transfer replay, or the former manual client controls.

## Closed Persisted And Live Contracts

### Global Settings

The persisted and public Global Settings view gains one explicit field:

```ts
interface PluginSettings {
  photoshop: {
    enabled: boolean;
  };
}

interface DebruteGlobalSettingsView {
  // Existing fields remain unchanged.
  plugins: PluginSettings;
}

interface SaveDebruteGlobalSettingsInput {
  // Existing patches remain unchanged.
  plugins?: {
    photoshop: {
      enabled: boolean;
    };
  };
}
```

The Rust persisted schema mirrors this structure with closed
`deny_unknown_fields` records. A fresh store defaults
`plugins.photoshop.enabled` to `false`. Because Debrute has not launched, an
existing settings file that omits `plugins` or `photoshop` is invalid rather
than migrated or repaired. The legacy `adobeBridge` field and arbitrary plugin
IDs continue to fail validation.

`GlobalConfigStore` remains the sole persistence and serialization boundary.
Only enable choices are stored. Gateway health, retry state, sessions,
Documents, credentials, commands, transfer activity, and diagnostics remain
process-memory state.

Plugin patches are closed and atomic. Empty plugin patches, incomplete
Photoshop values, unknown plugin names, and unknown fields are errors. A patch
that attempts to disable busy Photoshop together with unrelated settings fails
as one unit; it must not partially persist the unrelated fields.

### Live Photoshop Projection

Extend the existing ordered Photoshop resource instead of introducing a second
plugin-state endpoint:

```ts
type PhotoshopIntegrationStatus =
  | 'off'
  | 'waiting'
  | 'connected'
  | 'unavailable';

interface PhotoshopStateView {
  status: PhotoshopIntegrationStatus;
  transferActive: boolean;
  sessions: PhotoshopSessionView[];
}
```

The projection has these invariants:

- `off`: the persisted setting is off; no gateway or session exists.
- `waiting`: the setting is on, the gateway is listening, and no session exists.
- `connected`: at least one live session exists. The displayed instance count is
  derived from `sessions.length`, never stored separately.
- `unavailable`: the setting remains on, Runtime could not bind any port in
  `32124`–`32131`, and no gateway or session exists.
- `transferActive` is true exactly when any Photoshop session owns a reserved
  place or export command. It can be true only while status is `connected`.

There is no Runtime-facing Connecting, Disabled, Disconnected, or Busy status.
The four states above and the independent `transferActive` flag are sufficient.
Unavailable has one current public meaning, so it does not need a speculative
reason registry.

## Required State Behavior

| Condition | Settings status | Photoshop toggle | Photoshop panel | `Send to Photoshop...` |
| --- | --- | --- | --- | --- |
| Integration off | `Off` | Off, interactive | `Waiting` | Hidden |
| Enabled, full port pool cannot bind | Exact `Unavailable` diagnostic | On, interactive | `Waiting` | Hidden |
| Gateway listening, no connection | `Waiting for Photoshop` | On, interactive | `Waiting` if the plugin is loaded | Hidden |
| Connected, no open Photoshop Document | `Connected · N instances` | On, interactive | `Connected` | Hidden |
| Connected, at least one open Document | `Connected · N instances` | On, interactive | `Connected` | Visible for an eligible file |
| Photoshop transfer active | Connection status does not change | On, disabled with `Transfer in progress.` | `Connected` | Unchanged from the live-target rules |

The Unavailable text is exact:

- English: `Unavailable — Unable to bind any port from 32124 to 32131.`
- Chinese: `不可用——无法绑定 32124–32131 中任何端口。`

## Runtime Lifecycle And Concurrency

### Ownership

Remove the unconditional `PhotoshopGatewayServer` local from Runtime `main.rs`.
Introduce one Photoshop-specific lifecycle coordinator under
`apps/runtime/src/photoshop/`; do not introduce a generic Plugin Platform
service for one Integration.

The coordinator owns the desired enable state it has applied, the optional
gateway server, and the bind-retry schedule. The existing Photoshop Integration
remains the session and transfer core and owns two narrow synchronization
boundaries: a lifecycle-mutation lock orders complete settings transitions, and
an admission gate serializes the busy check, persistence, authority change,
session handshakes, and transfer reservations. The existing gateway remains the
loopback transport; admission never relies only on the listener being present.

### Runtime Startup

1. Read the validated Global Settings snapshot.
2. Construct the Photoshop session/transfer core and lifecycle coordinator.
3. If `plugins.photoshop.enabled` is false, publish `off` without binding a
   Photoshop port.
4. If it is true, immediately attempt the ordered pool `32124`–`32131` and
   publish either `waiting` or `unavailable` before the initial Workbench
   Photoshop projection is hydrated.

Persisted On therefore survives a Runtime restart and resumes gateway discovery
without requiring the Settings page to open.

### Enable

1. Acquire the Photoshop lifecycle-mutation lock and admission gate.
2. Persist `enabled: true` through `GlobalConfigStore`.
3. Mark the Integration enabled, release the admission gate, and attempt the
   complete port pool immediately while retaining the lifecycle-mutation lock.
4. On bind success, start exactly one gateway and publish `waiting`.
5. On full-pool failure, keep the setting On, publish `unavailable`, and schedule
   the next complete non-overlapping bind round after five seconds.
6. Release the lifecycle-mutation lock and return success regardless of whether
   a host is present or the first bind round succeeds.

An idempotent On patch creates neither a second server nor a second retry loop.

### Disable

1. Acquire the Photoshop lifecycle-mutation lock, then the admission gate used
   by Photoshop command reservation and session admission.
2. Inspect the current Photoshop active-command ownership. If any session owns
   an active command, reject the complete settings patch with HTTP 409, code
   `photoshop_transfer_in_progress`, and message `Transfer in progress.` Persist
   and change nothing.
3. With new Photoshop admissions still blocked, persist `enabled: false`.
4. Mark the Integration off, revoke every session identity and bearer,
   invalidate command HTTP authority, and clear the live session/Document
   projection so pending handshakes and commands are rejected.
5. Release the admission gate while retaining the lifecycle-mutation lock, then
   cancel bind retry, stop the gateway, and wait for every WebSocket to close.
6. Publish `off`, release the lifecycle-mutation lock, and return success.

The coordinator must hold neither the admission gate nor the inner Photoshop
session-state lock while joining the gateway worker, because gateway work may
be entering admission or connection cleanup. The outer lifecycle-mutation lock
still prevents another settings transition from overtaking shutdown. If
persistence fails, the lifecycle remains unchanged and admissions resume after
the gate is released.

An idempotent On patch during a transfer remains a no-op. The rejected mutation
is the actual On-to-Off transition; no admitted transfer can exist while the
Integration is already Off.

### Transfer-Active Boundary

A Photoshop transfer becomes active when the Integration reserves the session's
`active_command`, not merely when an HTTP or WebSocket request arrives. It stays
active through source staging, gateway byte transfer, Photoshop host work,
Project commit, and terminal settlement. Success, failure, abort, or connection
loss must clear the reservation and publish the updated live projection.

Both directions count:

- Debrute to Photoshop place commands.
- Photoshop to Debrute export commands.

Unrelated Runtime work does not count. A Photoshop transfer disables only the
Photoshop Integration switch. Future Integration switches and other Settings
controls remain usable. The frontend check is advisory; Runtime repeats the
same Integration-local check under the admission gate so a stale or second
Workbench cannot interrupt a newly admitted transfer.

### Gateway Recovery And Photoshop Discovery

Runtime bind rounds and Photoshop connection rounds are independent and never
overlap themselves:

- While enabled and unavailable, Runtime retries the complete ordered port pool
  after each five-second retry interval. A later successful bind removes the
  Unavailable diagnostic and moves to `waiting`; the next Photoshop discovery
  round creates a fresh ephemeral session.
- While not connected, the loaded Photoshop plugin continues its existing
  bounded probes of the same pool, including while the Integration is
  intentionally Off. One round checks `32124` through `32131` in order, gives
  each candidate 500 ms, is bounded by a five-second whole-round deadline, and
  never overlaps the next round. After a failed round, the client waits five
  seconds before starting another. It cannot distinguish Off from Runtime
  absence and does not receive settings or diagnostic messages.
- Disabling or losing the gateway closes the socket. The Photoshop plugin runs
  its existing connection-loss cleanup and returns to discovery.
- Reconnection never restores a previous session, bearer, command, or failed
  transfer.

The two small connection components are therefore the conditional Runtime
gateway lifecycle and the always-loaded Photoshop discovery client. They are
not a retained control socket and are connected only after the normal Photoshop
gateway handshake.

## User Interfaces

### Workbench Settings

Add a distinct `Plugins` navigation group containing one `Plugins` page. Do not
merge it into the existing `Integrations` page, whose records and operations
remain catalog-managed command-line tools such as FFmpeg and ImageMagick.

The page initially contains one `Photoshop Integration` row:

- controlled switch backed by the Runtime setting;
- one aggregate status from the live Photoshop projection;
- no Plugin Platform switch;
- no connection list or per-instance controls;
- no Connect, Disconnect, or Reconnect action;
- no Photoshop installation or update workflow.

The page waits for both the initial Global Settings snapshot and the existing
Photoshop live-resource hydration. A switch command is not committed locally
from an HTTP success response; the ordered Runtime projections remain
authoritative. Disable the switch while its own mutation is in flight to avoid
duplicate submissions. Show `Transfer in progress.` only when
`transferActive` is true or Runtime rejects a stale disable for that exact
reason.

### Photoshop Panel

Keep the connection client's internal `disconnected`, `connecting`, and `ready`
states because they drive probes and timeouts. Collapse them only in panel
presentation:

- `ready` renders `Connected` with the connected tone.
- `disconnected` and `connecting` both render `Waiting` with the same waiting
  presentation.

No manual control is added. When the Runtime gateway disappears, the current
plugin cleanup still clears Runtime Projects and pending destination data,
fails in-flight connection work, and resumes automatic discovery.

### Explorer And Canvas Context Menu

The shared menu adds `Send to Photoshop...` only when all of these are true:

1. Exactly one selected Project entry is a file.
2. Its existing size and closed-format checks pass.
3. At least one live Photoshop session reports at least one open Document.

This hides the entire submenu when the Integration is Off, Waiting,
Unavailable, connected with zero Documents, or the Photoshop projection has not
hydrated. Once any Document exists, preserve the current target behavior:

- list Documents from every live session;
- retain duplicate titles as distinct targets;
- keep incompatible Documents visible but disabled;
- retain `Photoshop 26.8 or later for AVIF` when applicable.

## Implementation Sequence And Change Map

### 1. Closed Settings And Protocol

Primary files:

- `apps/runtime/src/global/store.rs`
- `apps/runtime/src/global/runtime.rs`
- `apps/runtime/src/global/mod.rs`
- `apps/runtime/tests/global_runtime_state.rs`
- `packages/app-protocol/src/index.ts`
- `packages/app-protocol/src/workbenchEvent.test.ts`

Add the explicit config/view/patch types and default-off persistence. Extend
closed validation and fixtures. Preserve the test that rejects `adobeBridge`,
and add rejection tests for unknown plugin IDs, unknown nested fields, empty
patches, and non-boolean values.

### 2. Photoshop Lifecycle Authority

Primary files:

- `apps/runtime/src/photoshop/integration.rs`
- `apps/runtime/src/photoshop/gateway.rs`
- `apps/runtime/src/photoshop/lifecycle.rs` (new)
- `apps/runtime/src/photoshop/types.rs`
- `apps/runtime/src/photoshop/mod.rs`
- `apps/runtime/src/workbench/services.rs`
- `apps/runtime/src/workbench/routes.rs`
- `apps/runtime/src/main.rs`

Move gateway ownership behind the setting, add bind retry and complete session
revocation, make active-command changes publish live state, and route settings
mutation through a Runtime service boundary that can coordinate persistence and
Photoshop admission. Do not let the HTTP route call an uncoordinated store patch
for a Photoshop lifecycle change.

Publish Global Settings and resulting Photoshop changes on the existing ordered
Global event stream without gaps. Initial Workbench hydration must receive the
already-applied startup state rather than an unconditional empty-session view.

### 3. Workbench Plugins Settings

Primary files:

- `apps/web/src/workbench/settings/SettingsPanel.tsx`
- `apps/web/src/workbench/settings/SettingsPanel.dom.test.tsx`
- `apps/web/src/workbench/settings/useWorkbenchSettingsController.ts`
- `apps/web/src/workbench/settings/useWorkbenchSettingsController.dom.test.tsx`
- a new `apps/web/src/workbench/settings/plugins/PluginsSettingsPage.tsx`
- a new `apps/web/src/workbench/settings/plugins/PluginsSettingsPage.dom.test.tsx`
- `apps/web/src/workbench/services/WorkbenchGlobalProjection.ts`
- `apps/web/src/workbench/services/WorkbenchGlobalProjection.test.ts`
- `apps/web/src/workbench/WorkbenchApp.tsx`
- `apps/web/src/workbench/WorkbenchAppPreferences.dom.test.tsx`
- `apps/web/src/workbench/i18n/dictionaries.ts`

Add navigation, combine the authoritative settings and live Photoshop
resources, render the four statuses and exact copy, submit the closed patch, and
implement Integration-local busy/in-flight disabling.

### 4. Context Menu

Primary files:

- `apps/web/src/workbench/shell/contextMenu.ts`
- `apps/web/src/workbench/shell/contextMenu.test.ts`
- existing context-menu DOM tests only where their fixture contract changes

Gate submenu construction on at least one reported Document while retaining
the existing compatibility-disabled target rows.

### 5. Photoshop Panel

Primary files:

- `apps/photoshop-uxp-plugin/src/PhotoshopPanelView.ts`
- `apps/photoshop-uxp-plugin/src/PhotoshopPanelView.test.ts`
- `apps/photoshop-uxp-plugin/src/styles.css`
- `apps/photoshop-uxp-plugin/src/styles.test.ts`
- `apps/photoshop-uxp-plugin/src/RuntimeConnection.test.ts`
- `apps/photoshop-uxp-plugin/src/PhotoshopPluginRuntime.test.ts`

Map both non-ready client phases to Waiting, preserve the internal retry state
machine, and prove that socket loss clears stale Runtime presentation and
resumes discovery without a panel action.

### 6. Durable Contracts

After implementation matches this plan, add one system ADR for Runtime-owned,
default-off per-Integration enablement and update:

- `docs/adr/0005-global-settings-use-one-serialized-store.md`
- `docs/adr/0062-photoshop-receiver-lifetime-follows-photoshop.md`
- `docs/adr/0065-photoshop-gateway-uses-a-bounded-loopback-port-pool.md`
- `docs/photoshop.md`
- `docs/workbench.md`
- `docs/design-system.md`
- `docs/security.md`
- `docs/testing.md`

Do not add a product-domain glossary. `CONTEXT-MAP.md` already classifies
Runtime, Workbench, and professional-tool plugins as application surfaces, not
a fourth domain context.

## Required Verification

Automated verification must cover:

1. A fresh store defaults Photoshop to Off, a pre-field settings file is
   rejected, and On persists across Runtime restart.
2. Closed JSON and TypeScript contracts reject legacy, arbitrary, incomplete,
   and malformed plugin fields.
3. Off startup binds no Photoshop port; On startup attempts the pool.
4. Enable with Photoshop absent reaches Waiting and succeeds.
5. Full-pool exhaustion reaches Unavailable, retains On, retries without
   overlap, and recovers automatically when a port becomes available.
6. Idle disable closes all sessions, invalidates bearers/routes, clears
   Documents, and reaches Off.
7. Place and export reservations set `transferActive`; every terminal and
   disconnect path clears it.
8. Disable racing either transfer direction is rejected atomically without
   persisting Off or interrupting the admitted transfer.
9. Photoshop busy state does not disable unrelated Settings or future plugin
   controls.
10. Settings renders all four statuses, exact Unavailable copy, the exact
    transfer message, and authoritative non-optimistic toggle behavior.
11. The context menu is hidden for no session and no Document, but remains
    visible with disabled compatibility targets when Documents exist.
12. The Photoshop panel exposes only Connected and Waiting while its internal
    discovery loop still exercises all ports and reconnects after re-enable.

Give the lifecycle controller injectable bind and scheduling seams in tests so
retry coverage is deterministic, uses no sleeps, and does not contend for the
real fixed port pool. Keep transport integration tests responsible for the
actual loopback gateway routes and authority checks.

Run focused Rust and Vitest targets during each phase, then `pnpm check`.
Complete code review before running `pnpm verify:all` once as the final
repository gate.

Real Photoshop acceptance is still required on macOS and Windows for both start
orders, panel closed/open behavior, Connected-to-Waiting on disable, automatic
reconnect after re-enable without opening the panel, both transfer directions,
and AVIF compatibility presentation. Port-pool exhaustion should be exercised
on both platforms where practical.

## Explicitly Out Of Scope

- A persisted Plugin Platform master switch or Platform lifecycle state.
- A current `Disable all` action; all-off is derived from per-Integration state.
- A generic plugin registry, generic transport, or unknown-plugin fallback.
- A second professional-tool plugin.
- Manual connection controls or instance management.
- Pairing, stable identities, Project links, saved destinations, offline queues,
  transfer retry/replay, or compatibility with the removed Adobe Bridge model.
- Photoshop plugin installation, packaging, publication, or update management.
