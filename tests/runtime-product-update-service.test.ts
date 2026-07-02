import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductUpdateService } from '../apps/daemon/src/product/ProductUpdateService';

describe('runtime product update service', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await rm(cleanup.pop()!, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('maps a newer release to available state', async () => {
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      cliDiagnostic,
      releaseSource: async () => release('0.3.0')
    });

    await expect(service.check()).resolves.toMatchObject({
      productVersion: '0.2.0',
      update: {
        type: 'available',
        currentVersion: '0.2.0',
        updateVersion: '0.3.0',
        releaseName: 'Debrute 0.3.0'
      }
    });
  });

  it('maps the current release to idle without an independent CLI version', async () => {
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      cliDiagnostic,
      releaseSource: async () => release('0.2.0')
    });

    const state = await service.check();

    expect(state.update).toMatchObject({
      type: 'idle',
      currentVersion: '0.2.0',
      updateAvailable: false
    });
    expect(JSON.stringify(state.update)).not.toContain('cliVersion');
  });

  it('reports a newer release without a platform asset as a check error', async () => {
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'win32',
      platformArch: 'x64',
      cliDiagnostic,
      releaseSource: async () => release('0.3.0')
    });

    await expect(service.check()).resolves.toMatchObject({
      productVersion: '0.2.0',
      update: {
        type: 'error',
        currentVersion: '0.2.0',
        operation: 'check',
        updateVersion: '0.3.0',
        message: expect.stringContaining('No Debrute desktop update asset exists for win32 x64')
      }
    });
  });

  it('reports a missing signed manifest from the default GitHub release source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      assets: [{
        name: 'debrute-update-manifest.json.sig',
        browser_download_url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-update-manifest.json.sig'
      }]
    }), { status: 200 })));
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      platformArch: 'arm64',
      cliDiagnostic
    });

    await expect(service.check()).resolves.toMatchObject({
      update: {
        type: 'error',
        operation: 'check',
        message: 'GitHub release is missing debrute-update-manifest.json.'
      }
    });
  });

  it('reports an oversized signed manifest from the default GitHub release source', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/xiitang/debrute/releases/latest') {
        return new Response(JSON.stringify({
          assets: [
            {
              name: 'debrute-update-manifest.json',
              browser_download_url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-update-manifest.json'
            },
            {
              name: 'debrute-update-manifest.json.sig',
              browser_download_url: 'https://github.com/xiitang/debrute/releases/download/v0.3.0/debrute-update-manifest.json.sig'
            }
          ]
        }), { status: 200 });
      }
      return new Response(Buffer.alloc(256 * 1024 + 1), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      platformArch: 'arm64',
      cliDiagnostic
    });

    await expect(service.check()).resolves.toMatchObject({
      update: {
        type: 'error',
        operation: 'check',
        message: 'Downloaded debrute-update-manifest.json exceeds 262144 bytes.'
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('verifies the selected asset, writes a replacement plan, and spawns the helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-product-update-'));
    cleanup.push(root);
    const calls: string[] = [];
    const spawnReplacementHelper = vi.fn(async () => undefined);
    const requestDesktopQuit = vi.fn(() => {
      calls.push('desktop-quit');
    });
    const exitRuntime = vi.fn(() => {
      calls.push('runtime-exit');
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('asset-bytes', { status: 200 })));
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      cliDiagnostic,
      desktopInstallPath: '/Applications/Debrute.app',
      managedProductRoot: join(root, 'products'),
      desktopPid: 42,
      runtimePid: 24,
      releaseSource: async () => release('0.3.0'),
      verifyPlatformAsset: vi.fn(async () => {
        calls.push('platform-verify');
      }),
      spawnReplacementHelper,
      requestDesktopQuit,
      exitRuntime
    });

    const result = await service.apply();

    expect(result.state.update).toMatchObject({
      type: 'installing',
      currentVersion: '0.2.0',
      updateVersion: '0.3.0'
    });
    const planPath = spawnReplacementHelper.mock.calls[0]?.[0];
    expect(planPath).toBeTypeOf('string');
    await expect(readFile(planPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      currentVersion: '0.2.0',
      updateVersion: '0.3.0',
      platform: 'darwin',
      desktopInstallPath: '/Applications/Debrute.app',
      desktopPid: 42,
      runtimePid: 24,
      relaunchDesktop: true
    });
    await expect(readFile(planPath, 'utf8').then(JSON.parse)).resolves.not.toHaveProperty('managedProductRoot');
    expect(calls).toEqual(['platform-verify', 'desktop-quit', 'runtime-exit']);
  });

  it('does not request quit or exit when the replacement helper fails to start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-product-update-spawn-error-'));
    cleanup.push(root);
    const requestDesktopQuit = vi.fn();
    const exitRuntime = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('asset-bytes', { status: 200 })));
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      cliDiagnostic,
      desktopInstallPath: '/Applications/Debrute.app',
      managedProductRoot: join(root, 'products'),
      releaseSource: async () => release('0.3.0'),
      verifyPlatformAsset: vi.fn(async () => undefined),
      spawnReplacementHelper: vi.fn(async () => {
        throw new Error('spawn ENOENT');
      }),
      requestDesktopQuit,
      exitRuntime
    });

    await expect(service.apply()).resolves.toMatchObject({
      state: {
        update: {
          type: 'error',
          operation: 'apply',
          message: 'spawn ENOENT',
          updateVersion: '0.3.0'
        }
      }
    });
    expect(requestDesktopQuit).not.toHaveBeenCalled();
    expect(exitRuntime).not.toHaveBeenCalled();
  });

  it('does not spawn the helper when downloaded asset hash does not match the signed manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-product-update-hash-'));
    cleanup.push(root);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('tampered-bytes', { status: 200 })));
    const spawnReplacementHelper = vi.fn(async () => undefined);
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      platformArch: 'arm64',
      cliDiagnostic,
      desktopInstallPath: '/Applications/Debrute.app',
      managedProductRoot: join(root, 'products'),
      releaseSource: async () => release('0.3.0', 'expected-bytes'),
      verifyPlatformAsset: vi.fn(async () => undefined),
      spawnReplacementHelper,
      requestDesktopQuit: vi.fn(),
      exitRuntime: vi.fn()
    });

    await expect(service.apply()).resolves.toMatchObject({
      state: {
        update: {
          type: 'error',
          operation: 'apply',
          message: expect.stringContaining('Hash mismatch')
        }
      }
    });
    expect(spawnReplacementHelper).not.toHaveBeenCalled();
  });

  it('does not spawn the helper when the default asset downloader receives the wrong size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-product-update-size-'));
    cleanup.push(root);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('short', { status: 200 })));
    const spawnReplacementHelper = vi.fn(async () => undefined);
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      platformArch: 'arm64',
      cliDiagnostic,
      desktopInstallPath: '/Applications/Debrute.app',
      managedProductRoot: join(root, 'products'),
      releaseSource: async () => release('0.3.0', 'expected-bytes'),
      verifyPlatformAsset: vi.fn(async () => undefined),
      spawnReplacementHelper,
      requestDesktopQuit: vi.fn(),
      exitRuntime: vi.fn()
    });

    await expect(service.apply()).resolves.toMatchObject({
      state: {
        update: {
          type: 'error',
          operation: 'apply',
          message: expect.stringContaining('Size mismatch')
        }
      }
    });
    expect(spawnReplacementHelper).not.toHaveBeenCalled();
  });

  it('requires explicit lifecycle callbacks before starting a replacement update', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'debrute-product-update-lifecycle-'));
    cleanup.push(root);
    const spawnReplacementHelper = vi.fn(async () => undefined);
    const service = new ProductUpdateService({
      productVersion: '0.2.0',
      platform: 'darwin',
      cliDiagnostic,
      desktopInstallPath: '/Applications/Debrute.app',
      managedProductRoot: join(root, 'products'),
      releaseSource: async () => release('0.3.0'),
      verifyPlatformAsset: vi.fn(async () => undefined),
      spawnReplacementHelper
    });

    await expect(service.apply()).resolves.toMatchObject({
      state: {
        update: {
          type: 'error',
          operation: 'apply',
          message: expect.stringContaining('requestDesktopQuit is required'),
          updateVersion: '0.3.0'
        }
      }
    });
    expect(spawnReplacementHelper).not.toHaveBeenCalled();
    vi.clearAllTimers();
  });
});

const cliDiagnostic = () => ({
  status: 'ready' as const,
  version: '0.2.0',
  path: '/Users/me/.debrute/bin/debrute',
  skillsVersion: '0.2.0',
  skillsRoot: '/Users/me/.agents/skills'
});

function release(version: string, assetContent = 'asset-bytes') {
  return {
    version,
    name: `Debrute ${version}`,
    date: '2026-06-28T00:00:00.000Z',
    assets: [{
      platform: 'darwin' as const,
      arch: 'arm64' as const,
      name: `debrute-desktop-${version}-macos-arm64.dmg`,
      url: `https://github.com/xiitang/debrute/releases/download/v${version}/debrute-desktop-${version}-macos-arm64.dmg`,
      sha256: createHash('sha256').update(assetContent).digest('hex'),
      sizeBytes: Buffer.byteLength(assetContent)
    }]
  };
}
