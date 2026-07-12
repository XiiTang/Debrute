import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  WorkbenchRuntimeRegistryError,
  chooseLoopbackPort,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { DebruteCliError } from '../errors/cliErrors.js';
import { ensureWorkbenchRuntime, resolveWorkbenchRuntimeEntryDir } from './workbenchRuntimeLauncher.js';

const spawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn };
});

describe('source-development workbench runtime launcher', { tags: ['runtime'] }, () => {
  afterEach(() => {
    spawn.mockReset();
    vi.restoreAllMocks();
  });

  it('launches the daemon and Vite as direct Node children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-launcher-'));
    const sourceRoot = resolve(import.meta.dirname, '../../../..');
    try {
      spawn
        .mockReturnValueOnce(fakeChild(501))
        .mockReturnValueOnce(fakeChild(502));

      const result = await ensureWorkbenchRuntime({
        paths: resolveWorkbenchRuntimePaths(root),
        isHealthy: async () => true
      });

      expect(result.state).toMatchObject({
        runtimeKind: 'source-dev',
        daemonPid: 501,
        webPid: 502
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath);
      expect(spawn.mock.calls[0]?.[1]).toEqual([
        '--import',
        'tsx',
        resolve(sourceRoot, 'apps/daemon/src/cli.ts'),
        '--port',
        expect.any(String),
        '--token-file',
        resolveWorkbenchRuntimePaths(root).tokenPath,
        '--web-base-url',
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:/)
      ]);
      expect(spawn.mock.calls[1]?.[0]).toBe(process.execPath);
      expect(spawn.mock.calls[1]?.[1]).toEqual([
        resolve(sourceRoot, 'node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        expect.any(String),
        '--strictPort'
      ]);
      expect(spawn.mock.calls.flatMap((call) => call.slice(0, 2)).join(' ')).not.toContain('pnpm');
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({
        cwd: resolve(sourceRoot, 'apps/daemon'),
        detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number)],
        env: expect.objectContaining({
          DEBRUTE_DAEMON_TOKEN_FILE: resolveWorkbenchRuntimePaths(root).tokenPath,
          DEBRUTE_DAEMON_CLI_PATH: resolve(sourceRoot, 'apps/debrute-cli/src/index.ts'),
          DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR: resolve(sourceRoot, 'skills')
        })
      });
      expect(spawn.mock.calls[1]?.[2]).toMatchObject({
        cwd: resolve(sourceRoot, 'apps/web'),
        detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number)],
        env: expect.objectContaining({
          DEBRUTE_DAEMON_TOKEN_FILE: resolveWorkbenchRuntimePaths(root).tokenPath
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates the daemon when spawning the source-development web child fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-web-spawn-'));
    const paths = resolveWorkbenchRuntimePaths(root);
    const launchFailure = new Error('web spawn failed');
    const kill = mockProcessesExitAfterSigterm();
    try {
      spawn
        .mockReturnValueOnce(fakeChild(501))
        .mockImplementationOnce(() => {
          throw launchFailure;
        });

      await expect(ensureWorkbenchRuntime({ paths, isHealthy: async () => true }))
        .rejects.toThrow('web spawn failed');

      expect(kill).toHaveBeenCalledWith(501, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(501, 0);
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates the daemon when the source-development web child has no pid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-web-pid-'));
    const paths = resolveWorkbenchRuntimePaths(root);
    const kill = mockProcessesExitAfterSigterm();
    try {
      spawn
        .mockReturnValueOnce(fakeChild(501))
        .mockReturnValueOnce(fakeChild(undefined));

      await expect(ensureWorkbenchRuntime({ paths, isHealthy: async () => true }))
        .rejects.toThrow('Debrute web process did not report a pid.');

      expect(kill).toHaveBeenCalledWith(501, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(501, 0);
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a partial launch error primary when daemon cleanup also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-cleanup-'));
    const paths = resolveWorkbenchRuntimePaths(root);
    const launchFailure = new Error('web spawn failed');
    const cleanupFailure = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
    try {
      spawn
        .mockReturnValueOnce(fakeChild(501))
        .mockImplementationOnce(() => {
          throw launchFailure;
        });
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw cleanupFailure;
      });

      const error = await ensureWorkbenchRuntime({ paths, isHealthy: async () => true })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DebruteCliError);
      expect(error).toMatchObject({
        code: 'runtime_launch_failed',
        message: 'web spawn failed',
        cause: expect.objectContaining({
          message: 'web spawn failed',
          cause: launchFailure,
          errors: [launchFailure, cleanupFailure]
        })
      });
      expect(error.cause).toBeInstanceOf(AggregateError);
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the registry health code when health failure cleanup also fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-runtime-health-cleanup-'));
    const paths = resolveWorkbenchRuntimePaths(root);
    const cleanupFailure = Object.assign(new Error('cleanup failed'), { code: 'EPERM' });
    const owner = { kind: 'cli' as const, ownerId: 'cli-session', pid: 100 };
    try {
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(join(paths.runtimeDir, 'cli-owner.json'), JSON.stringify({ ownerId: owner.ownerId }), 'utf8');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw cleanupFailure;
      });

      const error = await ensureWorkbenchRuntime({
        paths,
        launch: async () => runtimeState(paths, owner, { webPid: 501 }),
        isHealthy: async () => {
          throw new Error('health failed');
        }
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DebruteCliError);
      expect(error).toMatchObject({
        code: 'runtime_health_failed',
        message: 'health failed',
        fields: {},
        cause: expect.objectContaining({
          message: 'health failed',
          errors: [
            expect.objectContaining({
              name: 'WorkbenchRuntimeRegistryError',
              code: 'runtime_health_failed',
              message: 'health failed'
            }),
            cleanupFailure
          ]
        })
      });
      expect(error.cause).toBeInstanceOf(AggregateError);
      expect((error.cause as AggregateError).errors[0]).toBeInstanceOf(WorkbenchRuntimeRegistryError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ensureWorkbenchRuntime', { tags: ['runtime'] }, () => {
  it('reuses healthy runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-reuse-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState(paths, { kind: 'cli', ownerId: 'cli-owner-1', pid: 12345 });
      await writeWorkbenchRuntimeState(paths.statePath, state);

      const result = await ensureWorkbenchRuntime({
        paths,
        isHealthy: async () => true,
        launch: async () => {
          throw new Error('launch should not run');
        }
      });

      expect(result).toEqual({
        runtimeStarted: false,
        statePath: paths.statePath,
        state
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('launches fresh state and terminates recorded stale pids only for the stable CLI owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-launch-'));
    const kill = mockProcessesExitAfterSigterm();
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(join(paths.runtimeDir, 'cli-owner.json'), JSON.stringify({
        ownerId: 'cli-owner-1'
      }), 'utf8');
      const stale = runtimeState(paths, { kind: 'cli', ownerId: 'cli-owner-1', pid: 100 }, {
        token: 'stale',
        daemonPid: 10,
        webPid: 11
      });
      const launched = runtimeState(paths, { kind: 'cli', ownerId: 'cli-owner-1', pid: 200 }, {
        token: 'fresh',
        daemonPid: 20,
        webPid: 21,
        updatedAt: '2026-06-03T00:00:01.000Z'
      });
      await writeWorkbenchRuntimeState(paths.statePath, stale);

      const result = await ensureWorkbenchRuntime({
        paths,
        isHealthy: async (state) => state.token === 'fresh',
        launch: async () => launched
      });

      expect(result.runtimeStarted).toBe(true);
      expect(result.state).toEqual(launched);
      expect(await readWorkbenchRuntimeState(paths.statePath)).toEqual(launched);
      expect(await readWorkbenchRuntimeState(paths.statePath)).toMatchObject({
        owner: {
          kind: 'cli',
          ownerId: 'cli-owner-1'
        }
      });
      expect(kill).toHaveBeenCalledWith(10, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(11, 'SIGTERM');
    } finally {
      kill.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses Debrute default workbench ports and moves occupied ports to a free loopback port', async () => {
    const server = await listenOnLoopback(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server did not bind to a TCP port');
      }

      expect(DEFAULT_WORKBENCH_DAEMON_PORT).toBe(17321);
      expect(DEFAULT_WORKBENCH_WEB_PORT).toBe(17322);
      await expect(chooseLoopbackPort(address.port)).resolves.not.toBe(address.port);
    } finally {
      await closeServer(server);
    }
  });

  it('removes failed fresh runtime state and terminates launched pids when health fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-health-fail-'));
    const kill = mockProcessesExitAfterSigterm();
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(join(paths.runtimeDir, 'cli-owner.json'), JSON.stringify({
        ownerId: 'cli-owner-1'
      }), 'utf8');
      const launched = runtimeState(paths, { kind: 'cli', ownerId: 'cli-owner-1', pid: 20001 }, {
        daemonPid: 20001,
        webPid: 20002
      });

      await expect(ensureWorkbenchRuntime({
        paths,
        isHealthy: async () => {
          throw new Error('health failed');
        },
        launch: async () => launched
      })).rejects.toThrow(/health failed/);

      await expect(stat(paths.statePath)).rejects.toThrow(/ENOENT/);
      expect(kill).toHaveBeenCalledWith(20001, 'SIGTERM');
      expect(kill).toHaveBeenCalledWith(20002, 'SIGTERM');
    } finally {
      kill.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('workbench runtime launcher paths', { tags: ['runtime'] }, () => {
  it('resolves pkg entry directories from the executable when import.meta.url is unavailable', () => {
    expect(resolveWorkbenchRuntimeEntryDir(undefined, '/payload/debrute')).toBe('/payload');
  });
});

async function listenOnLoopback(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function fakeChild(pid: number | undefined): { pid: number | undefined; unref: ReturnType<typeof vi.fn> } {
  return { pid, unref: vi.fn() };
}

function mockProcessesExitAfterSigterm(): ReturnType<typeof vi.spyOn<typeof process, 'kill'>> {
  const exited = new Set<number>();
  return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 'SIGTERM') {
      exited.add(pid);
      return true;
    }
    if (signal === 0 && exited.has(pid)) {
      throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
    }
    return true;
  });
}

function runtimeState(
  paths: ReturnType<typeof resolveWorkbenchRuntimePaths>,
  owner: WorkbenchRuntimeState['owner'],
  overrides: Partial<WorkbenchRuntimeState> = {}
): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner,
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 501,
    webPid: 502,
    daemonLogPath: paths.daemonLogPath,
    webLogPath: paths.webLogPath,
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides
  };
}
