import electron from 'electron';
import {
  createNativeWindowPreloadApi,
  nativeWindowIpcChannels,
  type NativeWindowPreloadApi
} from './nativeWindowShell.js';

const { contextBridge, ipcRenderer, webUtils } = electron;

interface DebruteShellApi extends NativeWindowPreloadApi {
  onOpenProjectRequested(listener: (projectRoot: string) => void): () => void;
  getDroppedFilePath(file: File): string | undefined;
}

const debruteShellApi: DebruteShellApi = {
  onOpenProjectRequested: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, projectRoot: string) => listener(projectRoot);
    ipcRenderer.on(nativeWindowIpcChannels.openProjectRequested, wrapped);
    return () => ipcRenderer.removeListener(nativeWindowIpcChannels.openProjectRequested, wrapped);
  },
  ...createNativeWindowPreloadApi(ipcRenderer),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || undefined
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
