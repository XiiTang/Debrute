import electron from 'electron';
import type {
  WorkbenchTitleBarState
} from '@debrute/app-protocol';
import { createNativeWindowPreloadApi, type NativeWindowPreloadApi } from './nativeWindowShell.js';

const { contextBridge, ipcRenderer, webUtils } = electron;

interface DebruteShellApi extends NativeWindowPreloadApi {
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  getWorkbenchTitleBarState(input: { projectId?: string | undefined }): Promise<WorkbenchTitleBarState>;
  clearRecentProjectRoots(): Promise<{ ok: true }>;
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
  ...createNativeWindowPreloadApi(ipcRenderer),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || undefined
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
