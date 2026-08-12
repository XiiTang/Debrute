import type {
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createProjectCommandGate } from './projectCommandGate';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection';

describe('Project Command Gate', () => {
  it('admits commands only for a bound Project on an available presentation surface', () => {
    const projection = createWorkbenchProjectProjection();
    let opening = false;
    let surfaceAvailable = true;
    const gate = createProjectCommandGate({
      projectBindingLifecycle: { getState: () => ({ opening }) },
      projectProjection: projection,
      isCommandSurfaceAvailable: () => surfaceAvailable
    });

    expect(gate.available()).toBe(false);
    expect(gate.accept()).toBeUndefined();

    projection.acceptBoundProject(projectResult('project-a', 1));
    expect(gate.available()).toBe(true);

    opening = true;
    expect(gate.available()).toBe(false);
    opening = false;
    surfaceAvailable = false;
    expect(gate.accept()).toBeUndefined();
  });

  it('captures identity privately, checks submission once, and lets an admitted request finish', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a', 1));
    let opening = false;
    const gate = createProjectCommandGate({
      projectBindingLifecycle: { getState: () => ({ opening }) },
      projectProjection: projection,
      isCommandSurfaceAvailable: () => true
    });
    const scope = gate.accept();
    if (!scope) {
      throw new Error('Expected an accepted Project Command scope.');
    }
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);

    const result = scope.submit(operation);
    expect(operation).toHaveBeenCalledOnce();
    expect(Object.keys(scope).sort()).toEqual(['isCurrent', 'submit', 'waitForRevision']);

    opening = true;
    expect(scope.submit(operation)).toBeUndefined();
    pending.resolve('complete');
    await expect(result).resolves.toBe('complete');
    expect(scope.isCurrent()).toBe(true);
    expect(scope.isCurrent('project-a')).toBe(true);
    expect(scope.isCurrent('project-b')).toBe(false);
  });

  it('returns the accepted snapshot at the revision barrier and rejects a stale generation', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(projectResult('project-a', 1));
    const gate = createProjectCommandGate({
      projectBindingLifecycle: { getState: () => ({ opening: false }) },
      projectProjection: projection,
      isCommandSurfaceAvailable: () => true
    });
    const scope = gate.accept();
    if (!scope) {
      throw new Error('Expected an accepted Project Command scope.');
    }
    const waiting = scope.waitForRevision(2);
    projection.acceptProjectEvent({
      type: 'project.changed',
      bindingId: 'project-a',
      projectRevision: 2,
      snapshot: snapshot('Accepted')
    });

    await expect(waiting).resolves.toMatchObject({ health: { projectName: 'Accepted' } });

    projection.acceptBoundProject(projectResult('project-b', 1));
    expect(scope.isCurrent()).toBe(false);
    expect(scope.submit(async () => 'stale')).toBeUndefined();
    await expect(scope.waitForRevision(3)).rejects.toThrow('generation 1 is not current');
  });
});

function projectResult(bindingId: string, projectRevision: number): WorkbenchProjectOpenResult {
  return {
    bindingId,
    canonicalRoot: `/projects/${bindingId}`,
    projectRevision,
    snapshot: snapshot(bindingId),
    workingCopies: { text: {}, feedback: {} }
  };
}

function snapshot(projectName: string): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: `/projects/${projectName}`,
    canvasWorkspace: {
      status: 'unavailable',
      code: 'canvas_workspace_invalid',
      message: 'test'
    },
    projectTree: [],
    diagnostics: [],
    health: {
      projectName,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-08-12T00:00:00.000Z'
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
