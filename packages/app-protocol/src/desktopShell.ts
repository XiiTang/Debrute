import type { NativeEditCommandId, NativeMenuCommand } from './workbenchChrome.js';

export interface NativeWindowState {
  maximized: boolean;
}

export interface NativeProjectOpenFailure {
  projectRoot: string;
  code: string;
  message: string;
}

export type NativeMenuCommandResult =
  | { result: 'completed' }
  | { result: 'cancelled' }
  | { result: 'project_open_failed'; failure: NativeProjectOpenFailure };

export interface DebruteShellApi {
  getNativeWindowState(): Promise<NativeWindowState>;
  minimizeNativeWindow(): Promise<NativeWindowState>;
  toggleMaximizeNativeWindow(): Promise<NativeWindowState>;
  closeNativeWindow(): Promise<{ ok: true }>;
  executeNativeMenuCommand(input: NativeMenuCommand): Promise<NativeMenuCommandResult>;
  takeDesktopLaunchTicket(): Promise<string | undefined>;
  onNativeWindowStateChanged(listener: (state: NativeWindowState) => void): () => void;
  onNativeEditCommand(listener: (command: NativeEditCommandId) => void): () => void;
  onNativeProjectOpenFailed(listener: (failure: NativeProjectOpenFailure) => void): () => void;
  getDroppedFilePath(file: File): string | undefined;
}
