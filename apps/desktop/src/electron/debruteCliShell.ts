import type { DebruteCliInstaller } from './debruteCliInstaller.js';

interface DebruteCliIpcMain {
  handle(channel: string, listener: (event: unknown, input?: unknown) => unknown): void;
}

export function registerDebruteCliShellIpc(input: { ipcMain: DebruteCliIpcMain; installer: DebruteCliInstaller }): void {
  input.ipcMain.handle('debrute-shell:getDebruteCliStatus', () => input.installer.getStatus());
  input.ipcMain.handle('debrute-shell:installDebruteCli', () => input.installer.install());
  input.ipcMain.handle('debrute-shell:updateDebruteCli', () => input.installer.update());
  input.ipcMain.handle('debrute-shell:syncDebruteCliSkills', () => input.installer.syncSkills(false));
  input.ipcMain.handle('debrute-shell:restoreDebruteCliSkills', () => input.installer.syncSkills(true));
  input.ipcMain.handle('debrute-shell:repairDebruteCliPath', () => input.installer.repairPath());
  input.ipcMain.handle('debrute-shell:getDebruteCliManualInstallCommand', () => input.installer.getManualInstallCommand());
}
