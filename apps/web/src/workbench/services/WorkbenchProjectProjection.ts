import type {
  WorkbenchEvent,
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot,
  WorkbenchWorkingCopies
} from '@debrute/app-protocol';
import type { CanvasTextViewportState } from '@debrute/canvas-core';
import {
  isSnapshotAffectingWorkbenchEvent,
  nextSnapshotFromWorkbenchEvent
} from './workbenchEvents.js';

interface AcceptedWorkbenchProjectBinding {
  generation: number;
  projectId: string;
  projectRevision: number;
  authoritativeSnapshot: WorkbenchProjectSessionSnapshot;
  presentedSnapshot: WorkbenchProjectSessionSnapshot;
  workingCopies: WorkbenchWorkingCopies;
}

export type WorkbenchProjectProjectionState =
  | {
      status: 'unbound';
      generation: 0;
    }
  | ({ status: 'bound' } & AcceptedWorkbenchProjectBinding)
  | ({ status: 'detached' } & AcceptedWorkbenchProjectBinding)
  | ({ status: 'failed'; error: Error } & AcceptedWorkbenchProjectBinding);

export interface WorkbenchProjectProjection {
  getState(): WorkbenchProjectProjectionState;
  subscribe(listener: () => void): () => void;
  acceptBoundProject(project: WorkbenchProjectOpenResult): void;
  acceptProjectEvent(event: WorkbenchEvent): void;
  detachProject(projectId: string): void;
  endConnection(error: Error): void;
  waitForRevision(generation: number, projectRevision: number): Promise<void>;
  presentTextViewport(input: {
    canvasId: string;
    projectRelativePath: string;
    scrollTop: number;
    scrollLeft: number;
  }): WorkbenchTextViewportOverlayToken;
  rejectTextViewport(token: WorkbenchTextViewportOverlayToken): void;
}

export interface WorkbenchTextViewportOverlayToken {
  generation: number;
  key: string;
  version: number;
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
  const pendingTextViewports = new Map<string, {
    canvasId: string;
    projectRelativePath: string;
    viewport: CanvasTextViewportState;
    version: number;
  }>();
  let textViewportVersion = 0;

