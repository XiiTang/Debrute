export type DebruteWorkbenchRoute =
  | { kind: 'workbench' }
  | {
      kind: 'project-open';
      projectRoot?: string;
    }
  | { kind: 'not-found' };

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
  return { kind: 'not-found' };
}
