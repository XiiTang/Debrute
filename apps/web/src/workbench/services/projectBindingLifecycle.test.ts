import type {
  WorkbenchApiClient,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectBindingLifecycle,
  type ProjectBindingLifecycle
} from './projectBindingLifecycle';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection';

describe('Project binding lifecycle', () => {
  it('closes admission synchronously, ignores a concurrent open, and commits an accepted binding', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const pending = deferred<WorkbenchProjectOpenResult>();
    let lifecycle!: ProjectBindingLifecycle;
    const openProject = vi.fn<WorkbenchApiClient['openProject']>(() => {
      expect(lifecycle.getState()).toEqual({ opening: true });
      return pending.promise;
    });
    const commitProjectRoute = vi.fn();
    lifecycle = createProjectBindingLifecycle({
      openProject,
      projectProjection: projection,
      commitProjectRoute
    });

    const opening = lifecycle.open({ projectRoot: '/projects/b' });

    await expect(lifecycle.open({ projectRoot: '/projects/c' })).resolves.toBeUndefined();
    expect(openProject).toHaveBeenCalledTimes(1);
    const accepted = projectResult('project-b');
    projection.acceptBoundProject(accepted);
    pending.resolve(accepted);

    await expect(opening).resolves.toBeUndefined();
    expect(commitProjectRoute).toHaveBeenCalledWith('/projects/project-b');
    expect(lifecycle.getState()).toEqual({ opening: false });
  });

  it('rejects only a real failure of the current open intent', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const failure = new Error('B could not be prepared.');
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(async () => {
        throw failure;
      }),
      projectProjection: projection,
      commitProjectRoute: vi.fn()
    });

    await expect(lifecycle.open({ projectRoot: '/projects/b' })).rejects.toBe(failure);
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      bindingId: 'project-a',
      generation: 1
    });
    expect(lifecycle.getState()).toEqual({ opening: false });
  });

  it('resolves when Runtime focuses an existing Desktop', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a'));
    const commitProjectRoute = vi.fn();
    const lifecycle = createProjectBindingLifecycle({
      openProject: vi.fn<WorkbenchApiClient['openProject']>(async () => ({
        outcome: 'focused_existing_desktop',
        canonicalRoot: '/projects/b'
      })),
      projectProjection: projection,
      commitProjectRoute
    });

    await expect(lifecycle.open({ projectRoot: '/projects/b' })).resolves.toBeUndefined();
    expect(commitProjectRoute).not.toHaveBeenCalled();
  });

  it('silently discards a failure from an intent superseded by another binding', async () => {
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

    await expect(obsolete).resolves.toBeUndefined();
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      bindingId: 'project-c',
      generation: 2
    });
    expect(commitProjectRoute).not.toHaveBeenCalled();
  });
});

function projectResult(bindingId: string): WorkbenchProjectOpenResult {
  return {
    bindingId,
    canonicalRoot: `/projects/${bindingId}`,
    projectRevision: 1,
    snapshot: { bindingId } as unknown as WorkbenchProjectSessionSnapshot,
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
