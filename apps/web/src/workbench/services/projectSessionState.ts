import type React from 'react';
import { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types';

export interface OpenInitialProjectResult {
  projectId?: string;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  route: DebruteWorkbenchRoute;
}

export async function openInitialProject(
  api: WorkbenchApiClient,
  route: DebruteWorkbenchRoute = currentDebruteWorkbenchRoute()
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

function currentDebruteWorkbenchRoute(): DebruteWorkbenchRoute {
  if (typeof window === 'undefined') {
    return { kind: 'workbench' };
  }
  return parseDebruteWorkbenchPath(window.location.pathname);
}

export function replaceWorkbenchProjectRoute(projectId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  const nextPath = `/projects/${encodeURIComponent(projectId)}`;
  if (window.location.pathname === nextPath) {
    return;
  }
  window.history.replaceState(window.history.state ?? null, '', `${nextPath}${window.location.search}${window.location.hash}`);
}
