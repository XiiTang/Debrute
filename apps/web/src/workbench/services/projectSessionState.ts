import { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';

export interface OpenInitialProjectResult {
  projectId?: string;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  route: DebruteWorkbenchRoute;
  projectOpen?: {
    attemptedPath?: string;
    error?: ProjectOpenStartupError;
  };
}

export type ProjectOpenStartupError =
  | { code: 'project-path-required' }
  | { code: 'project-path-must-be-absolute' }
  | { code: 'project-snapshot-load-failed'; message: string }
  | { code: 'project-open-failed'; message: string };

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
          error: {
            code: 'project-snapshot-load-failed',
            message: errorMessage(error)
          }
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
        projectOpen: { error: { code: 'project-path-required' } }
      };
    }
    if (!isAbsoluteLocalProjectPath(projectRoot)) {
      return {
        snapshot: undefined,
        route,
        projectOpen: { attemptedPath: projectRoot, error: { code: 'project-path-must-be-absolute' } }
      };
    }
    try {
      const opened = await api.openProject({ projectRoot });
      replaceWorkbenchProjectRoute(opened.projectId, { search: '', hash: '' });
      return {
        projectId: opened.projectId,
        snapshot: opened.snapshot,
        route,
        projectOpen: { attemptedPath: projectRoot }
      };
    } catch (error) {
      return {
        snapshot: undefined,
        route,
        projectOpen: {
          attemptedPath: projectRoot,
          error: {
            code: 'project-open-failed',
            message: errorMessage(error)
          }
        }
      };
    }
  }
  return {
    snapshot: undefined,
    route
  };
}

export function shouldShowInitialProjectLoader(route: DebruteWorkbenchRoute): boolean {
  return route.kind !== 'workbench';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function currentDebruteWorkbenchRoute(): DebruteWorkbenchRoute {
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
