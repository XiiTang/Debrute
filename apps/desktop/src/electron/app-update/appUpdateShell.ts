import type { DesktopAppUpdateService } from './appUpdateService.js';

interface AppUpdateIpcMain {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void;
}

interface AppUpdateWindow {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

export function registerAppUpdateShellIpc(input: {
  ipcMain: AppUpdateIpcMain;
  service: DesktopAppUpdateService;
  windows: () => AppUpdateWindow[];
}): void {
  input.ipcMain.handle('debrute-shell:getAppUpdateState', () => input.service.getState());
  input.ipcMain.handle('debrute-shell:checkForAppUpdate', () => input.service.checkForUpdates(true));
  input.ipcMain.handle('debrute-shell:downloadAppUpdate', () => input.service.downloadUpdate());
  input.ipcMain.handle('debrute-shell:installAppUpdate', () => input.service.installDownloadedUpdate());
  input.ipcMain.handle('debrute-shell:openAppUpdateDownloadPage', () => input.service.openManualDownloadPage());

  input.service.onStateChange((state) => {
    for (const window of input.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('debrute-shell:appUpdateStateChanged', state);
      }
    }
  });
}
