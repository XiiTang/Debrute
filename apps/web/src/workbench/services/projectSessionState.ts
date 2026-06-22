import type React from 'react';
import { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types';

export interface OpenInitialProjectResult {
  projectId?: string;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  route: DebruteWorkbenchRoute;
  projectOpen?: {
    path: string;
    error?: string;
  };
}

export async function openInitialProject(
  api: WorkbenchApiClient,
  route: DebruteWorkbenchRoute = currentDebruteWorkbenchRoute()
): Promise<OpenInitialProjectResult> {
  if (route.kind === 'project') {
    try {
      const opened = await api.openProject({ projectId: route.projectId });
      replaceWorkbenchProjectRoute(opened.projectId);
      return {
        projectId: opened.projectId,
        snapshot: opened.snapshot,
        route
      };
    } catch (error) {
      return {
        snapshot: undefined,
        route,
        projectOpen: {
          path: '',
          error: `Project snapshot load failed: ${errorMessage(error)}`
        }
      };
    }
  }
  if (route.kind === 'project-open') {
    const projectRoot = route.projectRoot?.trim() ?? '';
    if (!projectRoot) {
      return {
        snapshot: undefined,
        route,
        projectOpen: { path: '', error: 'Project path is required.' }
      };
    }
    if (!isAbsoluteLocalProjectPath(projectRoot)) {
      return {
        snapshot: undefined,
        route,
        projectOpen: { path: projectRoot, error: 'Project path must be absolute.' }
      };
    }
    try {
      const opened = await api.openProject({ projectRoot });
      replaceWorkbenchProjectRoute(opened.projectId, { search: '', hash: '' });
      return {
        projectId: opened.projectId,
        snapshot: opened.snapshot,
        route,
        projectOpen: { path: projectRoot }
      };
    } catch (error) {
      return {
        snapshot: undefined,
        route,
        projectOpen: {
          path: projectRoot,
          error: `Open project failed: ${errorMessage(error)}`
        }
      };
    }
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentDebruteWorkbenchRoute(): DebruteWorkbenchRoute {
  if (typeof window === 'undefined') {
    return { kind: 'workbench' };
  }
  return parseDebruteWorkbenchPath(window.location.pathname, window.location.search);
}

export function replaceWorkbenchProjectRoute(
  projectId: string,
  options: { search?: string; hash?: string } = {}
): void {
  if (typeof window === 'undefined') {
    return;
  }
  const nextPath = `/projects/${encodeURIComponent(projectId)}`;
  const nextSearch = options.search ?? window.location.search;
  const nextHash = options.hash ?? window.location.hash;
  const nextUrl = `${nextPath}${nextSearch}${nextHash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) {
    return;
  }
  window.history.replaceState(window.history.state ?? null, '', nextUrl);
}

export function isAbsoluteLocalProjectPath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
