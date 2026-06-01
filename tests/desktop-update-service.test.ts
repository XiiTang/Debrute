import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '@axis/app-protocol';
import { createDesktopUpdateService, type DesktopUpdaterAdapter } from '../apps/desktop/src/electron/update/updateService';

class FakeUpdater extends EventEmitter implements DesktopUpdaterAdapter {
  autoDownload = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn<() => Promise<{ updateInfo: { version: string; releaseName?: string; releaseDate?: string } } | null>>();
  downloadUpdate = vi.fn<() => Promise<void>>();
  quitAndInstall = vi.fn<() => void>();
}

describe('desktop update service', () => {
  it('stays disabled outside packaged supported desktop builds', async () => {
    const updater = new FakeUpdater();
    const service = createDesktopUpdateService({
      currentVersion: '0.1.0',
      packaged: false,
      platform: 'darwin',
      updater,
      requestHotExitSnapshot: async () => ({ schemaVersion: 1, createdAt: 'now', textFileBuffers: [], textEditorWindows: [] }),
      writeHotExitSnapshot: async () => undefined
    });

    expect(service.getState()).toEqual({ type: 'disabled', reason: 'development' });
    await service.updateNow();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('checks without auto download during startup discovery', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: '0.2.0', releaseName: 'AXIS 0.2.0', releaseDate: '2026-05-17T00:00:00.000Z' }
    });
    const seen: DesktopUpdateState[] = [];
    const service = createDesktopUpdateService({
      currentVersion: '0.1.0',
      packaged: true,
      platform: 'darwin',
      updater,
      requestHotExitSnapshot: async () => ({ schemaVersion: 1, createdAt: 'now', textFileBuffers: [], textEditorWindows: [] }),
      writeHotExitSnapshot: async () => undefined,
      now: () => '2026-05-17T01:00:00.000Z'
    });
    service.onStateChange((state) => seen.push(state));

    await service.checkForUpdates(false);

    expect(updater.autoDownload).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(seen.map((state) => state.type)).toEqual(['checking', 'available']);
    expect(service.getState()).toMatchObject({ type: 'available', updateVersion: '0.2.0' });
  });

  it('downloads, saves Hot Exit, and installs when the user updates', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.2.0' } });
    const hotExit = { schemaVersion: 1 as const, createdAt: 'now', textFileBuffers: [], textEditorWindows: [] };
    const writeHotExitSnapshot = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      currentVersion: '0.1.0',
      packaged: true,
      platform: 'win32',
      updater,
      requestHotExitSnapshot: async () => hotExit,
      writeHotExitSnapshot
    });

    await service.updateNow();

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(writeHotExitSnapshot).toHaveBeenCalledWith(hotExit);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(service.getState()).toMatchObject({ type: 'installing', updateVersion: '0.2.0' });
  });

  it('blocks installation when Hot Exit cannot be written', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.2.0' } });
    const service = createDesktopUpdateService({
      currentVersion: '0.1.0',
      packaged: true,
      platform: 'darwin',
      updater,
      requestHotExitSnapshot: async () => ({ schemaVersion: 1, createdAt: 'now', textFileBuffers: [], textEditorWindows: [] }),
      writeHotExitSnapshot: async () => {
        throw new Error('disk full');
      }
    });

    await service.updateNow();

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ type: 'available', updateVersion: '0.2.0', lastError: 'disk full' });
  });
});
