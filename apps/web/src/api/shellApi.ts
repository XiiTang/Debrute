import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus,
  DesktopAppUpdateState
} from '@debrute/app-protocol';

export interface DebruteShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  openProject?(input: { forceNewWindow: boolean }): Promise<{ opened: boolean }>;
  bindProjectWindowToProject?(input: { projectId: string }): Promise<{ ok: true }>;
  getDroppedFilePath?(file: File): string | undefined;
  getDebruteCliStatus?(): Promise<DebruteCliStatus>;
  installDebruteCli?(): Promise<DebruteCliInstallResult>;
  updateDebruteCli?(): Promise<DebruteCliInstallResult>;
  syncDebruteCliSkills?(): Promise<DebruteCliSkillsSyncResult>;
  restoreDebruteCliSkills?(): Promise<DebruteCliSkillsSyncResult>;
  repairDebruteCliPath?(): Promise<DebruteCliPathRepairResult>;
  getDebruteCliManualInstallCommand?(): Promise<DebruteCliManualCommand>;
  getAppUpdateState?(): Promise<DesktopAppUpdateState>;
  checkForAppUpdate?(): Promise<DesktopAppUpdateState>;
  downloadAppUpdate?(): Promise<DesktopAppUpdateState>;
  installAppUpdate?(): Promise<DesktopAppUpdateState>;
  openAppUpdateDownloadPage?(): Promise<{ ok: true }>;
  onAppUpdateStateChanged?(listener: (state: DesktopAppUpdateState) => void): () => void;
}

export function getDebruteShellApi(): DebruteShellApi | undefined {
  return typeof window === 'undefined' ? undefined : window.debruteShell;
}
