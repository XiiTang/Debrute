import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkbenchRuntimePaths } from '../../../packages/workbench-runtime/src/paths.js';
import { terminateManagedWorkbenchRuntime } from '../../../packages/workbench-runtime/src/processControl.js';
import { ensureRegisteredWorkbenchRuntime } from '../../../packages/workbench-runtime/src/registry.js';
import {
  readWorkbenchRuntimeState,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from '../../../packages/workbench-runtime/src/state.js';

vi.mock('../../../packages/workbench-runtime/src/processControl.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../packages/workbench-runtime/src/processControl.js')>();
  return {
    ...original,
    terminateManagedWorkbenchRuntime: vi.fn(original.terminateManagedWorkbenchRuntime)
  };
});

describe('workbench runtime registry', { tags: ['runtime'] }, () => {
  afterEach(() => {
    vi.mocked(terminateManagedWorkbenchRuntime).mockReset();
  });

  it('reuses healthy state without launching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-reuse-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState({ daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });
      await writeWorkbenchRuntimeState(paths.statePath, state);

      const result = await ensureRegisteredWorkbenchRuntime({
        paths,
        isHealthy: async () => true,
        launch: async () => {
          throw new Error('launch should not run');
        }
      });

      expect(result).toEqual({ runtimeStarted: false, statePath: paths.statePath, state });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes invalid state and launches fresh state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-invalid-launch-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, '{"runtimeKind":"source-dev"}', 'utf8');
      const launched = runtimeState({ token: 'fresh', daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });

      const result = await ensureRegisteredWorkbenchRuntime({
        paths,
        isHealthy: async (state) => state.token === 'fresh',
        launch: async () => launched
      });

      expect(result.runtimeStarted).toBe(true);
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(launched);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('awaits stale owned runtime termination before deleting state and relaunching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-stale-'));
    const cleanup = deferred<void>();
    const events: string[] = [];
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const stale = runtimeState({ token: 'stale', daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });
      const launched = runtimeState({ token: 'fresh', daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });
      await writeWorkbenchRuntimeState(paths.statePath, stale);
      vi.mocked(terminateManagedWorkbenchRuntime).mockImplementation(async () => {
        events.push('terminate');
        await cleanup.promise;
        events.push('terminated');
      });

      const result = ensureRegisteredWorkbenchRuntime({
        paths,
        isHealthy: async (state) => state.token === 'fresh',
        shouldTerminateStaleRuntime: () => true,
        launch: async () => {
          events.push('launch');
          await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
          return launched;
        }
      });

      await vi.waitFor(() => expect(events).toEqual(['terminate']));
      cleanup.resolve();
      await expect(result).resolves.toMatchObject({ runtimeStarted: true, state: launched });
      expect(events).toEqual(['terminate', 'terminated', 'launch']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('awaits failed-launch cleanup before deleting state and rethrowing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-launch-failure-'));
    const cleanup = deferred<void>();
    const events: string[] = [];
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const launched = runtimeState({ daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });
      const result = ensureRegisteredWorkbenchRuntime({
        paths,
        isHealthy: async () => {
          throw new Error('health failed');
        },
        launch: async () => launched,
        onRuntimeLaunchFailed: async () => {
          events.push('cleanup');
          await writeWorkbenchRuntimeState(paths.statePath, launched);
          await cleanup.promise;
          events.push('cleaned');
        }
      }).catch((error: unknown) => {
        events.push('rejected');
        throw error;
      });

      await vi.waitFor(() => expect(events).toEqual(['cleanup']));
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(launched);
      cleanup.resolve();
      await expect(result).rejects.toThrow('health failed');
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
      expect(events).toEqual(['cleanup', 'cleaned', 'rejected']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the health failure primary and preserves state when cleanup rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-cleanup-failure-'));
    const healthFailure = new Error('health failed');
    const cleanupFailure = new Error('cleanup failed');
    const events: string[] = [];
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const launched = runtimeState({ daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });
      const result = ensureRegisteredWorkbenchRuntime({
        paths,
        isHealthy: async () => {
          throw healthFailure;
        },
        launch: async () => launched,
        onRuntimeLaunchFailed: async () => {
          events.push('cleanup');
          await writeWorkbenchRuntimeState(paths.statePath, launched);
          throw cleanupFailure;
        }
      }).catch((error: unknown) => {
        events.push('rejected');
        throw error;
      });

      const error = await result.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: 'health failed',
        cause: expect.objectContaining({
          name: 'WorkbenchRuntimeRegistryError',
          code: 'runtime_health_failed',
          message: 'health failed'
        }),
        errors: [
          expect.objectContaining({ message: 'health failed' }),
          cleanupFailure
        ]
      });
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(launched);
      expect(events).toEqual(['cleanup', 'rejected']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: { kind: 'cli', ownerId: 'cli-session', pid: 100 },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/tmp/daemon.log',
    webLogPath: '/tmp/web.log',
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides
  };
}
