import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  acquireWorkbenchRuntimeStartupLock,
  checkWorkbenchRuntimeHealth,
  chooseLoopbackPort,
  deleteWorkbenchRuntimeState,
  ensureRegisteredWorkbenchRuntime,
  isLoopbackHttpUrl,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  terminateManagedWorkbenchRuntime,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';

describe('@debrute/workbench-runtime state', () => {
  it('accepts only the current runtime state schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState({ daemonLogPath: paths.daemonLogPath, webLogPath: paths.webLogPath });

      await writeWorkbenchRuntimeState(paths.statePath, state);

      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(state);
      await expect(readFile(paths.statePath, 'utf8')).resolves.toContain('"processControl": "managed"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed state instead of adapting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-invalid-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify({
        schemaVersion: 1,
        runtimeKind: 'source-dev',
        daemonUrl: 'http://127.0.0.1:17321'
      }), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/Invalid Debrute workbench runtime state/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-network-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify(runtimeState({
        daemonUrl: 'http://192.168.1.2:17321',
        webUrl: 'http://127.0.0.1:17322'
      })), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/loopback/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects project URLs in runtime base URL fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-project-url-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, JSON.stringify(runtimeState({
        webUrl: 'http://127.0.0.1:17322/projects/project-1?debrute-token=secret'
      })), 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/origin/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('@debrute/workbench-runtime health', () => {
  it('does not send runtime tokens during the health probe', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          String(url).includes('/api/runtime')
            ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:17322' })
            : 'ok',
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    });

    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/runtime');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(requests[0]?.init ?? {})).not.toContain('secret');
  });

  it('requires daemon runtime metadata and web URL to match recorded state', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          String(url).includes('/api/runtime')
            ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:17322' })
            : 'ok',
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    })).resolves.toBe('healthy');
    expect(requests[0]?.url).toBe('http://127.0.0.1:17321/api/runtime');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(JSON.stringify(requests[0]?.init ?? {})).not.toContain('secret');

    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime')
          ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:18000' })
          : 'ok',
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })).resolves.toBe('daemon-mismatch');

    await expect(checkWorkbenchRuntimeHealth(runtimeState({
      webUrl: 'http://127.0.0.1:17321'
    }), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime')
          ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321' })
          : 'ok',
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })).resolves.toBe('daemon-mismatch');

    await expect(checkWorkbenchRuntimeHealth(runtimeState(), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime') ? 'forbidden' : 'ok',
        { status: String(url).includes('/api/runtime') ? 403 : 200 }
      )
    })).resolves.toBe('daemon-mismatch');
  });
});

describe('@debrute/workbench-runtime registry', () => {
  const kill = vi.fn(() => true);

  afterEach(() => {
    kill.mockClear();
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
      await writeFile(paths.statePath, '{"schemaVersion":2}', 'utf8');
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

  it('terminates stale managed pids but not stale external pids', () => {
    terminateManagedWorkbenchRuntime(runtimeState({ processControl: 'managed', daemonPid: 10, webPid: 11 }), kill);
    terminateManagedWorkbenchRuntime(runtimeState({ processControl: 'external', daemonPid: 20, webPid: 21 }), kill);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(10, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(11, 'SIGTERM');
  });

  it('serializes publishers with the startup lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-lock-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const events: string[] = [];
      const first = await acquireWorkbenchRuntimeStartupLock(paths);
      const waiting = acquireWorkbenchRuntimeStartupLock(paths).then((second) => {
        events.push('second-acquired');
        second.release();
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      expect(events).toEqual([]);
      await first.release();
      await waiting;
      expect(events).toEqual(['second-acquired']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('@debrute/workbench-runtime ports', () => {
  it('keeps preferred ports as preferences only', async () => {
    const server = await listenOnLoopback(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server did not bind to TCP');
      }
      expect(DEFAULT_WORKBENCH_DAEMON_PORT).toBe(17321);
      expect(DEFAULT_WORKBENCH_WEB_PORT).toBe(17322);
      expect(isLoopbackHttpUrl('http://127.0.0.1:17321')).toBe(true);
      await expect(chooseLoopbackPort(address.port)).resolves.not.toBe(address.port);
    } finally {
      await closeServer(server);
    }
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    schemaVersion: 1,
    runtimeKind: 'source-dev',
    processControl: 'managed',
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/home/user/.debrute/runtime/workbench-daemon.log',
    webLogPath: '/home/user/.debrute/runtime/workbench-web.log',
    startedAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    ...overrides
  };
}

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