  const transition = (next: WorkbenchProjectProjectionState): void => {
    state = next;
    for (const waiter of revisionWaiters) {
      if (state.status === 'bound' && state.generation === waiter.generation) {
        if (state.projectRevision >= waiter.projectRevision) {
          revisionWaiters.delete(waiter);
          waiter.resolve();
        }
        continue;
      }
      revisionWaiters.delete(waiter);
      waiter.reject(new Error(
        `Project binding generation ${waiter.generation} ended before revision ${waiter.projectRevision} was accepted.`
      ));
    }
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acceptBoundProject(project) {
      pendingTextViewports.clear();
      transition({
        status: 'bound',
        generation: state.generation + 1,
        projectId: project.projectId,
        projectRevision: project.projectRevision,
        authoritativeSnapshot: project.snapshot,
        presentedSnapshot: project.snapshot,
        workingCopies: project.workingCopies
      });
    },
    acceptProjectEvent(event) {
      if (!('projectId' in event) || !('projectRevision' in event)) {
        return;
      }
      if (state.status !== 'bound') {
        throw new Error('Cannot accept a Project event without a bound Project.');
      }
      if (event.projectId !== state.projectId) {
        const error = new Error(
          `Received a Project event for ${event.projectId} while bound to ${state.projectId}.`
        );
        transition({ ...state, status: 'failed', error });
        throw error;
      }
      if (event.projectRevision !== state.projectRevision + 1) {
        const error = new Error(
          `Expected Project revision ${state.projectRevision + 1}, received ${event.projectRevision}.`
        );
        transition({ ...state, status: 'failed', error });
        throw error;
      }
      if (event.type === 'canvas.changed') {
        const canvasExists = state.authoritativeSnapshot.canvases.some(
          (canvas) => canvas.id === event.canvas.id
        );
        const projectionExists = state.authoritativeSnapshot.projections.some(
          (projection) => projection.canvasId === event.projection.canvasId
        );
        if (
          event.canvas.id !== event.projection.canvasId
          || !canvasExists
          || !projectionExists
        ) {
          const error = new Error(
            `Canvas event target ${event.canvas.id}/${event.projection.canvasId} is not in the accepted Project snapshot.`
          );
          transition({ ...state, status: 'failed', error });
          throw error;
        }
      }
      const authoritativeSnapshot = isSnapshotAffectingWorkbenchEvent(event)
        ? nextSnapshotFromWorkbenchEvent(event, state.authoritativeSnapshot)
        : state.authoritativeSnapshot;
      if (!authoritativeSnapshot) {
        throw new Error(`Project event ${event.type} did not produce a Project snapshot.`);
      }
      settleConfirmedTextViewports(authoritativeSnapshot, pendingTextViewports);
      transition({
        ...state,
        projectRevision: event.projectRevision,
        authoritativeSnapshot,
        presentedSnapshot: applyTextViewportOverlays(authoritativeSnapshot, pendingTextViewports.values())
      });
    },
    detachProject(projectId) {
      if (state.status !== 'bound' || state.projectId !== projectId) {
        throw new Error(`Cannot detach inactive Project ${projectId}.`);
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
        return Promise.reject(new Error(
          `Project binding generation ${generation} is not current.`
        ));
      }
      if (state.projectRevision >= projectRevision) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        revisionWaiters.add({ generation, projectRevision, resolve, reject });
      });
    },
    presentTextViewport(input) {
      if (state.status !== 'bound') {
        throw new Error('Cannot present a Text Viewport without a bound Project.');
      }
      const key = textViewportKey(input.canvasId, input.projectRelativePath);
      const version = textViewportVersion += 1;
      pendingTextViewports.set(key, {
        canvasId: input.canvasId,
        projectRelativePath: input.projectRelativePath,
        viewport: { scrollTop: input.scrollTop, scrollLeft: input.scrollLeft },
        version
      });
      transition({
        ...state,
        presentedSnapshot: applyTextViewportOverlays(
          state.authoritativeSnapshot,
          pendingTextViewports.values()
        )
      });
      return { generation: state.generation, key, version };
    },
    rejectTextViewport(token) {
      if (state.status === 'unbound' || state.generation !== token.generation) {
        return;
      }
      const pending = pendingTextViewports.get(token.key);
      if (!pending || pending.version !== token.version) {
        return;
      }
      pendingTextViewports.delete(token.key);
      transition({
        ...state,
        presentedSnapshot: applyTextViewportOverlays(
          state.authoritativeSnapshot,
          pendingTextViewports.values()
        )
      });
    }
  };
}

function settleConfirmedTextViewports(
  snapshot: WorkbenchProjectSessionSnapshot,
  pendingTextViewports: Map<string, {
    canvasId: string;
    projectRelativePath: string;
    viewport: CanvasTextViewportState;
  }>
): void {
  for (const [key, pending] of pendingTextViewports) {
    const accepted = snapshot.projections
      .find((projection) => projection.canvasId === pending.canvasId)
      ?.nodes.find((node) => node.projectRelativePath === pending.projectRelativePath)
      ?.textViewport;
    if (
      accepted?.scrollTop === pending.viewport.scrollTop
      && accepted.scrollLeft === pending.viewport.scrollLeft
    ) {
      pendingTextViewports.delete(key);
    }
  }
}

function applyTextViewportOverlays(
  snapshot: WorkbenchProjectSessionSnapshot,
  pendingTextViewports: Iterable<{
    canvasId: string;
    projectRelativePath: string;
    viewport: CanvasTextViewportState;
  }>
): WorkbenchProjectSessionSnapshot {
  const byKey = new Map<string, CanvasTextViewportState>();
  for (const pending of pendingTextViewports) {
    byKey.set(textViewportKey(pending.canvasId, pending.projectRelativePath), pending.viewport);
  }
  if (byKey.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    canvases: snapshot.canvases.map((canvas) => ({
      ...canvas,
      nodeElements: canvas.nodeElements.map((node) => {
        const viewport = byKey.get(textViewportKey(canvas.id, node.projectRelativePath));
        return viewport ? { ...node, textViewport: viewport } : node;
      })
    })),
    projections: snapshot.projections.map((projection) => ({
      ...projection,
      nodes: projection.nodes.map((node) => {
        const viewport = byKey.get(textViewportKey(projection.canvasId, node.projectRelativePath));
        return viewport ? { ...node, textViewport: viewport } : node;
      })
    }))
  };
}

function textViewportKey(canvasId: string, projectRelativePath: string): string {
  return `${canvasId}\u001f${projectRelativePath}`;
}
