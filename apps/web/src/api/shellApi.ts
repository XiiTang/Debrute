import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus
} from '@debrute/app-protocol';

export interface DebruteShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  bindProjectWindowToProject?(input: { projectId: string }): Promise<{ ok: true }>;
  revealProjectPathInSystemFileManager?(input: { projectId: string; projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
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
