import { describe, expect, it, vi } from 'vitest';
import type { ProductReplacementPlan } from '@debrute/daemon';
import { nodeProductReplacementHelperOperations, runProductReplacementHelper } from './productReplacementHelper.js';

describe('product replacement helper', { tags: ['runtime'] }, () => {
  it('waits for desktop/runtime processes, applies the platform plan, and relaunches desktop', async () => {
    const calls: string[] = [];
    const plan = planFixture({ platform: 'darwin' });

    await runProductReplacementHelper('/tmp/plan.json', {
      readPlan: vi.fn(async () => plan),
      waitForPid: vi.fn(async (pid) => {
        calls.push(`wait:${pid}`);
      }),
      applyMacos: vi.fn(async () => {
        calls.push('apply:macos');
      }),
      applyWindows: vi.fn(async () => {
        calls.push('apply:windows');
      }),
      applyLinux: vi.fn(async () => {
        calls.push('apply:linux');
      }),
      relaunch: vi.fn(async (path) => {
        calls.push(`relaunch:${path}`);
      }),
      writeLog: vi.fn(async () => {
        calls.push('log');
      })
    });

    expect(calls).toEqual([
      'wait:42',
      'wait:24',
      'apply:macos',
      'relaunch:/Applications/Debrute.app',
      'log'
    ]);
  });

  it('uses Windows and Linux platform apply paths', async () => {
    const windowsApply = vi.fn(async () => undefined);
    await runProductReplacementHelper('/tmp/windows.json', operations(planFixture({ platform: 'win32' }), { applyWindows: windowsApply }));
    expect(windowsApply).toHaveBeenCalledTimes(1);

    const linuxApply = vi.fn(async () => undefined);
    await runProductReplacementHelper('/tmp/linux.json', operations(planFixture({ platform: 'linux' }), { applyLinux: linuxApply }));
    expect(linuxApply).toHaveBeenCalledTimes(1);
  });

  it('node operations replace the installed macOS app from a mounted DMG', async () => {
    const calls: string[] = [];
    const operations = nodeProductReplacementHelperOperations({
      execFile: vi.fn(async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (file === 'hdiutil' && args[0] === 'attach') {
          return { stdout: '/dev/disk4s1\tApple_HFS\t/Volumes/Debrute\n', stderr: '' };
        }
        if (file === 'find') {
          return { stdout: '/Volumes/Debrute/Debrute.app\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }),
      removePath: vi.fn(async (path) => {
        calls.push(`rm ${path}`);
      }),
      copyDirectory: vi.fn(async (source, destination) => {
        calls.push(`cpdir ${source} ${destination}`);
      }),
      copyFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      spawnDetached: vi.fn(async () => undefined),
      isProcessRunning: vi.fn(() => false),
      sleep: vi.fn(async () => undefined)
    });

    await operations.applyMacos(planFixture({
      desktopInstallPath: '/Applications/Debrute.app/Contents/MacOS/Debrute',
      downloadedAssetPath: '/tmp/debrute.dmg'
    }));

    expect(calls).toEqual([
      'hdiutil attach -nobrowse -readonly /tmp/debrute.dmg',
      'find /Volumes/Debrute -maxdepth 1 -name *.app -type d -print -quit',
      'rm /Applications/Debrute.app',
      'cpdir /Volumes/Debrute/Debrute.app /Applications/Debrute.app',
      'hdiutil detach /Volumes/Debrute'
    ]);
  });

  it('rejects macOS update assets that are not the release DMG contract', async () => {
    const removePath = vi.fn(async () => undefined);
    const copyDirectory = vi.fn(async () => undefined);
    const operations = nodeProductReplacementHelperOperations({
      execFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
      removePath,
      copyDirectory,
      copyFile: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
      spawnDetached: vi.fn(async () => undefined),
      isProcessRunning: vi.fn(() => false),
      sleep: vi.fn(async () => undefined)
    });

    await expect(operations.applyMacos(planFixture({
      downloadedAssetPath: '/tmp/Debrute.app'
    }))).rejects.toThrow(/Unsupported macOS Debrute update asset/);
    expect(removePath).not.toHaveBeenCalled();
    expect(copyDirectory).not.toHaveBeenCalled();
  });
});

function operations(
  plan: ProductReplacementPlan,
  overrides: Partial<Parameters<typeof runProductReplacementHelper>[1]> = {}
): NonNullable<Parameters<typeof runProductReplacementHelper>[1]> {
  return {
    readPlan: vi.fn(async () => plan),
    waitForPid: vi.fn(async () => undefined),
    applyMacos: vi.fn(async () => undefined),
    applyWindows: vi.fn(async () => undefined),
    applyLinux: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
    writeLog: vi.fn(async () => undefined),
    ...overrides
  };
}

function planFixture(overrides: Partial<ProductReplacementPlan> = {}): ProductReplacementPlan {
  return {
    currentVersion: '0.2.0',
    updateVersion: '0.3.0',
    platform: 'darwin',
    desktopInstallPath: '/Applications/Debrute.app',
    downloadedAssetPath: '/tmp/debrute.dmg',
    desktopPid: 42,
    runtimePid: 24,
    relaunchDesktop: true,
    ...overrides
  };
}
