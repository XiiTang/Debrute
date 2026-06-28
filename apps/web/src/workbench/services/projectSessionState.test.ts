import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApiClient, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { openInitialProject, replaceWorkbenchProjectRoute, shouldShowInitialProjectLoader } from './projectSessionState';

describe('project session startup', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('opens the project addressed by the project Workbench route', async () => {
    const calls: unknown[] = [];
    const snapshot = { canvases: [{ id: 'canvas-1' }] } as WorkbenchProjectSessionSnapshot;
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        return { projectId: '123e4567-e89b-42d3-a456-426614174000', snapshot };
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, {
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    })).resolves.toEqual({
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      snapshot,
      route: {
        kind: 'project',
        projectId: '123e4567-e89b-42d3-a456-426614174000'
      }
    });

    expect(calls).toEqual([{ projectId: '123e4567-e89b-42d3-a456-426614174000' }]);
  });

  it('surfaces project route load failures as structured project-opening errors', async () => {
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        throw new Error('Project session is not open.');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, {
      kind: 'project',
      projectId: 'missing-project'
    })).resolves.toEqual({
      snapshot: undefined,
      route: {
        kind: 'project',
        projectId: 'missing-project'
      },
      projectOpen: {
        error: {
          code: 'project-snapshot-load-failed',
          message: 'Project session is not open.'
        }
      }
    });
    expect(calls).toEqual([{ projectId: 'missing-project' }]);
  });

  it('keeps the Workbench root empty until a project is explicitly opened', async () => {
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        throw new Error('openProject should not be called for the Workbench root');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, { kind: 'workbench' })).resolves.toEqual({
      snapshot: undefined,
      route: { kind: 'workbench' }
    });

    expect(calls).toEqual([]);
  });

  it('skips the project-opening loader for the Workbench root', () => {
    expect(shouldShowInitialProjectLoader({ kind: 'workbench' })).toBe(false);
  });

  it('keeps the project-opening loader for explicit project routes', () => {
    expect(shouldShowInitialProjectLoader({
      kind: 'project',
      projectId: '123e4567-e89b-42d3-a456-426614174000'
    })).toBe(true);
    expect(shouldShowInitialProjectLoader({
      kind: 'project-open',
      projectRoot: '/Users/me/Project A'
    })).toBe(true);
  });

  it('opens an absolute path from the project-open route and removes the path from browser history', async () => {
    const replaceState = vi.fn();
    const snapshot = { canvases: [{ id: 'canvas-1' }] } as WorkbenchProjectSessionSnapshot;
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/open', search: '?path=%2FUsers%2Fme%2FProject%20A', hash: '' },
      history: { state: { debruteDaemonToken: 'secret' }, replaceState }
    };
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        return { projectId: 'project-live-id', projectRevision: 1, snapshot };
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api)).resolves.toEqual({
      projectId: 'project-live-id',
      snapshot,
      route: { kind: 'project-open', projectRoot: '/Users/me/Project A' },
      projectOpen: { attemptedPath: '/Users/me/Project A' }
    });
    expect(calls).toEqual([{ projectRoot: '/Users/me/Project A' }]);
    expect(replaceState).toHaveBeenCalledWith(
      { debruteDaemonToken: 'secret' },
      '',
      '/projects/project-live-id'
    );
  });

  it('rejects a relative project-open path without calling the daemon', async () => {
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        throw new Error('openProject should not be called for relative paths');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, { kind: 'project-open', projectRoot: 'relative/project' })).resolves.toMatchObject({
      snapshot: undefined,
      projectOpen: {
        attemptedPath: 'relative/project',
        error: { code: 'project-path-must-be-absolute' }
      }
    });
    expect(calls).toEqual([]);
  });

  it('surfaces a missing project-open path without attempted path context', async () => {
    const calls: unknown[] = [];
    const api = {
      openProject: async (input: unknown) => {
        calls.push(input);
        throw new Error('openProject should not be called without a path');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, { kind: 'project-open' })).resolves.toMatchObject({
      snapshot: undefined,
      projectOpen: {
        error: { code: 'project-path-required' }
      }
    });
    expect(calls).toEqual([]);
  });

  it('keeps failed project-open attempts as structured read-only error context', async () => {
    const api = {
      openProject: async () => {
        throw new Error('projectRoot must resolve to a directory.');
      }
    } as unknown as WorkbenchApiClient;

    await expect(openInitialProject(api, { kind: 'project-open', projectRoot: '/missing/project' })).resolves.toMatchObject({
      snapshot: undefined,
      projectOpen: {
        attemptedPath: '/missing/project',
        error: {
          code: 'project-open-failed',
          message: 'projectRoot must resolve to a directory.'
        }
      }
    });
  });

  it('does not rewrite the Workbench root route without an explicit project id', async () => {
    const replaceState = vi.fn();
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/', search: '', hash: '' },
      history: { replaceState }
    };
    const api = {
      openProject: async () => {
        throw new Error('openProject should not be called for the Workbench root');
      }
    } as unknown as WorkbenchApiClient;

    await openInitialProject(api, { kind: 'workbench' });

    expect(replaceState).not.toHaveBeenCalled();
  });

  it('preserves browser history state when replacing the active project route', () => {
    const replaceState = vi.fn();
    const state = { debruteDaemonToken: 'secret' };
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/', search: '?view=canvas', hash: '#selection' },
      history: { state, replaceState }
    };

    replaceWorkbenchProjectRoute('123e4567-e89b-42d3-a456-426614174000');

    expect(replaceState).toHaveBeenCalledWith(
      state,
      '',
      '/projects/123e4567-e89b-42d3-a456-426614174000?view=canvas#selection'
    );
  });
});
