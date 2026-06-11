import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebruteDaemonHttpServer, type DebruteDaemonHttpServer } from '@debrute/daemon';
import { DebruteCliError, exitCodeForCliError } from '../src/errors/cliErrors';
import { commandSpecs, specForCommandPath } from '../src/commands/helpSpec';
import { parseDebruteArgs } from '../src/parser/parseDebruteArgs';
import { renderAgentRecord } from '../src/output/renderAgentRecord';
import { runWorkbenchCommand } from '../src/commands/workbenchCommands';
import {
  DEFAULT_WORKBENCH_DAEMON_PORT,
  DEFAULT_WORKBENCH_WEB_PORT,
  chooseLoopbackPort,
  isWorkbenchRuntimeHealthy,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import { ensureWorkbenchRuntime } from '../src/workbench/workbenchRuntimeLauncher';
import { parseInternalWorkbenchRuntimeChildArgs } from '../src/workbench/internalWorkbenchRuntimeChild';
import { INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND } from '../src/workbench/workbenchRuntimeChildEntrypoint';
import * as workbenchRuntimeLauncher from '../src/workbench/workbenchRuntimeLauncher';

describe('debrute workbench url CLI metadata', () => {
  it('parses workbench url with a project path', () => {
    const parsed = parseDebruteArgs(['workbench', 'url', '.']);

    expect(parsed.command).toBe('workbench.url');
    expect(parsed.scope).toBe('runtime');
    expect(parsed.commandPath).toEqual(['workbench', 'url']);
    expect(parsed.projectRoot).toBe(resolve(process.cwd()));
  });

  it('lists workbench url in command specs', () => {
    expect(commandSpecs).toContainEqual(expect.objectContaining({
      command: 'workbench.url',
      path: ['workbench', 'url'],
      scope: 'runtime',
      risk: 'write',
      requires: 'project',
      writes: 'debrute-project',
      input: '<project>',
      output: 'Workbench URL and runtime port fields'
    }));
    expect(specForCommandPath(['workbench', 'url'])?.errors).toEqual(expect.arrayContaining([
      'runtime_launch_failed',
      'runtime_health_failed',
      'runtime_state_unreadable',
      'runtime_state_write_failed',
      'runtime_lock_timeout'
    ]));
  });

  it('rejects unknown workbench url options and json output mode', () => {
    expect(() => parseDebruteArgs(['workbench', 'url', '.', '--open'])).toThrow(/Unknown option/);
    expect(() => parseDebruteArgs(['workbench', 'url', '.', '--json'])).toThrow(/--json is not supported/);
  });

  it('assigns runtime failures to configuration exit code', () => {
    expect(exitCodeForCliError(new DebruteCliError('runtime_launch_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_health_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_state_unreadable', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_state_write_failed', 'failed'))).toBe(3);
    expect(exitCodeForCliError(new DebruteCliError('runtime_lock_timeout', 'failed'))).toBe(3);
  });
});

describe('runWorkbenchCommand', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('opens a project through the runtime daemon and returns URL fields', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-workbench-url-project-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));

    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'url', projectRoot]), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState()
      }),
      fetch: async (url, init) => {
        expect(String(url)).toBe('http://127.0.0.1:17321/api/projects/open');
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['x-debrute-daemon-token']).toBe('secret');
        expect(JSON.parse(String(init?.body))).toEqual({ projectRoot });
        return new Response(JSON.stringify({ projectId: 'project-1' }), { status: 200 });
      }
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'workbench.url',
      fields: {
        project_url: 'http://127.0.0.1:17322/projects/project-1?debrute-token=secret',
        web_url: 'http://127.0.0.1:17322',
        daemon_url: 'http://127.0.0.1:17321',
        project_id: 'project-1',
        web_port: 17322,
        daemon_port: 17321,
        runtime_started: false,
        runtime_kind: 'source-dev',
        state_path: '/home/user/.debrute/runtime/workbench-runtime.json'
      }
    });
    expect(renderAgentRecord(result)).not.toContain(projectRoot);
  });

  it('reports desktop runtime kind when reusing a registered desktop runtime', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-workbench-url-desktop-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));

    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'url', projectRoot]), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState({ runtimeKind: 'desktop-packaged', processControl: 'external' })
      }),
      fetch: async () => new Response(JSON.stringify({ projectId: 'project-1' }), { status: 200 })
    });

    expect(result).toMatchObject({
      status: 'ok',
      fields: {
        runtime_started: false,
        runtime_kind: 'desktop-packaged'
      }
    });
  });

  it('lets daemon project-open initialize missing Debrute metadata and default canvas', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-workbench-url-init-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      webBaseUrl: 'http://127.0.0.1:17322'
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();

    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'url', projectRoot]), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState({
          daemonUrl: runtime.daemonUrl,
          webUrl: 'http://127.0.0.1:17322',
          daemonPid: process.pid,
          webPid: process.pid
        })
      })
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'workbench.url',
      fields: {
        web_url: 'http://127.0.0.1:17322',
        daemon_url: runtime.daemonUrl
      }
    });
    const metadata = JSON.parse(await readFile(join(projectRoot, '.debrute/project.json'), 'utf8')) as {
      project?: { name?: string };
    };
    expect(metadata.project?.name).toBe(projectRoot.slice(projectRoot.lastIndexOf('/') + 1));
    expect(await readdir(join(projectRoot, '.debrute/canvases'))).toContain('production-map.json');
  });

  it('returns project_not_found for missing directories without launching runtime', async () => {
    const missingProject = join(tmpdir(), `debrute-missing-${Date.now()}`);
    let launched = false;

    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'url', missingProject]), {
      ensureRuntime: async () => {
        launched = true;
        return {
          runtimeStarted: false,
          statePath: '/state.json',
          state: runtimeState()
        };
      }
    });

    expect(launched).toBe(false);
    expect(result).toMatchObject({
      status: 'error',
      command: 'workbench.url',
      code: 'project_not_found'
    });
  });

  it('preserves daemon internal_error from project-open failures', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-workbench-url-invalid-'));
    cleanups.push(() => rm(projectRoot, { recursive: true, force: true }));

    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'url', projectRoot]), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/state.json',
        state: runtimeState()
      }),
      fetch: async () => new Response(JSON.stringify({
        error: {
          code: 'internal_error',
          message: 'Invalid Debrute project metadata.'
        }
      }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    });

    expect(result).toMatchObject({
      status: 'error',
      command: 'workbench.url',
      code: 'internal_error',
      message: 'Invalid Debrute project metadata.'
    });
  });
});

