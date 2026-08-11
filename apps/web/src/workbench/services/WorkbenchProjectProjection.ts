import type {
  WorkbenchEvent,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchWorkingCopies
} from '@debrute/app-protocol';
import {
  isSnapshotAffectingWorkbenchEvent,
  nextSnapshotFromWorkbenchEvent
} from './workbenchEvents';

interface AcceptedWorkbenchProjectBinding {
  generation: number;
  bindingId: string;
  canonicalRoot: string;
  projectRevision: number;
  snapshot: WorkbenchProjectSessionSnapshot;
  workingCopies: WorkbenchWorkingCopies;
}

export type WorkbenchProjectProjectionState =
  | { status: 'unbound'; generation: 0 }
  | ({ status: 'bound' } & AcceptedWorkbenchProjectBinding)
  | ({ status: 'detached' } & AcceptedWorkbenchProjectBinding)
  | ({ status: 'failed'; error: Error } & AcceptedWorkbenchProjectBinding);

export interface WorkbenchProjectProjection {
  getState(): WorkbenchProjectProjectionState;
  subscribe(listener: () => void): () => void;
  acceptBoundProject(project: WorkbenchProjectOpenResult): void;
  acceptProjectEvent(event: WorkbenchEvent): void;
  detachProject(bindingId: string): void;
  endConnection(error: Error): void;
  waitForRevision(generation: number, projectRevision: number): Promise<void>;
}

export function createWorkbenchProjectProjection(): WorkbenchProjectProjection {
  let state: WorkbenchProjectProjectionState = { status: 'unbound', generation: 0 };
  const listeners = new Set<() => void>();
  const revisionWaiters = new Set<{
    generation: number;
    projectRevision: number;
    resolve(): void;
    reject(error: Error): void;
  }>();

  const transition = (next: WorkbenchProjectProjectionState): void => {
    state = next;
    for (const waiter of revisionWaiters) {
      if (state.status === 'bound' && state.generation === waiter.generation) {
        if (state.projectRevision >= waiter.projectRevision) {
          revisionWaiters.delete(waiter);
          waiter.resolve();
        }
      } else {
        revisionWaiters.delete(waiter);
        waiter.reject(new Error(
          `Project binding generation ${waiter.generation} ended before revision ${waiter.projectRevision} was accepted.`
        ));
      }
    }
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptBoundProject(project) {
      transition({
        status: 'bound',
        generation: state.generation + 1,
        bindingId: project.bindingId,
        canonicalRoot: project.canonicalRoot,
        projectRevision: project.projectRevision,
        snapshot: project.snapshot,
        workingCopies: project.workingCopies
      });
    },
    acceptProjectEvent(event) {
      if (!('bindingId' in event) || !('projectRevision' in event)) {
        return;
      }
      if (state.status !== 'bound') {
        throw new Error('Cannot accept a Project event without a bound Project.');
      }
      if (event.bindingId !== state.bindingId || event.projectRevision !== state.projectRevision + 1) {
        const error = new Error(
          `Rejected Project event ${event.type} at revision ${event.projectRevision}.`
        );
        transition({ ...state, status: 'failed', error });
        throw error;
      }
      const snapshot = isSnapshotAffectingWorkbenchEvent(event)
        ? nextSnapshotFromWorkbenchEvent(event, state.snapshot)
        : state.snapshot;
      if (!snapshot) {
        throw new Error(`Project event ${event.type} did not produce a Project snapshot.`);
      }
      transition({
        ...state,
        projectRevision: event.projectRevision,
        snapshot
      });
    },
    detachProject(bindingId) {
      if (state.status !== 'bound' || state.bindingId !== bindingId) {
        throw new Error(`Cannot detach inactive Project binding ${bindingId}.`);
      }
      transition({ ...state, status: 'detached' });
    },
    endConnection(error) {
      if (state.status === 'bound') {
        transition({ ...state, status: 'failed', error });
      }
    },
    waitForRevision(generation, projectRevision) {
      if (state.status !== 'bound' || state.generation !== generation) {
        return Promise.reject(new Error(`Project binding generation ${generation} is not current.`));
      }
      if (state.projectRevision >= projectRevision) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        revisionWaiters.add({ generation, projectRevision, resolve, reject });
      });
    }
  };
}
