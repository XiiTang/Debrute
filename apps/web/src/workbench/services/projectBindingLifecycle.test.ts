import type {
  WorkbenchApiClient,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectBindingLifecycle,
  type ProjectBindingLifecycle
} from './projectBindingLifecycle.js';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

describe('Project binding lifecycle', () => {
  it('closes command admission synchronously, admits one attempt, and commits only an accepted binding', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const pending = deferred<WorkbenchProjectOpenResult>();
    let lifecycle!: ProjectBindingLifecycle;
    const openProject = vi.fn<WorkbenchApiClient['openProject']>(() => {
      expect(lifecycle.getState()).toEqual({ opening: true });
      expect(lifecycle.canStartProjectPathCommand(1)).toBe(false);
      return pending.promise;
    });
    const commitProjectRoute = vi.fn();
    lifecycle = createProjectBindingLifecycle({
      openProject,
      projectProjection: projection,
      commitProjectRoute
    });

    const opening = lifecycle.open({ projectRoot: '/projects/b' });

    expect(openProject).toHaveBeenCalledTimes(1);
    expect(commitProjectRoute).not.toHaveBeenCalled();
    await expect(lifecycle.open({ projectRoot: '/projects/c' })).resolves.toEqual({
      outcome: 'ignored_while_opening'
    });
    expect(openProject).toHaveBeenCalledTimes(1);

    const accepted = projectResult('project-b');
    projection.acceptBoundProject(accepted);
    pending.resolve(accepted);

    await expect(opening).resolves.toEqual({
      outcome: 'bound',
      projectId: 'project-b',
      generation: 2
    });
    expect(commitProjectRoute).toHaveBeenCalledWith('project-b');
    expect(lifecycle.getState()).toEqual({ opening: false });
    expect(lifecycle.canStartProjectPathCommand(1)).toBe(false);
    expect(lifecycle.canStartProjectPathCommand(2)).toBe(true);
  });

  it('restores the unchanged binding after a failed attempt', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const failure = new Error('B could not be prepared.');
    const commitProjectRoute = vi.fn();
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(async () => {
        throw failure;
      }),
      projectProjection: projection,
      commitProjectRoute
    });

    await expect(lifecycle.open({ projectRoot: '/projects/b' })).resolves.toEqual({
      outcome: 'failed',
      error: failure
    });
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      projectId: 'project-a',
      generation: 1
    });
    expect(lifecycle.getState()).toEqual({ opening: false });
    expect(lifecycle.canStartProjectPathCommand(1)).toBe(true);
    expect(commitProjectRoute).not.toHaveBeenCalled();
  });

  it('keeps the requesting binding and route when Runtime focuses an existing Desktop', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const commitProjectRoute = vi.fn();
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(async () => ({
        outcome: 'focused_existing_desktop',
        projectId: 'project-b'
      })),
      projectProjection: projection,
      commitProjectRoute
    });

    await expect(lifecycle.open({ projectRoot: '/projects/b' })).resolves.toEqual({
      outcome: 'focused_existing_desktop',
      projectId: 'project-b'
    });
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      projectId: 'project-a',
      generation: 1
    });
    expect(lifecycle.canStartProjectPathCommand(1)).toBe(true);
    expect(commitProjectRoute).not.toHaveBeenCalled();
  });

  it('does not let an obsolete attempt overwrite the current binding or route', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const pending = deferred<WorkbenchProjectOpenResult>();
    const commitProjectRoute = vi.fn();
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(() => pending.promise),
      projectProjection: projection,
      commitProjectRoute
    });

    const obsolete = lifecycle.open({ projectRoot: '/projects/b' });
    projection.acceptBoundProject(projectResult('project-c'));
    pending.reject(new Error('late B failure'));

    await expect(obsolete).resolves.toEqual({ outcome: 'superseded' });
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      projectId: 'project-c',
      generation: 2
    });
    expect(lifecycle.canStartProjectPathCommand(2)).toBe(true);
    expect(commitProjectRoute).not.toHaveBeenCalled();
  });
});

function projectResult(projectId: string): WorkbenchProjectOpenResult {
  return {
    projectId,
    projectRevision: 1,
    snapshot: { projectId } as unknown as WorkbenchProjectSessionSnapshot,
    workingCopies: { text: {}, feedback: {} }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