describe('workbench runtime state and health', () => {
  it('writes and reads runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState({
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath
      });

      await writeWorkbenchRuntimeState(paths.statePath, state);

      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toEqual(state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined for missing runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-missing-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await expect(readWorkbenchRuntimeState(paths.statePath)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails invalid runtime state shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-state-invalid-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(paths.statePath, '{"schemaVersion":2}', 'utf8');

      await expect(readWorkbenchRuntimeState(paths.statePath)).rejects.toThrow(/Invalid Debrute workbench runtime state/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns true only when daemon runtime and web URL are reachable', async () => {
    await expect(isWorkbenchRuntimeHealthy(runtimeState(), {
      fetch: async (url) => new Response(
        String(url).includes('/api/runtime')
          ? JSON.stringify({ daemonUrl: 'http://127.0.0.1:17321', webBaseUrl: 'http://127.0.0.1:17322' })
          : 'ok',
        { status: 200 }
      )
    })).resolves.toBe(true);

    await expect(isWorkbenchRuntimeHealthy(runtimeState(), {
      fetch: async (url) => new Response('no', { status: String(url).includes('/api/runtime') ? 500 : 200 })
    })).resolves.toBe(false);
  });
});

describe('ensureWorkbenchRuntime', () => {
  it('reuses healthy runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-reuse-'));
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const state = runtimeState({
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath
      });
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

  it('launches fresh state and terminates recorded stale pids when recorded state is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-launch-'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const stale = runtimeState({
        token: 'stale',
        daemonPid: 10,
        webPid: 11,
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath
      });
      const launched = runtimeState({
        token: 'fresh',
        daemonPid: 20,
        webPid: 21,
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath,
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
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      const launched = runtimeState({
        daemonPid: 20001,
        webPid: 20002,
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath
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

describe('internal workbench runtime child args', () => {
  it('resolves pkg entry directories from the executable when import.meta.url is unavailable', () => {
    const resolveWorkbenchRuntimeEntryDir = (workbenchRuntimeLauncher as unknown as {
      resolveWorkbenchRuntimeEntryDir?: (importMetaUrl: string | undefined, execPath: string) => string;
    }).resolveWorkbenchRuntimeEntryDir;

    expect(resolveWorkbenchRuntimeEntryDir).toBeTypeOf('function');
    expect(resolveWorkbenchRuntimeEntryDir?.(undefined, '/payload/debrute')).toBe('/payload');
  });

  it('uses a pkg-safe internal child command name', () => {
    expect(INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND).toBe('internal-workbench-runtime-child');
    expect(INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND.startsWith('-')).toBe(false);
  });

  it('parses packaged runtime child args from environment variables', () => {
    expect(parseInternalWorkbenchRuntimeChildArgs({
      DEBRUTE_WORKBENCH_RUNTIME_PORT: '17321',
      DEBRUTE_WORKBENCH_RUNTIME_TOKEN_FILE: '/runtime/token',
      DEBRUTE_WORKBENCH_RUNTIME_WEB_DIST_DIR: '/payload/web'
    })).toEqual({
      port: 17321,
      tokenFile: '/runtime/token',
      webDistDir: '/payload/web'
    });
  });

  it('rejects missing packaged runtime child args', () => {
    expect(() => parseInternalWorkbenchRuntimeChildArgs({
      DEBRUTE_WORKBENCH_RUNTIME_PORT: '17321'
    })).toThrow(/token file is required/);
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
