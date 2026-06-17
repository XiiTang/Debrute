import { describe, expect, it, vi } from 'vitest';
import { registerAppUpdateShellIpc } from '../apps/desktop/src/electron/app-update/appUpdateShell';

describe('Desktop app update shell IPC', () => {
  it('registers fixed update actions and ignores renderer-provided URLs', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const service = {
      getState: vi.fn(() => ({ type: 'idle' as const, currentVersion: '0.2.0', platform: 'darwin' as NodeJS.Platform })),
      checkForUpdates: vi.fn(async () => ({
        type: 'available' as const,
        currentVersion: '0.2.0',
        updateVersion: '0.3.0',
        installMode: 'automatic' as const
      })),
      downloadUpdate: vi.fn(async () => ({ type: 'downloading' as const, currentVersion: '0.2.0', updateVersion: '0.3.0', percent: 0 })),
      installDownloadedUpdate: vi.fn(async () => ({ type: 'installing' as const, currentVersion: '0.2.0', updateVersion: '0.3.0' })),
      openManualDownloadPage: vi.fn(async () => ({ ok: true as const })),
      onStateChange: vi.fn(() => () => undefined)
    };

    registerAppUpdateShellIpc({
      ipcMain: { handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => { handlers.set(channel, handler); } },
      service,
      windows: () => []
    });

    await handlers.get('debrute-shell:checkForAppUpdate')?.({}, { url: 'https://evil.example/latest.yml' });
    await handlers.get('debrute-shell:downloadAppUpdate')?.({}, { file: '/tmp/evil' });
    await handlers.get('debrute-shell:installAppUpdate')?.({}, { command: 'rm -rf /' });
    await handlers.get('debrute-shell:openAppUpdateDownloadPage')?.({}, { url: 'https://evil.example/app.dmg' });

    expect(service.checkForUpdates).toHaveBeenCalledWith(true);
    expect(service.downloadUpdate).toHaveBeenCalledWith();
    expect(service.installDownloadedUpdate).toHaveBeenCalledWith();
    expect(service.openManualDownloadPage).toHaveBeenCalledWith();
  });

  it('broadcasts update state changes to live windows only', () => {
    let listener!: (state: unknown) => void;
    const sendLive = vi.fn();
    const sendDestroyed = vi.fn();
    const service = {
      getState: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installDownloadedUpdate: vi.fn(),
      openManualDownloadPage: vi.fn(),
      onStateChange: vi.fn((next: (state: unknown) => void) => {
        listener = next;
        return () => undefined;
      })
    };

    registerAppUpdateShellIpc({
      ipcMain: { handle: vi.fn() },
      service,
      windows: () => [
        { isDestroyed: () => false, webContents: { send: sendLive } },
        { isDestroyed: () => true, webContents: { send: sendDestroyed } }
      ]
    });
    listener({ type: 'idle', currentVersion: '0.2.0', platform: 'darwin' });

    expect(sendLive).toHaveBeenCalledWith('debrute-shell:appUpdateStateChanged', {
      type: 'idle',
      currentVersion: '0.2.0',
      platform: 'darwin'
    });
    expect(sendDestroyed).not.toHaveBeenCalled();
  });
});
