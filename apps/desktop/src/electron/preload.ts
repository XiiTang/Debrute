import electron from 'electron';
import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus
} from '@debrute/app-protocol';

const { contextBridge, ipcRenderer } = electron;

interface DebruteShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  revealProjectPathInSystemFileManager(input: { projectId: string; projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
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
  revealProjectPathInSystemFileManager: (input) => (
    ipcRenderer.invoke('debrute-shell:revealProjectPathInSystemFileManager', input) as Promise<{ ok: true }>
  ),
  getDebruteCliStatus: () => ipcRenderer.invoke('debrute-shell:getDebruteCliStatus') as Promise<DebruteCliStatus>,
  installDebruteCli: () => ipcRenderer.invoke('debrute-shell:installDebruteCli') as Promise<DebruteCliInstallResult>,
  updateDebruteCli: () => ipcRenderer.invoke('debrute-shell:updateDebruteCli') as Promise<DebruteCliInstallResult>,
  syncDebruteCliSkills: () => ipcRenderer.invoke('debrute-shell:syncDebruteCliSkills') as Promise<DebruteCliSkillsSyncResult>,
  restoreDebruteCliSkills: () => ipcRenderer.invoke('debrute-shell:restoreDebruteCliSkills') as Promise<DebruteCliSkillsSyncResult>,
  repairDebruteCliPath: () => ipcRenderer.invoke('debrute-shell:repairDebruteCliPath') as Promise<DebruteCliPathRepairResult>,
  getDebruteCliManualInstallCommand: () => ipcRenderer.invoke('debrute-shell:getDebruteCliManualInstallCommand') as Promise<DebruteCliManualCommand>
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
