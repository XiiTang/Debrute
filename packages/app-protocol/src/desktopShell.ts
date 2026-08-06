import type { NativeEditCommandId, NativeMenuCommand } from './workbenchChrome.js';

export interface NativeWindowState {
  maximized: boolean;
}

export type NativeMenuCommandResult =
  | { result: 'completed' }
  | { result: 'cancelled' };

export interface DesktopLaunchContext {
  desktopLaunchTicket: string;
  initialProjectRoot?: string;
}

export interface DebruteShellApi {
  getNativeWindowState(): Promise<NativeWindowState>;
  minimizeNativeWindow(): Promise<NativeWindowState>;
  toggleMaximizeNativeWindow(): Promise<NativeWindowState>;
  closeNativeWindow(): Promise<{ ok: true }>;
  executeNativeMenuCommand(input: NativeMenuCommand): Promise<NativeMenuCommandResult>;
  takeDesktopLaunchContext(): Promise<DesktopLaunchContext | undefined>;
  onNativeWindowStateChanged(listener: (state: NativeWindowState) => void): () => void;
  onNativeEditCommand(listener: (command: NativeEditCommandId) => void): () => void;
  onNativeProjectOpenRequested(listener: (projectRoot: string) => void): () => void;
  getDroppedFilePath(file: File): string | undefined;
}
