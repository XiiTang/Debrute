import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  INTERNAL_PRODUCT_REPLACEMENT_HELPER_COMMAND,
  INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND
} from '../src/workbench/workbenchRuntimeChildEntrypoint';
import * as workbenchRuntimeLauncher from '../src/workbench/workbenchRuntimeLauncher';
import { parseRuntimeHostConfig } from '../../runtime-host/src/runtimeHostConfig';

describe('debrute workbench start CLI metadata', () => {
  it('parses workbench start without a project path', () => {
    const parsed = parseDebruteArgs(['workbench', 'start']);

    expect(parsed.command).toBe('workbench.start');
    expect(parsed.scope).toBe('runtime');
    expect(parsed.commandPath).toEqual(['workbench', 'start']);
    expect(parsed.projectRoot).toBeUndefined();
    expect(parsed.positional).toEqual([]);
  });

  it('parses workbench start launch next path', () => {
    const parsed = parseDebruteArgs(['workbench', 'start', '--next', '/open?path=%2Ftmp%2Fproject']);

    expect(parsed).toMatchObject({
      command: 'workbench.start',
      positional: [],
      options: {
        next: '/open?path=%2Ftmp%2Fproject'
      }
    });
  });

  it('lists workbench start in command specs', () => {
    expect(commandSpecs).toContainEqual(expect.objectContaining({
      command: 'workbench.start',
      path: ['workbench', 'start'],
      scope: 'runtime',
      risk: 'write',
      requires: 'none',
      writes: 'logs',
      input: '[--next <same-origin-path>]',
      output: 'Workbench stable URL, launch URL, and port fields'
    }));
    expect(specForCommandPath(['workbench', 'start'])?.errors).toEqual(expect.arrayContaining([
      'runtime_launch_failed',
      'runtime_health_failed',
      'runtime_state_unreadable',
      'runtime_state_write_failed',
      'runtime_lock_timeout'
    ]));
  });

  it('rejects workbench start project paths and json output mode', () => {
    expect(() => parseDebruteArgs(['workbench', 'start', '.'])).toThrow(/Unexpected argument/);
    expect(() => parseDebruteArgs(['workbench', 'start', '--json'])).toThrow(/--json is not supported/);
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

  it('starts or reuses the runtime and returns stable and launch URL fields', async () => {
    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'start']), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState()
      })
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'workbench.start',
      fields: {
        web_url: 'http://127.0.0.1:17322',
        launch_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:17322\/__debrute\/session\/.+/),
        daemon_url: 'http://127.0.0.1:17321',
        web_port: 17322,
        daemon_port: 17321,
        runtime_started: false,
        runtime_kind: 'source-dev',
        state_path: '/home/user/.debrute/runtime/workbench-runtime.json'
      }
    });
    const launchUrl = new URL(String(result.fields.launch_url));
    expect(launchUrl.searchParams.get('next')).toBe('/');
    expect(renderAgentRecord(result)).not.toContain('project_url');
    expect(renderAgentRecord(result)).not.toContain('project_id');
  });

  it('uses the requested same-origin next path in the launch URL', async () => {
    const result = await runWorkbenchCommand(
      parseDebruteArgs(['workbench', 'start', '--next', '/open?path=%2Ftmp%2Fproject']),
      {
        ensureRuntime: async () => ({
          runtimeStarted: false,
          statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
          state: runtimeState()
        })
      }
    );

    expect(result).toMatchObject({
      status: 'ok',
      fields: {
        web_url: 'http://127.0.0.1:17322',
        launch_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:17322\/__debrute\/session\/.+/)
      }
    });
    const launchUrl = new URL(String(result.fields.launch_url));
    expect(launchUrl.searchParams.get('next')).toBe('/open?path=%2Ftmp%2Fproject');
  });

  it('rejects invalid launch next paths without starting the runtime', async () => {
    const ensureRuntime = vi.fn();
    const result = await runWorkbenchCommand(
      parseDebruteArgs(['workbench', 'start', '--next', 'https://example.com/open']),
      { ensureRuntime }
    );

    expect(result).toMatchObject({
      status: 'error',
      command: 'workbench.start',
      code: 'invalid_input',
      message: 'Debrute Workbench launch next path must be a normalized same-origin path: https://example.com/open'
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it('reports desktop runtime kind when reusing a registered desktop runtime', async () => {
    const result = await runWorkbenchCommand(parseDebruteArgs(['workbench', 'start']), {
      ensureRuntime: async () => ({
        runtimeStarted: false,
        statePath: '/home/user/.debrute/runtime/workbench-runtime.json',
        state: runtimeState({ runtimeKind: 'desktop-packaged', processControl: 'external' })
      })
    });

    expect(result).toMatchObject({
      status: 'ok',
      fields: {
        runtime_started: false,
        runtime_kind: 'desktop-packaged'
      }
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
      await writeFile(paths.statePath, '{"runtimeKind":"source-dev"}', 'utf8');

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

  it('launches fresh state and terminates recorded stale pids only for the stable CLI owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-launch-'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(join(paths.runtimeDir, 'cli-owner.json'), JSON.stringify({
        ownerId: 'cli-owner-1'
      }), 'utf8');
      const stale = runtimeState({
        token: 'stale',
        owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 100 },
        daemonPid: 10,
        webPid: 11,
        daemonLogPath: paths.daemonLogPath,
        webLogPath: paths.webLogPath
      });
      const launched = runtimeState({
        token: 'fresh',
        owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 200 },
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
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const paths = resolveWorkbenchRuntimePaths(root);
      await mkdir(paths.runtimeDir, { recursive: true });
      await writeFile(join(paths.runtimeDir, 'cli-owner.json'), JSON.stringify({
        ownerId: 'cli-owner-1'
      }), 'utf8');
      const launched = runtimeState({
        owner: { kind: 'cli', ownerId: 'cli-owner-1', pid: 20001 },
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

  it('parses packaged runtime host args from environment variables', () => {
    expect(parseRuntimeHostConfig({
      env: {
        DEBRUTE_RUNTIME_HOST_DAEMON_PORT: '17321',
        DEBRUTE_RUNTIME_HOST_TOKEN_FILE: '/runtime/token',
        DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR: '/payload/web',
        DEBRUTE_RUNTIME_HOST_PRODUCT_VERSION: '0.2.0',
        DEBRUTE_RUNTIME_HOST_CLI_PAYLOAD_DIR: '/payload/cli',
        DEBRUTE_RUNTIME_HOST_SKILLS_PAYLOAD_DIR: '/payload/skills',
        DEBRUTE_RUNTIME_HOST_MANAGED_BIN_DIR: '/home/user/.debrute/bin',
        DEBRUTE_RUNTIME_HOST_MANAGED_PRODUCT_ROOT: '/home/user/.debrute/products',
        DEBRUTE_RUNTIME_HOST_PRODUCT_MANIFEST_PATH: '/home/user/.debrute/products/product-manifest.json',
        DEBRUTE_RUNTIME_HOST_DESKTOP_INSTALL_PATH: '/Applications/Debrute.app/Contents/MacOS/debrute',
        DEBRUTE_RUNTIME_HOST_REPLACEMENT_HELPER_PATH: '/home/user/.debrute/products/product-replacement-helper.cjs'
      }
    })).toMatchObject({
      daemonPort: 17321,
      tokenFile: '/runtime/token',
      webDistDir: '/payload/web',
      productVersion: '0.2.0',
      cliPayloadDir: '/payload/cli',
      skillsPayloadDir: '/payload/skills',
      replacementHelperPath: '/home/user/.debrute/products/product-replacement-helper.cjs'
    });
  });

  it('does not pass a replacement helper runner for packaged CLI-launched runtimes', () => {
    const source = readFileSync(join(process.cwd(), 'apps/debrute-cli/src/workbench/workbenchRuntimeLauncher.ts'), 'utf8');

    expect(INTERNAL_PRODUCT_REPLACEMENT_HELPER_COMMAND).toBe('internal-product-replacement-helper');
    expect(source).not.toContain('DEBRUTE_RUNTIME_HOST_REPLACEMENT_HELPER_RUNNER');
    expect(source).not.toContain('cli-internal');
  });

  it('passes source product metadata into source-dev daemon launches', () => {
    const source = readFileSync(join(process.cwd(), 'apps/debrute-cli/src/workbench/workbenchRuntimeLauncher.ts'), 'utf8');

    expect(source).toContain('DEBRUTE_DAEMON_PRODUCT_VERSION');
    expect(source).toContain('DEBRUTE_DAEMON_CLI_PATH');
    expect(source).toContain('DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR');
  });

  it('rejects missing packaged runtime host args', () => {
    expect(() => parseRuntimeHostConfig({
      env: {
        DEBRUTE_RUNTIME_HOST_DAEMON_PORT: '17321'
      }
    })).toThrow(/DEBRUTE_RUNTIME_HOST_TOKEN_FILE/);
  });
});

function runtimeState(overrides: Partial<WorkbenchRuntimeState> = {}): WorkbenchRuntimeState {
  return {
    runtimeKind: 'source-dev',
    processControl: 'managed',
    owner: {
      kind: 'cli',
      ownerId: 'cli-owner-1',
      pid: 12345
    },
    daemonUrl: 'http://127.0.0.1:17321',
    webUrl: 'http://127.0.0.1:17322',
    token: 'secret',
    daemonPid: 10,
    webPid: 11,
    daemonLogPath: '/home/user/.debrute/runtime/workbench-daemon.log',
    webLogPath: '/home/user/.debrute/runtime/workbench-web.log',
    startedAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
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
