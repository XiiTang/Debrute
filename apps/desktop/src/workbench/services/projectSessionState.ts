import type React from 'react';
import type { ProjectSessionSnapshot, WorkbenchApiClient } from '@axis/app-protocol';
import type { WorkbenchState, DesktopHotExitSnapshot } from '../../types';

export async function openInitialProject(api: WorkbenchApiClient): Promise<ProjectSessionSnapshot | undefined> {
  const state = await api.getDesktopState();
  return api.openProject(state.lastProjectRoot);
}

export async function loadCanvasFeedback(
  api: WorkbenchApiClient,
  setCanvasFeedback: React.Dispatch<React.SetStateAction<WorkbenchState['canvasFeedback']>>,
  setNotifications: React.Dispatch<React.SetStateAction<string[]>>
): Promise<void> {
  try {
    setCanvasFeedback(await api.readCanvasFeedback());
  } catch (error) {
    setCanvasFeedback(undefined);
    setNotifications((current) => [`Canvas feedback unavailable: ${errorMessage(error)}`, ...current].slice(0, 4));
  }
}

export async function openInitialProjectWithHotExit(
  api: WorkbenchApiClient,
  setNotifications: React.Dispatch<React.SetStateAction<string[]>>
): Promise<{ snapshot: ProjectSessionSnapshot | undefined; hotExit?: DesktopHotExitSnapshot }> {
  let hotExit: DesktopHotExitSnapshot | undefined;
  try {
    hotExit = await api.getHotExitSnapshot();
  } catch (error) {
    setNotifications((current) => [`Hot Exit restore failed: ${errorMessage(error)}`, ...current].slice(0, 4));
  }

  if (hotExit?.projectRoot) {
    try {
      const snapshot = await api.openProject(hotExit.projectRoot);
      return {
        snapshot,
        ...(snapshot ? { hotExit } : {})
      };
    } catch (error) {
      setNotifications((current) => [`Hot Exit project restore failed: ${errorMessage(error)}`, ...current].slice(0, 4));
      return { snapshot: await openInitialProject(api) };
    }
  }

  const snapshot = await openInitialProject(api);
  return {
    snapshot,
    ...(snapshot && hotExit ? { hotExit } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
