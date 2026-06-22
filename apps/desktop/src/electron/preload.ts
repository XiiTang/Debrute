import electron from 'electron';
import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus,
  DesktopAppUpdateState
} from '@debrute/app-protocol';

const { contextBridge, ipcRenderer, webUtils } = electron;

interface DebruteShellApi {
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  getDroppedFilePath(file: File): string | undefined;
  getDebruteCliStatus(): Promise<DebruteCliStatus>;
  installDebruteCli(): Promise<DebruteCliInstallResult>;
  updateDebruteCli(): Promise<DebruteCliInstallResult>;
  syncDebruteCliSkills(): Promise<DebruteCliSkillsSyncResult>;
  restoreDebruteCliSkills(): Promise<DebruteCliSkillsSyncResult>;
  repairDebruteCliPath(): Promise<DebruteCliPathRepairResult>;
  getDebruteCliManualInstallCommand(): Promise<DebruteCliManualCommand>;
  getAppUpdateState(): Promise<DesktopAppUpdateState>;
  checkForAppUpdate(): Promise<DesktopAppUpdateState>;
  downloadAppUpdate(): Promise<DesktopAppUpdateState>;
  installAppUpdate(): Promise<DesktopAppUpdateState>;
  openAppUpdateDownloadPage(): Promise<{ ok: true }>;
  onAppUpdateStateChanged(listener: (state: DesktopAppUpdateState) => void): () => void;
}

const debruteShellApi: DebruteShellApi = {
  bindProjectWindowToProject: (input) => (
    ipcRenderer.invoke('debrute-shell:bindProjectWindowToProject', input) as Promise<{ ok: true }>
  ),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || undefined,
  getDebruteCliStatus: () => ipcRenderer.invoke('debrute-shell:getDebruteCliStatus') as Promise<DebruteCliStatus>,
  installDebruteCli: () => ipcRenderer.invoke('debrute-shell:installDebruteCli') as Promise<DebruteCliInstallResult>,
  updateDebruteCli: () => ipcRenderer.invoke('debrute-shell:updateDebruteCli') as Promise<DebruteCliInstallResult>,
  syncDebruteCliSkills: () => ipcRenderer.invoke('debrute-shell:syncDebruteCliSkills') as Promise<DebruteCliSkillsSyncResult>,
  restoreDebruteCliSkills: () => ipcRenderer.invoke('debrute-shell:restoreDebruteCliSkills') as Promise<DebruteCliSkillsSyncResult>,
  repairDebruteCliPath: () => ipcRenderer.invoke('debrute-shell:repairDebruteCliPath') as Promise<DebruteCliPathRepairResult>,
  getDebruteCliManualInstallCommand: () => ipcRenderer.invoke('debrute-shell:getDebruteCliManualInstallCommand') as Promise<DebruteCliManualCommand>,
  getAppUpdateState: () => ipcRenderer.invoke('debrute-shell:getAppUpdateState') as Promise<DesktopAppUpdateState>,
  checkForAppUpdate: () => ipcRenderer.invoke('debrute-shell:checkForAppUpdate') as Promise<DesktopAppUpdateState>,
  downloadAppUpdate: () => ipcRenderer.invoke('debrute-shell:downloadAppUpdate') as Promise<DesktopAppUpdateState>,
  installAppUpdate: () => ipcRenderer.invoke('debrute-shell:installAppUpdate') as Promise<DesktopAppUpdateState>,
  openAppUpdateDownloadPage: () => ipcRenderer.invoke('debrute-shell:openAppUpdateDownloadPage') as Promise<{ ok: true }>,
  onAppUpdateStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopAppUpdateState) => listener(state);
    ipcRenderer.on('debrute-shell:appUpdateStateChanged', wrapped);
    return () => ipcRenderer.removeListener('debrute-shell:appUpdateStateChanged', wrapped);
  }
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
