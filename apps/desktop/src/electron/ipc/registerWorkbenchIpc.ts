import { stat } from 'node:fs/promises';
import type { Dialog, IpcMain, Shell } from 'electron';
import type { AxisAppServer } from '@axis/app-server';
import type { DesktopState } from '@axis/app-protocol';
import { assertProjectTreeVisibleMutationPath, resolveProjectPath } from '@axis/project-core';
import {
  revealProjectPathWithShell,
  shouldDeleteProjectPathPermanently,
  trashProjectPathWithShell
} from '../project-files/projectFileActions.js';
import type { HotExitStore } from '../hot-exit/hotExitStore.js';
import type { DesktopUpdateService } from '../update/updateService.js';
import type { AxisCliManager } from '../axis-cli/axisCliManager.js';
import { registerSafeIpcHandler } from './ipcErrors.js';

export interface RegisterWorkbenchIpcInput {
  ipcMain: IpcMain;
  dialog: Dialog;
  shell: Shell;
  server: AxisAppServer;
  platform: NodeJS.Platform;
  axisCliManager(): AxisCliManager;
  readDesktopState(): Promise<DesktopState>;
  setSetupCompleted(completed: boolean): Promise<DesktopState>;
  chooseProjectRoot(): Promise<string | undefined>;
  rememberProjectRoot(projectRoot: string): Promise<void>;
  updateService(): DesktopUpdateService;
  hotExitStore(): HotExitStore;
}

