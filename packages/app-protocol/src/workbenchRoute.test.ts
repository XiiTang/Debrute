import { describe, expect, it } from 'vitest';
import { parseDebruteWorkbenchPath } from './workbenchRoute.js';

describe('Workbench routes', () => {
  it('parses only the three final Workbench page shapes', () => {
    expect(parseDebruteWorkbenchPath('/')).toEqual({ kind: 'workbench' });
    expect(parseDebruteWorkbenchPath('/open', '')).toEqual({ kind: 'project-open' });
    expect(parseDebruteWorkbenchPath('/open', '?path=%2FUsers%2Fme%2FProject%20A')).toEqual({
      kind: 'project-open',
      projectRoot: '/Users/me/Project A'
    });
    expect(parseDebruteWorkbenchPath('/projects/123e4567-e89b-42d3-a456-426614174000')).toEqual({
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    });
  });

  it.each([
    ['/projects/project-1/', '', ''],
    ['//projects/project-1', '', ''],
    ['/projects/project%201', '', ''],
    [`/projects/${'a'.repeat(257)}`, '', ''],
    ['/open', '?path=', ''],
    ['/open', '?path=%2Ftmp%2Fa&path=%2Ftmp%2Fb', ''],
    ['/open', '?path=%', ''],
    ['/open', '?path=%FF', ''],
    ['/projects/.', '', ''],
    ['/projects/..', '', ''],
    ['/projects/project-1', '', '#selection']
  ])('rejects pathname %s with search %s and hash %s', (pathname, search, hash) => {
    expect(parseDebruteWorkbenchPath(pathname, search, hash)).toEqual({ kind: 'not-found' });
  });
});
