import electron from 'electron';
import type { DebruteShellApi } from '@debrute/app-protocol';
import { createNativeWindowPreloadApi } from './nativeWindowShell.js';

const { contextBridge, ipcRenderer, webUtils } = electron;

const debruteShellApi: DebruteShellApi = {
  ...createNativeWindowPreloadApi(ipcRenderer),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file) || undefined
};

contextBridge.exposeInMainWorld('debruteShell', debruteShellApi);
