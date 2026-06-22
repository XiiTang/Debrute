import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus,
  DesktopAppUpdateState,
  WorkbenchMenuCommandId,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';

export interface NativeWindowState {
  maximized: boolean;
}

export interface DebruteShellApi {
  bindProjectWindowToProject?(input: { projectId: string }): Promise<{ ok: true }>;
  getWorkbenchTitleBarState?(input: { projectId?: string | undefined }): Promise<WorkbenchTitleBarState>;
  clearRecentProjectRoots?(): Promise<{ ok: true }>;
  getNativeWindowState?(): Promise<NativeWindowState>;
  minimizeNativeWindow?(): Promise<NativeWindowState>;
  toggleMaximizeNativeWindow?(): Promise<NativeWindowState>;
  closeNativeWindow?(): Promise<{ ok: true }>;
  executeNativeMenuCommand?(input: {
    commandId: WorkbenchMenuCommandId;
    payload?: Record<string, string | boolean> | undefined;
  }): Promise<{ ok: true }>;
  onNativeWindowStateChanged?(listener: (state: NativeWindowState) => void): () => void;
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