export function registerWorkbenchIpc(input: RegisterWorkbenchIpcInput): void {
  const { ipcMain, server } = input;
  const handle = <Result>(
    channel: string,
    handler: (...args: any[]) => Result | Promise<Result>
  ) => registerSafeIpcHandler(ipcMain, channel, handler);

  handle('axis:getDesktopState', async () => input.readDesktopState());
  handle('axis:setSetupCompleted', async (value: { completed?: unknown }) => input.setSetupCompleted(value?.completed === true));
  handle('axis:chooseProjectRoot', async () => input.chooseProjectRoot());
  handle('axis:openProject', async (projectRoot?: string) => {
    const desktopState = await input.readDesktopState();
    const selectedRoot = projectRoot ?? desktopState.lastProjectRoot;
    if (!selectedRoot) {
      return undefined;
    }
    const snapshot = await server.openProject(selectedRoot);
    await input.rememberProjectRoot(selectedRoot);
    return snapshot;
  });

  handle('axis:getSnapshot', async () => server.getSnapshot());
  handle('axis:getProjectHealth', async () => server.getProjectHealth());
  handle('axis:readProjectTextFile', async (projectRelativePath) => server.readProjectTextFile(projectRelativePath as string));
  handle('axis:writeProjectTextFile', async (projectRelativePath, content) => server.writeProjectTextFile(projectRelativePath as string, content as string));
  handle('axis:getDesktopPlatform', async () => input.platform);
  handle('axis:resolveProjectAbsolutePath', async (projectRelativePath) => {
    assertProjectTreeVisibleMutationPath(projectRelativePath as string);
    const absolutePath = resolveProjectPath(server.getSnapshot().projectRoot, projectRelativePath as string);
    await stat(absolutePath);
    return absolutePath;
  });
  handle('axis:createProjectFile', async (value) => server.createProjectFile(value));
  handle('axis:createProjectDirectory', async (value) => server.createProjectDirectory(value));
  handle('axis:renameProjectPath', async (value) => server.renameProjectPath(value));
  handle('axis:copyProjectPath', async (value) => server.copyProjectPath(value));
  handle('axis:moveProjectPath', async (value) => server.moveProjectPath(value));
  handle('axis:trashProjectPath', async (value: { projectRelativePath: string }) => {
    assertProjectTreeVisibleMutationPath(value.projectRelativePath);
    const absolutePath = resolveProjectPath(server.getSnapshot().projectRoot, value.projectRelativePath);
    await trashProjectPathWithShell(input.shell, absolutePath);
    const snapshot = await server.refreshProject();
    return { projectRelativePath: value.projectRelativePath, snapshot };
  });
  handle('axis:deleteProjectPathPermanently', async (value: { projectRelativePath: string }) => {
    if (!await shouldDeleteProjectPathPermanently(input.dialog, value.projectRelativePath)) {
      return undefined;
    }
    return server.deleteProjectPathPermanently(value);
  });
  handle('axis:revealProjectPathInSystemFileManager', async (value: { projectRelativePath: string; kind: 'file' | 'directory' }) => {
    assertProjectTreeVisibleMutationPath(value.projectRelativePath);
    const absolutePath = resolveProjectPath(server.getSnapshot().projectRoot, value.projectRelativePath);
    return revealProjectPathWithShell(input.shell, { absolutePath, kind: value.kind });
  });
  handle('axis:lookupGeneratedAssetMetadata', async (value) => server.lookupGeneratedAssetMetadata(value));
  handle('axis:readCanvasFeedback', async () => server.readCanvasFeedback());
  handle('axis:updateCanvasFeedbackEntry', async (value) => server.updateCanvasFeedbackEntry(value));
  handle('axis:refreshProject', async () => server.refreshProject());
  handle('axis:updateCanvasViewport', async (canvasId, viewport) => server.updateCanvasViewport(canvasId as string, viewport));
  handle('axis:updateCanvasSelection', async (canvasId, selection) => server.updateCanvasSelection(canvasId as string, selection));
  handle('axis:updateCanvasNodeLayouts', async (value) => server.updateCanvasNodeLayouts(value));
  handle('axis:updateCanvasNodeLayers', async (value) => server.updateCanvasNodeLayers(value));
  handle('axis:llmGetSettings', async () => server.llmGetSettings());
  handle('axis:llmSaveProviderSetting', async (value, providerId) => server.llmSaveProviderSetting(value, providerId as string | undefined));
  handle('axis:llmDeleteProviderSetting', async (providerId) => server.llmDeleteProviderSetting(providerId as string));
  handle('axis:llmSetDefaultModelKey', async (modelKey) => server.llmSetDefaultModelKey(modelKey as string | null));
  handle('axis:llmDiscoverProviderModels', async (value, providerId) => server.llmDiscoverProviderModels(value, providerId as string | undefined));
  handle('axis:imageModelGetSettings', async () => server.imageModelGetSettings());
  handle('axis:imageModelSaveSetting', async (modelId, value) => server.imageModelSaveSetting(modelId as string, value));
  handle('axis:videoModelGetSettings', async () => server.videoModelGetSettings());
  handle('axis:videoModelSaveSetting', async (modelId, value) => server.videoModelSaveSetting(modelId as string, value));
  handle('axis:integrationsListStatus', async () => server.integrationsListStatus());
  handle('axis:integrationsRescan', async () => server.integrationsRescan());
  handle('axis:canvasSettingsGet', async () => server.canvasSettingsGet());
  handle('axis:canvasSettingsSave', async (value) => server.canvasSettingsSave(value));
  handle('axis:axisCliGetStatus', async () => input.axisCliManager().getStatus());
  handle('axis:axisCliInstall', async () => input.axisCliManager().install());
  handle('axis:axisCliUpdate', async () => input.axisCliManager().update());
  handle('axis:axisCliRepair', async () => input.axisCliManager().repair());
  handle('axis:axisCliUninstall', async () => input.axisCliManager().uninstall());
  handle('axis:axisCliRefreshDevelopmentLink', async () => input.axisCliManager().refreshDevelopmentLink());
  handle('axis:getUpdateState', async () => input.updateService().getState());
  handle('axis:updateNow', async () => input.updateService().updateNow());
  handle('axis:getHotExitSnapshot', async () => input.hotExitStore().readHotExitSnapshot());
  handle('axis:clearHotExitSnapshot', async () => input.hotExitStore().clearHotExitSnapshot());
}
