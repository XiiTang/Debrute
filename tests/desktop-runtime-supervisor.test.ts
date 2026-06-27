import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchRuntimeState } from '@debrute/workbench-runtime';
import { RuntimeSupervisor } from '../apps/desktop/src/electron/runtime/runtimeSupervisor';

describe('RuntimeSupervisor', () => {
  it('attaches to a healthy external runtime without marking it owned', async () => {
    const external = runtimeState({
      processControl: 'external',
      owner: { kind: 'dev', ownerId: 'dev-owner', pid: 111 }
    });
    const supervisor = new RuntimeSupervisor({
      owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 },
      ensureRuntime: vi.fn(async () => ({ runtimeStarted: false, statePath: '/tmp/state.json', state: external })),
      readState: vi.fn(async () => external),
      deleteState: vi.fn(async () => undefined),
      terminateOwned: vi.fn(),
      launchRuntime: vi.fn(),
      checkHealth: vi.fn(async () => 'healthy')
    });

    await expect(supervisor.start()).resolves.toEqual(external);
    expect(supervisor.snapshot()).toMatchObject({
      status: 'running',
      state: external,
      ownsRuntime: false
    });
  });

  it('starts attached in degraded state when daemon is reachable but web is unavailable', async () => {
    const external = runtimeState({
      processControl: 'external',
      owner: { kind: 'dev', ownerId: 'dev-owner', pid: 111 }
    });
    const supervisor = new RuntimeSupervisor({
      owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 },
      ensureRuntime: vi.fn(async (input) => {
        expect(await input.isHealthy?.(external)).toBe(true);
        return { runtimeStarted: false, statePath: '/tmp/state.json', state: external };
      }),
      readState: vi.fn(async () => external),
      deleteState: vi.fn(async () => undefined),
      terminateOwned: vi.fn(),
      launchRuntime: vi.fn(),
      checkHealth: vi.fn(async () => 'web-unavailable')
    });

    await expect(supervisor.start()).resolves.toEqual(external);
    expect(supervisor.snapshot()).toMatchObject({
      status: 'degraded',
      state: external,
      ownsRuntime: false,
      lastHealth: 'web-unavailable'
    });
  });

  it('terminates an owned runtime when Desktop launch fails health validation', async () => {
    const owned = runtimeState({
      owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 }
    });
    const terminateOwned = vi.fn();
    const supervisor = new RuntimeSupervisor({
      owner: owned.owner,
      ensureRuntime: vi.fn(async (input) => {
        const launched = await input.launch?.({
          runtimeDir: '/tmp/runtime',
          statePath: '/tmp/runtime/state.json',
          tokenPath: '/tmp/runtime/token',
          daemonLogPath: '/tmp/runtime/daemon.log',
          webLogPath: '/tmp/runtime/web.log',
          lockPath: '/tmp/runtime/lock'
        });
        if (launched) {
          input.onRuntimeLaunchFailed?.(launched);
        }
        throw new Error('Debrute workbench runtime did not become healthy.');
      }),
      readState: vi.fn(async () => owned),
      deleteState: vi.fn(async () => undefined),
      terminateOwned,
      launchRuntime: vi.fn(async () => owned),
      checkHealth: vi.fn(async () => 'error')
    });

    await expect(supervisor.start()).rejects.toThrow('Debrute workbench runtime did not become healthy.');
    expect(terminateOwned).toHaveBeenCalledWith(owned, owned.owner);
    expect(supervisor.snapshot()).toMatchObject({
      status: 'error',
      ownsRuntime: false,
      lastError: 'Debrute workbench runtime did not become healthy.'
    });
  });

  it('stops only a runtime owned by this desktop session', async () => {
    const owned = runtimeState({
      owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 }
    });
    const terminateOwned = vi.fn();
    const deleteState = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor({
      owner: owned.owner,
      ensureRuntime: vi.fn(async () => ({ runtimeStarted: true, statePath: '/tmp/state.json', state: owned })),
      readState: vi.fn(async () => owned),
      deleteState,
      terminateOwned,
      launchRuntime: vi.fn(),
      checkHealth: vi.fn(async () => 'healthy')
    });

    await supervisor.start();
    await supervisor.stopOwnedRuntime();

    expect(terminateOwned).toHaveBeenCalledWith(owned, owned.owner);
    expect(deleteState).toHaveBeenCalledWith('/tmp/state.json');
    expect(supervisor.snapshot().status).toBe('stopped');
  });

  it('leaves external runtimes running during Desktop quit', async () => {
    const external = runtimeState({
      processControl: 'external',
      owner: { kind: 'dev', ownerId: 'dev-owner', pid: 111 }
    });
    const terminateOwned = vi.fn();
    const deleteState = vi.fn(async () => undefined);
    const supervisor = new RuntimeSupervisor({
      owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 },
      ensureRuntime: vi.fn(async () => ({ runtimeStarted: false, statePath: '/tmp/state.json', state: external })),
      readState: vi.fn(async () => external),
      deleteState,
      terminateOwned,
      launchRuntime: vi.fn(),
      checkHealth: vi.fn(async () => 'healthy')
    });

    await supervisor.start();
    await supervisor.stopOwnedRuntime();

    expect(terminateOwned).not.toHaveBeenCalled();
    expect(deleteState).not.toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe('running');
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'desktop-packaged',
    processControl: 'managed',
    owner: { kind: 'desktop', ownerId: 'desktop-owner', pid: 222 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 333,
    webPid: 334,
    daemonLogPath: '/tmp/daemon.log',
    webLogPath: '/tmp/web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  };
}
