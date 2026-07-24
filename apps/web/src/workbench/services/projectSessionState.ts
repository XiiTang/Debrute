import { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectOpenResult } from '@debrute/app-protocol';

export interface OpenInitialProjectResult {
  project: WorkbenchProjectOpenResult | undefined;
  route: DebruteWorkbenchRoute;
  projectOpen?: {
    attemptedPath?: string;
    error?: ProjectOpenStartupError;
  };
}

export type ProjectOpenStartupError =
  | { code: 'project-path-required' }
  | { code: 'project-path-must-be-absolute' }
  | { code: 'project-open-here-required'; projectId: string }
  | { code: 'project-snapshot-load-failed'; message: string }
  | { code: 'project-open-failed'; message: string };

export async function openInitialProject(
  api: WorkbenchApiClient,
  route: DebruteWorkbenchRoute = currentDebruteWorkbenchRoute()
): Promise<OpenInitialProjectResult> {
  if (route.kind === 'project') {
    try {
      const opened = await api.openProject({ projectId: route.projectId });
      if ('outcome' in opened) {
        return { project: undefined, route };
      }
      replaceWorkbenchProjectRoute(opened.projectId);
      return {
        project: opened,
        route
      };
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error) ?? route.projectId;
      return {
        project: undefined,
        route,
        projectOpen: {
          error: {
            ...(isProjectOwnedByWebError(error)
              ? { code: 'project-open-here-required' as const, projectId: openHereProjectId }
              : { code: 'project-snapshot-load-failed' as const, message: errorMessage(error) })
          }
        }
      };
    }
  }
  if (route.kind === 'project-open') {
    const projectRoot = route.projectRoot;
    if (projectRoot === undefined || projectRoot === '') {
      return {
        project: undefined,
        route,
        projectOpen: { error: { code: 'project-path-required' } }
      };
    }
    if (!isAbsoluteLocalProjectPath(projectRoot)) {
      return {
        project: undefined,
        route,
        projectOpen: { attemptedPath: projectRoot, error: { code: 'project-path-must-be-absolute' } }
      };
    }
    try {
      const opened = await api.openProject({ projectRoot });
      if ('outcome' in opened) {
        return {
          project: undefined,
          route,
          projectOpen: { attemptedPath: projectRoot }
        };
      }
      replaceWorkbenchProjectRoute(opened.projectId);
      return {
        project: opened,
        route,
        projectOpen: { attemptedPath: projectRoot }
      };
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      return {
        project: undefined,
        route,
        projectOpen: {
          attemptedPath: projectRoot,
          error: openHereProjectId
            ? { code: 'project-open-here-required', projectId: openHereProjectId }
            : { code: 'project-open-failed', message: errorMessage(error) }
        }
      };
    }
  }
  return {
    project: undefined,
    route
  };
}

export function shouldShowInitialProjectLoader(route: DebruteWorkbenchRoute): boolean {
  return route.kind === 'project' || route.kind === 'project-open';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function projectOpenHereProjectId(error: unknown): string | undefined {
  if (!isProjectOwnedByWebError(error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const projectId = (details as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' ? projectId : undefined;
}

function isProjectOwnedByWebError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'project_owned_by_web'
  );
}

export function currentDebruteWorkbenchRoute(): DebruteWorkbenchRoute {
  return parseDebruteWorkbenchPath(
    window.location.pathname,
    window.location.search,
    window.location.hash
  );
}

export function replaceWorkbenchProjectRoute(projectId: string): void {
  const nextPath = `/projects/${encodeURIComponent(projectId)}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextPath) {
    return;
  }
  window.history.replaceState(window.history.state ?? null, '', nextPath);
}

export function isAbsoluteLocalProjectPath(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
