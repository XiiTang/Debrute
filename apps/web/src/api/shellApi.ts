import type { WorkbenchMenuCommandId } from '@debrute/app-protocol';

export interface NativeWindowState {
  maximized: boolean;
}

export interface DebruteShellApi {
  getNativeWindowState?(): Promise<NativeWindowState>;
  minimizeNativeWindow?(): Promise<NativeWindowState>;
  toggleMaximizeNativeWindow?(): Promise<NativeWindowState>;
  closeNativeWindow?(): Promise<{ ok: true }>;
  executeNativeMenuCommand?(input: {
    commandId: WorkbenchMenuCommandId;
    payload?: Record<string, string | boolean> | undefined;
  }): Promise<{ ok: true }>;
  takeDesktopLaunchTicket?(): Promise<string | undefined>;
  onNativeWindowStateChanged?(listener: (state: NativeWindowState) => void): () => void;
  onOpenProjectRequested?(listener: (projectRoot: string) => void): () => void;
  getDroppedFilePath?(file: File): string | undefined;
}

export function getDebruteShellApi(): DebruteShellApi | undefined {
  return typeof window === 'undefined' ? undefined : window.debruteShell;
}
