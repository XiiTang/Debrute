import { parseDebruteWorkbenchPath, type DebruteWorkbenchRoute, type WorkbenchApiClient, type WorkbenchProjectSessionSnapshot, type WorkbenchWorkingCopies } from '@debrute/app-protocol';

export interface OpenInitialProjectResult {
  projectId?: string;
  projectRevision?: number;
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  workingCopies?: WorkbenchWorkingCopies;
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
        return { snapshot: undefined, route };
      }
      replaceWorkbenchProjectRoute(opened.projectId);
      return {
        projectId: opened.projectId,
        projectRevision: opened.projectRevision,
        snapshot: opened.snapshot,
        ...(opened.workingCopies ? { workingCopies: opened.workingCopies } : {}),
        route
      };
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error) ?? route.projectId;
      return {
        snapshot: undefined,
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
      if ('outcome' in opened) {
        return {
          snapshot: undefined,
          route,
          projectOpen: { attemptedPath: projectRoot }
        };
      }
      replaceWorkbenchProjectRoute(opened.projectId, { search: '', hash: '' });
      return {
        projectId: opened.projectId,
        projectRevision: opened.projectRevision,
        snapshot: opened.snapshot,
        ...(opened.workingCopies ? { workingCopies: opened.workingCopies } : {}),
        route,
        projectOpen: { attemptedPath: projectRoot }
      };
    } catch (error) {
      const openHereProjectId = projectOpenHereProjectId(error);
      return {
        snapshot: undefined,
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
