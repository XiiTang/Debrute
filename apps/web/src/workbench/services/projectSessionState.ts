import {
  parseDebruteWorkbenchPath,
  type DebruteWorkbenchRoute,
  type WorkbenchProjectTarget
} from '@debrute/app-protocol';

export interface InitialProjectRouteResolution {
  route: DebruteWorkbenchRoute;
  target?: WorkbenchProjectTarget;
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

export function resolveInitialProjectRoute(
  route: DebruteWorkbenchRoute = currentDebruteWorkbenchRoute()
): InitialProjectRouteResolution {
  if (route.kind !== 'project-open') {
    return { route };
  }
  const projectRoot = route.projectRoot;
  if (projectRoot === undefined || projectRoot === '') {
    return {
      route,
      projectOpen: { error: { code: 'project-path-required' } }
    };
  }
  if (!isAbsoluteLocalProjectPath(projectRoot)) {
    return {
      route,
      projectOpen: {
        attemptedPath: projectRoot,
        error: { code: 'project-path-must-be-absolute' }
      }
    };
  }
  return {
    route,
    target: { projectRoot },
    projectOpen: { attemptedPath: projectRoot }
  };
}

export function shouldShowInitialProjectLoader(route: DebruteWorkbenchRoute): boolean {
  return route.kind === 'project-open';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function currentDebruteWorkbenchRoute(): DebruteWorkbenchRoute {
  return parseDebruteWorkbenchPath(
    window.location.pathname,
    window.location.search,
    window.location.hash
  );
}

export function replaceWorkbenchProjectRoute(canonicalRoot: string): void {
  const nextPath = `/open?path=${encodeURIComponent(canonicalRoot)}`;
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
