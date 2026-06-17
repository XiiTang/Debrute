import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopAppUpdateService,
  latestDebruteReleaseFromGitHubResponse,
  type DesktopAppUpdateDriver
} from '../apps/desktop/src/electron/app-update/appUpdateService';

class FakeDriver extends EventEmitter implements DesktopAppUpdateDriver {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.3.0', releaseName: 'Debrute 0.3.0' } }));
  downloadUpdate = vi.fn(async () => ['downloaded']);
  quitAndInstall = vi.fn();
}

describe('Desktop app update service', () => {
  it('is disabled outside packaged desktop updater surfaces', () => {
    const service = createDesktopAppUpdateService({
      app: { isPackaged: false, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver: new FakeDriver(),
      linuxReleaseChecker: async () => null
    });

    expect(service.getState()).toEqual({ type: 'disabled', currentVersion: '0.2.0', reason: 'development' });
  });

  it('configures driver for manual download and maps updater lifecycle events', async () => {
    const driver = new FakeDriver();
    const states: string[] = [];
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver,
      now: () => '2026-06-17T00:00:00.000Z',
      linuxReleaseChecker: async () => null
    });
    service.onStateChange((state) => states.push(state.type));

    await service.checkForUpdates(true);
    driver.emit('download-progress', { percent: 41.6 });
    driver.emit('update-downloaded', { version: '0.3.0', releaseName: 'Debrute 0.3.0' });
    await service.installDownloadedUpdate();

    expect(driver.autoDownload).toBe(false);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.checkForUpdates).toHaveBeenCalledWith();
    expect(driver.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(states).toEqual(['checking', 'available', 'downloading', 'downloaded', 'installing']);
  });

  it('does not download during startup background checks', async () => {
    const driver = new FakeDriver();
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'win32',
      driver,
      linuxReleaseChecker: async () => null
    });

    await service.checkForUpdates(false);

    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ type: 'available', updateVersion: '0.3.0', installMode: 'automatic' });
  });

  it('starts one delayed background check for packaged builds and skips disabled builds', async () => {
    const driver = new FakeDriver();
    const scheduled: Array<() => void> = [];
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver,
      linuxReleaseChecker: async () => null,
      setTimeout: (handler, delayMs) => {
        expect(delayMs).toBe(25);
        scheduled.push(handler);
        return 1;
      }
    });

    service.startDelayedBackgroundCheck(25);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await Promise.resolve();
    await Promise.resolve();

    expect(driver.checkForUpdates).toHaveBeenCalledTimes(1);

    const disabledScheduled: Array<() => void> = [];
    createDesktopAppUpdateService({
      app: { isPackaged: false, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver: new FakeDriver(),
      linuxReleaseChecker: async () => null,
      setTimeout: (handler) => {
        disabledScheduled.push(handler);
        return 1;
      }
    }).startDelayedBackgroundCheck(25);

    expect(disabledScheduled).toEqual([]);
  });

  it('downloads only after the user explicitly asks', async () => {
    const driver = new FakeDriver();
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'win32',
      driver,
      linuxReleaseChecker: async () => null
    });

    await service.checkForUpdates(true);
    await service.downloadUpdate();

    expect(driver.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('maps no-update results to idle with notAvailable', async () => {
    const driver = new FakeDriver();
    driver.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '0.1.0' } });
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver,
      now: () => '2026-06-17T00:00:00.000Z',
      linuxReleaseChecker: async () => null
    });

    await service.checkForUpdates(true);

    expect(service.getState()).toEqual({
      type: 'idle',
      currentVersion: '0.2.0',
      platform: 'darwin',
      lastCheckedAt: '2026-06-17T00:00:00.000Z',
      notAvailable: true
    });
  });

  it('uses manual-download state on Linux packaged builds', async () => {
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'linux',
      driver: new FakeDriver(),
      linuxReleaseChecker: async () => ({
        version: '0.3.0',
        releaseName: 'Debrute 0.3.0',
        releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0'
      })
    });

    await service.checkForUpdates(true);

    expect(service.getState()).toEqual({
      type: 'available',
      currentVersion: '0.2.0',
      updateVersion: '0.3.0',
      releaseName: 'Debrute 0.3.0',
      releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      installMode: 'manual-download'
    });
  });

  it('records retryable errors without throwing into the renderer', async () => {
    const driver = new FakeDriver();
    driver.checkForUpdates.mockRejectedValueOnce(new Error('network failed'));
    const service = createDesktopAppUpdateService({
      app: { isPackaged: true, getVersion: () => '0.2.0' },
      platform: 'darwin',
      driver,
      linuxReleaseChecker: async () => null
    });

    await service.checkForUpdates(true);

    expect(service.getState()).toEqual({
      type: 'error',
      currentVersion: '0.2.0',
      operation: 'check',
      message: 'network failed',
      retryable: true
    });
  });

  it('parses GitHub latest release payload for manual Linux updates', () => {
    expect(latestDebruteReleaseFromGitHubResponse({
      tag_name: 'v0.3.0',
      name: 'Debrute 0.3.0',
      html_url: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      published_at: '2026-06-18T00:00:00.000Z',
      prerelease: false,
      draft: false
    })).toEqual({
      version: '0.3.0',
      releaseName: 'Debrute 0.3.0',
      releaseDate: '2026-06-18T00:00:00.000Z',
      releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0'
    });

    expect(latestDebruteReleaseFromGitHubResponse({
      tag_name: '0.3.0',
      html_url: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      prerelease: true,
      draft: false
    })).toBeNull();
  });
});
