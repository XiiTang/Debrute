import electron from 'electron';
import type {
  WorkbenchMenuCommandId,
  WorkbenchTitleBarState
} from '@debrute/app-protocol';

const { contextBridge, ipcRenderer, webUtils } = electron;

interface DebruteShellApi {
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  getWorkbenchTitleBarState(input: { projectId?: string | undefined }): Promise<WorkbenchTitleBarState>;
  clearRecentProjectRoots(): Promise<{ ok: true }>;
  getNativeWindowState(): Promise<{ maximized: boolean }>;
  minimizeNativeWindow(): Promise<{ maximized: boolean }>;
  toggleMaximizeNativeWindow(): Promise<{ maximized: boolean }>;
  closeNativeWindow(): Promise<{ ok: true }>;
  executeNativeMenuCommand(input: {
    commandId: WorkbenchMenuCommandId;
    payload?: Record<string, string | boolean>;
  }): Promise<{ ok: true }>;
  onNativeWindowStateChanged(listener: (state: { maximized: boolean }) => void): () => void;
  getDroppedFilePath(file: File): string | undefined;
}

const debruteShellApi: DebruteShellApi = {
  bindProjectWindowToProject: (input) => (
    ipcRenderer.invoke('debrute-shell:bindProjectWindowToProject', input) as Promise<{ ok: true }>
  ),
  getWorkbenchTitleBarState: (input) => (
    ipcRenderer.invoke('debrute-shell:getWorkbenchTitleBarState', input) as Promise<WorkbenchTitleBarState>
  ),
  clearRecentProjectRoots: () => ipcRenderer.invoke('debrute-shell:clearRecentProjectRoots') as Promise<{ ok: true }>,
  getNativeWindowState: () => ipcRenderer.invoke('debrute-shell:getNativeWindowState') as Promise<{ maximized: boolean }>,
  minimizeNativeWindow: () => ipcRenderer.invoke('debrute-shell:minimizeNativeWindow') as Promise<{ maximized: boolean }>,
  toggleMaximizeNativeWindow: () => ipcRenderer.invoke('debrute-shell:toggleMaximizeNativeWindow') as Promise<{ maximized: boolean }>,
  closeNativeWindow: () => ipcRenderer.invoke('debrute-shell:closeNativeWindow') as Promise<{ ok: true }>,
  executeNativeMenuCommand: (input) => (
    ipcRenderer.invoke('debrute-shell:executeNativeMenuCommand', input) as Promise<{ ok: true }>
  ),
  onNativeWindowStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: { maximized: boolean }) => listener(state);
    ipcRenderer.on('debrute-shell:nativeWindowStateChanged', wrapped);
    return () => ipcRenderer.removeListener('debrute-shell:nativeWindowStateChanged', wrapped);
  },
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || undefined
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
