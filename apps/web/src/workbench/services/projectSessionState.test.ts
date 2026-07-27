import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  replaceWorkbenchProjectRoute,
  resolveInitialProjectRoute,
  shouldShowInitialProjectLoader
} from './projectSessionState.js';

describe('initial Project route', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('resolves a Project route to one concrete Project id', () => {
    expect(resolveInitialProjectRoute({
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    })).toEqual({
      route: {
        kind: 'project',
        projectId: '123e4567-e89b-42d3-a456-426614174000'
      },
      target: { projectId: '123e4567-e89b-42d3-a456-426614174000' }
    });
  });

  it('keeps the Workbench root target-free', () => {
    expect(resolveInitialProjectRoute({ kind: 'workbench' })).toEqual({
      route: { kind: 'workbench' }
    });
  });

  it('passes an absolute Project path through unchanged', () => {
    expect(resolveInitialProjectRoute({
      kind: 'project-open',
      projectRoot: '/Users/me/Project '
    })).toEqual({
      route: { kind: 'project-open', projectRoot: '/Users/me/Project ' },
      target: { projectRoot: '/Users/me/Project ' },
      projectOpen: { attemptedPath: '/Users/me/Project ' }
    });
  });

  it('rejects missing and relative Project paths before binding begins', () => {
    expect(resolveInitialProjectRoute({ kind: 'project-open' })).toEqual({
      route: { kind: 'project-open' },
      projectOpen: { error: { code: 'project-path-required' } }
    });
    expect(resolveInitialProjectRoute({
      kind: 'project-open',
      projectRoot: 'relative/project'
    })).toEqual({
      route: { kind: 'project-open', projectRoot: 'relative/project' },
      projectOpen: {
        attemptedPath: 'relative/project',
        error: { code: 'project-path-must-be-absolute' }
      }
    });
  });

  it('shows the initial loader only for explicit Project routes', () => {
    expect(shouldShowInitialProjectLoader({ kind: 'workbench' })).toBe(false);
    expect(shouldShowInitialProjectLoader({
      kind: 'project',
      projectId: 'project-1'
    })).toBe(true);
    expect(shouldShowInitialProjectLoader({
      kind: 'project-open',
      projectRoot: '/Users/me/Project A'
    })).toBe(true);
    expect(shouldShowInitialProjectLoader({ kind: 'not-found' })).toBe(false);
  });

  it('commits an accepted Project id without preserving stale search or hash state', () => {
    const replaceState = vi.fn();
    const state = { preserved: true };
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/', search: '?view=canvas', hash: '#selection' },
      history: { state, replaceState }
    };

    replaceWorkbenchProjectRoute('123e4567-e89b-42d3-a456-426614174000');

    expect(replaceState).toHaveBeenCalledWith(
      state,
      '',
      '/projects/123e4567-e89b-42d3-a456-426614174000'
    );
  });
});
