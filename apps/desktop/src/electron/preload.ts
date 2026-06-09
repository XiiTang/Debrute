import electron from 'electron';
import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus
} from '@debrute/app-protocol';

const { contextBridge, ipcRenderer, webUtils } = electron;

interface DebruteShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  getDroppedFilePath(file: File): string | undefined;
  getDebruteCliStatus(): Promise<DebruteCliStatus>;
  installDebruteCli(): Promise<DebruteCliInstallResult>;
  updateDebruteCli(): Promise<DebruteCliInstallResult>;
  syncDebruteCliSkills(): Promise<DebruteCliSkillsSyncResult>;
  restoreDebruteCliSkills(): Promise<DebruteCliSkillsSyncResult>;
  repairDebruteCliPath(): Promise<DebruteCliPathRepairResult>;
  getDebruteCliManualInstallCommand(): Promise<DebruteCliManualCommand>;
}

const debruteShellApi: DebruteShellApi = {
  chooseProjectRoot: () => ipcRenderer.invoke('debrute-shell:chooseProjectRoot') as Promise<string | undefined>,
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
  getDebruteCliManualInstallCommand: () => ipcRenderer.invoke('debrute-shell:getDebruteCliManualInstallCommand') as Promise<DebruteCliManualCommand>
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
