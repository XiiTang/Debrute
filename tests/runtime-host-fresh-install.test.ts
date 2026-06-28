import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRuntimeHost } from '../apps/runtime-host/src/runtimeHost';
import type { RuntimeHostConfig } from '../apps/runtime-host/src/runtimeHostConfig';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => childProcessStub())
}));

describe('runtime host fresh install product startup', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await rm(cleanup.pop()!, { recursive: true, force: true });
    }
    vi.mocked(spawn).mockClear();
  });

  it('awaits managed CLI materialization before the daemon listens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-host-'));
    cleanup.push(root);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'test-token\n', 'utf8');
    const events: string[] = [];
    const managedCli = {
      ensureCurrent: vi.fn(async () => {
        events.push('ensure-start');
        await Promise.resolve();
        events.push('ensure-done');
        return {
          status: 'ready' as const,
          version: '0.2.0',
          path: join(root, 'home', '.debrute', 'bin', 'debrute'),
          skillsVersion: '0.2.0',
          skillsRoot: join(root, 'home', '.agents', 'skills')
        };
      }),
      diagnostic: vi.fn(() => ({
        status: 'ready' as const,
        version: '0.2.0',
        path: join(root, 'home', '.debrute', 'bin', 'debrute'),
        skillsVersion: '0.2.0',
        skillsRoot: join(root, 'home', '.agents', 'skills')
      })),
      replacementHelperCommand: vi.fn(() => ({
        executablePath: join(root, 'home', '.debrute', 'products', '0.2.0', 'cli', process.platform === 'win32' ? 'debrute.exe' : 'debrute'),
        helperPath: join(root, 'home', '.debrute', 'products', 'product-replacement-helper.cjs')
      }))
    };
    const productUpdate = {
      state: vi.fn(async () => ({
        productVersion: '0.2.0',
        platform: process.platform,
        cli: managedCli.diagnostic(),
        update: { type: 'idle' as const, currentVersion: '0.2.0', updateAvailable: false }
      })),
      check: vi.fn(),
      apply: vi.fn()
    };
    const server = {
      listen: vi.fn(async () => {
        events.push('listen');
        return {
          daemonUrl: 'http://127.0.0.1:17321',
          webBaseUrl: null,
          platform: process.platform,
          token: 'test-token'
        };
      }),
      close: vi.fn(async () => undefined)
    };
    let daemonProductServices: unknown;

    await runRuntimeHost(hostConfig({ tokenFile, root }), {
      createManagedCliService: () => managedCli,
      createProductUpdateService: () => productUpdate,
      createDaemonServer: (options) => {
        daemonProductServices = options.productServices;
        return server;
      },
      registerProcessHandlers: false
    });

    expect(events).toEqual(['ensure-start', 'ensure-done', 'listen']);
    expect(daemonProductServices).toEqual({ managedCli, productUpdate });
  });

  it('creates product updates with the managed helper command outside the desktop install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-host-managed-helper-'));
    cleanup.push(root);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'test-token\n', 'utf8');
    const managedCliPath = join(root, 'home', '.debrute', 'products', '0.2.0', 'cli', process.platform === 'win32' ? 'debrute.exe' : 'debrute');
    const managedHelperPath = join(root, 'home', '.debrute', 'products', 'product-replacement-helper.cjs');
    const managedCli = {
      ensureCurrent: vi.fn(async () => ({
        status: 'ready' as const,
        version: '0.2.0',
        path: join(root, 'home', '.debrute', 'bin', 'debrute'),
        skillsVersion: '0.2.0',
        skillsRoot: join(root, 'home', '.agents', 'skills')
      })),
      diagnostic: vi.fn(() => ({
        status: 'ready' as const,
        version: '0.2.0',
        path: join(root, 'home', '.debrute', 'bin', 'debrute'),
        skillsVersion: '0.2.0',
        skillsRoot: join(root, 'home', '.agents', 'skills')
      })),
      replacementHelperCommand: vi.fn(() => ({
        executablePath: managedCliPath,
        helperPath: managedHelperPath
      }))
    };
    const server = {
      listen: vi.fn(async () => ({
        daemonUrl: 'http://127.0.0.1:17321',
        webBaseUrl: null,
        platform: process.platform,
        token: 'test-token'
      })),
      close: vi.fn(async () => undefined)
    };
    let productUpdate: unknown;

    await runRuntimeHost(hostConfig({ tokenFile, root }), {
      createManagedCliService: () => managedCli,
      createDaemonServer: (options) => {
        productUpdate = options.productServices?.productUpdate;
        return server;
      },
      registerProcessHandlers: false
    });

    const spawnReplacementHelper = (productUpdate as {
      input?: { spawnReplacementHelper?: (planPath: string) => Promise<void> };
    }).input?.spawnReplacementHelper;
    expect(managedCli.replacementHelperCommand).toHaveBeenCalledTimes(1);
    expect(spawnReplacementHelper).toBeTypeOf('function');
    const spawned = childProcessStub();
    vi.mocked(spawn).mockReturnValueOnce(spawned);
    const spawnPromise = spawnReplacementHelper?.('/tmp/debrute-product-replacement-plan.json');
    spawned.emit('spawn');
    await spawnPromise;
    expect(spawn).toHaveBeenCalledWith(managedCliPath, [
      'internal-product-replacement-helper',
      managedHelperPath,
      '/tmp/debrute-product-replacement-plan.json'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    expect(managedHelperPath).not.toBe(hostConfig({ tokenFile, root }).replacementHelperPath);
  });

  it('rejects the replacement helper spawner when the managed CLI fails to spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-runtime-host-managed-helper-error-'));
    cleanup.push(root);
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'test-token\n', 'utf8');
    const managedCli = {
      ensureCurrent: vi.fn(async () => ({
        status: 'ready' as const,
        version: '0.2.0',
        path: join(root, 'home', '.debrute', 'bin', 'debrute'),
        skillsVersion: '0.2.0',
        skillsRoot: join(root, 'home', '.agents', 'skills')
      })),
      diagnostic: vi.fn(() => ({
        status: 'ready' as const,
        version: '0.2.0',
        path: join(root, 'home', '.debrute', 'bin', 'debrute'),
        skillsVersion: '0.2.0',
        skillsRoot: join(root, 'home', '.agents', 'skills')
      })),
      replacementHelperCommand: vi.fn(() => ({
        executablePath: join(root, 'home', '.debrute', 'products', '0.2.0', 'cli', 'debrute'),
        helperPath: join(root, 'home', '.debrute', 'products', 'product-replacement-helper.cjs')
      }))
    };
    const server = {
      listen: vi.fn(async () => ({
        daemonUrl: 'http://127.0.0.1:17321',
        webBaseUrl: null,
        platform: process.platform,
        token: 'test-token'
      })),
      close: vi.fn(async () => undefined)
    };
    let productUpdate: unknown;

    await runRuntimeHost(hostConfig({ tokenFile, root }), {
      createManagedCliService: () => managedCli,
      createDaemonServer: (options) => {
        productUpdate = options.productServices?.productUpdate;
        return server;
      },
      registerProcessHandlers: false
    });

    const spawnReplacementHelper = (productUpdate as {
      input?: { spawnReplacementHelper?: (planPath: string) => Promise<void> };
    }).input?.spawnReplacementHelper;
    const spawned = childProcessStub();
    vi.mocked(spawn).mockReturnValueOnce(spawned);
    const spawnPromise = spawnReplacementHelper?.('/tmp/debrute-product-replacement-plan.json');
    expect(spawned.listenerCount('error')).toBeGreaterThan(0);
    spawned.emit('error', new Error('spawn ENOENT'));

    await expect(spawnPromise).rejects.toThrow('spawn ENOENT');
    expect(spawned.unref).not.toHaveBeenCalled();
  });
});

function hostConfig(input: { tokenFile: string; root: string }): RuntimeHostConfig {
  return {
    host: '127.0.0.1',
    daemonPort: 17321,
    tokenFile: input.tokenFile,
    webDistDir: join(input.root, 'dist'),
    productVersion: '0.2.0',
    cliPayloadDir: join(input.root, 'runtime-product', 'cli'),
    skillsPayloadDir: join(input.root, 'runtime-product', 'skills'),
    managedBinDir: join(input.root, 'home', '.debrute', 'bin'),
    managedProductRoot: join(input.root, 'home', '.debrute', 'products'),
    productManifestPath: join(input.root, 'runtime-product', 'product-manifest.json'),
    desktopInstallPath: '/Applications/Debrute.app',
    replacementHelperPath: join(input.root, 'product-replacement-helper.cjs'),
    desktopPid: 1234
  };
}

function childProcessStub() {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  return child as never;
}
