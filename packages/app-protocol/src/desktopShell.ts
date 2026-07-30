import type { NativeMenuCommand } from './workbenchChrome.js';

export interface NativeWindowState {
  maximized: boolean;
}

export interface DebruteShellApi {
  getNativeWindowState(): Promise<NativeWindowState>;
  minimizeNativeWindow(): Promise<NativeWindowState>;
  toggleMaximizeNativeWindow(): Promise<NativeWindowState>;
  closeNativeWindow(): Promise<{ ok: true }>;
  executeNativeMenuCommand(input: NativeMenuCommand): Promise<{ ok: true }>;
  takeDesktopLaunchTicket(): Promise<string | undefined>;
  onNativeWindowStateChanged(listener: (state: NativeWindowState) => void): () => void;
  getDroppedFilePath(file: File): string | undefined;
}
