import type React from 'react';
import { parseAxisWorkbenchPath, type AxisWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectSessionSnapshot } from '@axis/app-protocol';
import type { WorkbenchState } from '../../types';

export interface OpenInitialProjectResult {
  projectId?: string;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  route: AxisWorkbenchRoute;
}

export async function openInitialProject(
  api: WorkbenchApiClient,
  route: AxisWorkbenchRoute = currentAxisWorkbenchRoute()
): Promise<OpenInitialProjectResult> {
  if (route.kind === 'project') {
    const opened = await api.openProject({ projectId: route.projectId });
    replaceWorkbenchProjectRoute(opened.projectId);
    return {
      projectId: opened.projectId,
      snapshot: opened.snapshot,
      route
    };
  }
  return {
    snapshot: undefined,
    route
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentAxisWorkbenchRoute(): AxisWorkbenchRoute {
  if (typeof window === 'undefined') {
    return { kind: 'workbench' };
  }
  return parseAxisWorkbenchPath(window.location.pathname);
}

export function replaceWorkbenchProjectRoute(projectId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  const nextPath = `/projects/${encodeURIComponent(projectId)}`;
  if (window.location.pathname === nextPath) {
    return;
  }
  window.history.replaceState(null, '', `${nextPath}${window.location.search}${window.location.hash}`);
}
