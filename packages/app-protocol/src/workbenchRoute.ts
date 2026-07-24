export type DebruteWorkbenchRoute =
  | { kind: 'workbench' }
  | {
      kind: 'project-open';
      projectRoot?: string;
    }
  | {
      kind: 'project';
      projectId: string;
    }
  | { kind: 'not-found' };

const OPAQUE_PROJECT_ID = /^[A-Za-z0-9._~-]{1,256}$/;

export function parseDebruteWorkbenchPath(
  pathname: string,
  search = '',
  hash = ''
): DebruteWorkbenchRoute {
  if (hash !== '') {
    return { kind: 'not-found' };
  }
  if (pathname === '/') {
    return search === '' ? { kind: 'workbench' } : { kind: 'not-found' };
  }
  if (pathname === '/open') {
    if (search === '') {
      return { kind: 'project-open' };
    }
    const match = /^\?path=([^&]+)$/.exec(search);
    const encodedProjectRoot = match?.[1];
    if (encodedProjectRoot === undefined) {
      return { kind: 'not-found' };
    }
    try {
      const projectRoot = decodeURIComponent(encodedProjectRoot.replace(/\+/g, ' '));
      return projectRoot ? { kind: 'project-open', projectRoot } : { kind: 'not-found' };
    } catch {
      return { kind: 'not-found' };
    }
  }
  if (search !== '') {
    return { kind: 'not-found' };
  }
  const project = /^\/projects\/([^/]+)$/.exec(pathname);
  const projectId = project?.[1];
  if (
    projectId !== undefined
    && projectId !== '.'
    && projectId !== '..'
    && OPAQUE_PROJECT_ID.test(projectId)
  ) {
    return { kind: 'project', projectId };
  }
  return { kind: 'not-found' };
}
