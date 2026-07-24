import { describe, expect, it } from 'vitest';
import { workbenchPageEntry } from '../vite.config';

describe('Workbench Vite page routes', () => {
  it.each([
    '/',
    '/open',
    '/open?path=%2FUsers%2Fme%2FProject%20A',
    '/projects/project-1'
  ])('rewrites the closed page route %s to the Workbench entry', (url) => {
    expect(workbenchPageEntry('GET', url)).toBe('/index.html');
  });

  it.each([
    '/settings',
    '/assets/app.js',
    '/projects/.',
    '/projects/..',
    '/open?path=%FF'
  ])('leaves non-page request %s to Vite static handling and its 404', (url) => {
    expect(workbenchPageEntry('GET', url)).toBeUndefined();
  });

  it('does not rewrite non-page methods', () => {
    expect(workbenchPageEntry('POST', '/')).toBeUndefined();
  });
});
