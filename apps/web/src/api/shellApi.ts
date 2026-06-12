import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus
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
}

export function getDebruteShellApi(): DebruteShellApi | undefined {
  return typeof window === 'undefined' ? undefined : window.debruteShell;
}
