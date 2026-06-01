import electron from 'electron';
import type { DesktopWorkbenchApiClient } from '@axis/app-protocol';
import type { IpcResult } from './ipc/ipcErrors.js';
import { unwrapIpcResult } from './ipc/ipcErrors.js';

const { contextBridge, ipcRenderer } = electron;
type ApiArgs<Method extends keyof DesktopWorkbenchApiClient> = Parameters<DesktopWorkbenchApiClient[Method]>;
type ApiResult<Method extends keyof DesktopWorkbenchApiClient> = Awaited<ReturnType<DesktopWorkbenchApiClient[Method]>>;

async function invoke<Method extends keyof DesktopWorkbenchApiClient>(channel: string, ...args: unknown[]): Promise<ApiResult<Method>> {
  return unwrapIpcResult(await ipcRenderer.invoke(channel, ...args) as IpcResult<ApiResult<Method>>);
}

const axisDesktopApi = {
  getDesktopState: () => invoke<'getDesktopState'>('axis:getDesktopState'),
  setSetupCompleted: (input: ApiArgs<'setSetupCompleted'>[0]) => invoke<'setSetupCompleted'>('axis:setSetupCompleted', input),
  chooseProjectRoot: () => invoke<'chooseProjectRoot'>('axis:chooseProjectRoot'),
  openProject: (projectRoot?: string) => invoke<'openProject'>('axis:openProject', projectRoot),
  getSnapshot: () => invoke<'getSnapshot'>('axis:getSnapshot'),
  getProjectHealth: () => invoke<'getProjectHealth'>('axis:getProjectHealth'),
  readProjectTextFile: (projectRelativePath: string) => invoke<'readProjectTextFile'>('axis:readProjectTextFile', projectRelativePath),
  writeProjectTextFile: (projectRelativePath: string, content: string) => invoke<'writeProjectTextFile'>('axis:writeProjectTextFile', projectRelativePath, content),
  getDesktopPlatform: () => invoke<'getDesktopPlatform'>('axis:getDesktopPlatform'),
  resolveProjectAbsolutePath: (projectRelativePath: string) => invoke<'resolveProjectAbsolutePath'>('axis:resolveProjectAbsolutePath', projectRelativePath),
  createProjectFile: (input: ApiArgs<'createProjectFile'>[0]) => invoke<'createProjectFile'>('axis:createProjectFile', input),
  createProjectDirectory: (input: ApiArgs<'createProjectDirectory'>[0]) => invoke<'createProjectDirectory'>('axis:createProjectDirectory', input),
  renameProjectPath: (input: ApiArgs<'renameProjectPath'>[0]) => invoke<'renameProjectPath'>('axis:renameProjectPath', input),
  copyProjectPath: (input: ApiArgs<'copyProjectPath'>[0]) => invoke<'copyProjectPath'>('axis:copyProjectPath', input),
  moveProjectPath: (input: ApiArgs<'moveProjectPath'>[0]) => invoke<'moveProjectPath'>('axis:moveProjectPath', input),
  trashProjectPath: (input: ApiArgs<'trashProjectPath'>[0]) => invoke<'trashProjectPath'>('axis:trashProjectPath', input),
  deleteProjectPathPermanently: (input: ApiArgs<'deleteProjectPathPermanently'>[0]) => invoke<'deleteProjectPathPermanently'>('axis:deleteProjectPathPermanently', input),
  revealProjectPathInSystemFileManager: (input: ApiArgs<'revealProjectPathInSystemFileManager'>[0]) => invoke<'revealProjectPathInSystemFileManager'>('axis:revealProjectPathInSystemFileManager', input),
  lookupGeneratedAssetMetadata: (input: ApiArgs<'lookupGeneratedAssetMetadata'>[0]) => invoke<'lookupGeneratedAssetMetadata'>('axis:lookupGeneratedAssetMetadata', input),
  readCanvasFeedback: () => invoke<'readCanvasFeedback'>('axis:readCanvasFeedback'),
  updateCanvasFeedbackEntry: (input: ApiArgs<'updateCanvasFeedbackEntry'>[0]) => invoke<'updateCanvasFeedbackEntry'>('axis:updateCanvasFeedbackEntry', input),
  refreshProject: () => invoke<'refreshProject'>('axis:refreshProject'),
  updateCanvasViewport: (canvasId: ApiArgs<'updateCanvasViewport'>[0], viewport: ApiArgs<'updateCanvasViewport'>[1]) => invoke<'updateCanvasViewport'>('axis:updateCanvasViewport', canvasId, viewport),
  updateCanvasSelection: (canvasId: ApiArgs<'updateCanvasSelection'>[0], selection: ApiArgs<'updateCanvasSelection'>[1]) => invoke<'updateCanvasSelection'>('axis:updateCanvasSelection', canvasId, selection),
  updateCanvasNodeLayouts: (input: ApiArgs<'updateCanvasNodeLayouts'>[0]) => invoke<'updateCanvasNodeLayouts'>('axis:updateCanvasNodeLayouts', input),
  updateCanvasNodeLayers: (input: ApiArgs<'updateCanvasNodeLayers'>[0]) => invoke<'updateCanvasNodeLayers'>('axis:updateCanvasNodeLayers', input),
  llmGetSettings: () => invoke<'llmGetSettings'>('axis:llmGetSettings'),
  llmSaveProviderSetting: (input: ApiArgs<'llmSaveProviderSetting'>[0], providerId?: ApiArgs<'llmSaveProviderSetting'>[1]) => invoke<'llmSaveProviderSetting'>('axis:llmSaveProviderSetting', input, providerId),
  llmDeleteProviderSetting: (providerId: string) => invoke<'llmDeleteProviderSetting'>('axis:llmDeleteProviderSetting', providerId),
  llmSetDefaultModelKey: (modelKey: string | null) => invoke<'llmSetDefaultModelKey'>('axis:llmSetDefaultModelKey', modelKey),
  llmDiscoverProviderModels: (input: ApiArgs<'llmDiscoverProviderModels'>[0], providerId?: ApiArgs<'llmDiscoverProviderModels'>[1]) => invoke<'llmDiscoverProviderModels'>('axis:llmDiscoverProviderModels', input, providerId),
  imageModelGetSettings: () => invoke<'imageModelGetSettings'>('axis:imageModelGetSettings'),
  imageModelSaveSetting: (modelId: ApiArgs<'imageModelSaveSetting'>[0], input: ApiArgs<'imageModelSaveSetting'>[1]) => invoke<'imageModelSaveSetting'>('axis:imageModelSaveSetting', modelId, input),
  videoModelGetSettings: () => invoke<'videoModelGetSettings'>('axis:videoModelGetSettings'),
  videoModelSaveSetting: (modelId: ApiArgs<'videoModelSaveSetting'>[0], input: ApiArgs<'videoModelSaveSetting'>[1]) => invoke<'videoModelSaveSetting'>('axis:videoModelSaveSetting', modelId, input),
  integrationsListStatus: () => invoke<'integrationsListStatus'>('axis:integrationsListStatus'),
  integrationsRescan: () => invoke<'integrationsRescan'>('axis:integrationsRescan'),
  canvasSettingsGet: () => invoke<'canvasSettingsGet'>('axis:canvasSettingsGet'),
  canvasSettingsSave: (input: ApiArgs<'canvasSettingsSave'>[0]) => invoke<'canvasSettingsSave'>('axis:canvasSettingsSave', input),
  axisCliGetStatus: () => invoke<'axisCliGetStatus'>('axis:axisCliGetStatus'),
  axisCliInstall: () => invoke<'axisCliInstall'>('axis:axisCliInstall'),
  axisCliUpdate: () => invoke<'axisCliUpdate'>('axis:axisCliUpdate'),
  axisCliRepair: () => invoke<'axisCliRepair'>('axis:axisCliRepair'),
  axisCliUninstall: () => invoke<'axisCliUninstall'>('axis:axisCliUninstall'),
  axisCliRefreshDevelopmentLink: () => invoke<'axisCliRefreshDevelopmentLink'>('axis:axisCliRefreshDevelopmentLink'),
  getUpdateState: () => invoke<'getUpdateState'>('axis:getUpdateState'),
  updateNow: () => invoke<'updateNow'>('axis:updateNow'),
  getHotExitSnapshot: () => invoke<'getHotExitSnapshot'>('axis:getHotExitSnapshot'),
  clearHotExitSnapshot: () => invoke<'clearHotExitSnapshot'>('axis:clearHotExitSnapshot'),
  onHotExitSnapshotRequest: (listener: ApiArgs<'onHotExitSnapshotRequest'>[0]) => {
    const callback = async (_event: Electron.IpcRendererEvent, requestId: string) => {
      try {
        const snapshot = await listener();
        ipcRenderer.send('axis:hotExitSnapshotResponse', { requestId, snapshot });
      } catch (error) {
        ipcRenderer.send('axis:hotExitSnapshotResponse', {
          requestId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    ipcRenderer.on('axis:requestHotExitSnapshot', callback);
    return () => ipcRenderer.off('axis:requestHotExitSnapshot', callback);
  },
  onEvent: (listener: ApiArgs<'onEvent'>[0]) => {
    const callback = (_event: Electron.IpcRendererEvent, payload: Parameters<ApiArgs<'onEvent'>[0]>[0]) => listener(payload);
    ipcRenderer.on('axis:event', callback);
    return () => ipcRenderer.off('axis:event', callback);
  }
} satisfies DesktopWorkbenchApiClient;

contextBridge.exposeInMainWorld('axisDesktop', axisDesktopApi);
