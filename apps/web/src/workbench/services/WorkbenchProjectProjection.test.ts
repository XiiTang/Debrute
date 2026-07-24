import { describe, expect, it } from 'vitest';
import type {
  WorkbenchProjectOpenResult,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

describe('Workbench Project Projection', () => {
  it('accepts project.bound as the baseline and advances from the next Project stream revision', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotFixture('Bound')));

    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 8,
      snapshot: snapshotFixture('Stream')
    });

    expect(projection.getState()).toMatchObject({
      status: 'bound',
      generation: 1,
      projectId: 'project-1',
      projectRevision: 8,
      authoritativeSnapshot: {
        metadata: { project: { name: 'Stream' } }
      },
      presentedSnapshot: {
        metadata: { project: { name: 'Stream' } }
      }
    });
  });

  it.each([7, 6, 9])(
    'fails the binding on repeated, older, or skipped Project revision %s',
    (projectRevision) => {
      const projection = createWorkbenchProjectProjection();
      projection.acceptBoundProject(openResult(7, snapshotFixture('Last accepted')));

      expect(() => projection.acceptProjectEvent({
        type: 'project.changed',
        projectId: 'project-1',
        projectRevision,
        snapshot: snapshotFixture('Must not appear')
      })).toThrow(`Expected Project revision 8, received ${projectRevision}.`);

      expect(projection.getState()).toMatchObject({
        status: 'failed',
        generation: 1,
        projectRevision: 7,
        presentedSnapshot: {
          metadata: { project: { name: 'Last accepted' } }
        }
      });
    }
  );

  it('orders a feedback-only Project event without replacing the Project snapshot', () => {
    const projection = createWorkbenchProjectProjection();
    const boundSnapshot = snapshotFixture('Bound');
    projection.acceptBoundProject(openResult(7, boundSnapshot));

    projection.acceptProjectEvent({
      type: 'canvas.feedback.changed',
      projectId: 'project-1',
      projectRevision: 8,
      feedback: { updatedAt: '2026-07-23T00:00:00.000Z', entries: {} }
    });

    expect(projection.getState()).toMatchObject({
      status: 'bound',
      projectRevision: 8,
      authoritativeSnapshot: boundSnapshot,
      presentedSnapshot: boundSnapshot
    });
  });

  it('fails instead of advancing when canvas.changed targets an unknown Canvas', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotFixture('Bound')));

    expect(() => projection.acceptProjectEvent({
      type: 'canvas.changed',
      projectId: 'project-1',
      projectRevision: 8,
      canvas: {
        id: 'canvas-unknown',
        name: 'Unknown',
        nodeElements: [],
        annotations: [],
        preferences: { showDiagnostics: true }
      },
      projection: {
        canvasId: 'canvas-unknown',
        nodes: [],
        edges: [],
        diagnostics: []
      }
    })).toThrow('is not in the accepted Project snapshot');

    expect(projection.getState()).toMatchObject({
      status: 'failed',
      projectRevision: 7,
      authoritativeSnapshot: {
        metadata: { project: { name: 'Bound' } }
      }
    });
  });

  it('keeps a detached presentation in its generation and creates a new generation when rebound', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotFixture('First binding')));

    projection.detachProject('project-1');
    expect(projection.getState()).toMatchObject({
      status: 'detached',
      generation: 1,
      presentedSnapshot: {
        metadata: { project: { name: 'First binding' } }
      }
    });

    projection.acceptBoundProject(openResult(10, snapshotFixture('Second binding')));
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      generation: 2,
      projectRevision: 10,
      presentedSnapshot: {
        metadata: { project: { name: 'Second binding' } }
      }
    });
  });

  it('completes a revision wait only after that Project stream revision is accepted', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotFixture('Bound')));
    const wait = projection.waitForRevision(1, 8);
    let completed = false;
    void wait.then(() => { completed = true; });

    await Promise.resolve();
    expect(completed).toBe(false);

    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 8,
      snapshot: snapshotFixture('Accepted')
    });
    await expect(wait).resolves.toBeUndefined();
  });

  it('presents a pending Text Viewport until an accepted projection confirms its exact value', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotWithTextViewport(0, 0)));

    projection.presentTextViewport({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/readme.md',
      scrollTop: 40,
      scrollLeft: 5
    });
    expect(presentedTextViewport(projection.getState())).toEqual({ scrollTop: 40, scrollLeft: 5 });

    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 8,
      snapshot: snapshotWithTextViewport(40, 5)
    });
    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 9,
      snapshot: snapshotWithTextViewport(80, 9)
    });

    expect(presentedTextViewport(projection.getState())).toEqual({ scrollTop: 80, scrollLeft: 9 });
  });

  it('drops only the failed Text Viewport overlay and preserves a newer pending value', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotWithTextViewport(0, 0)));
    const older = projection.presentTextViewport({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/readme.md',
      scrollTop: 40,
      scrollLeft: 5
    });
    const newer = projection.presentTextViewport({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/readme.md',
      scrollTop: 80,
      scrollLeft: 9
    });

    projection.rejectTextViewport(older);
    expect(presentedTextViewport(projection.getState())).toEqual({ scrollTop: 80, scrollLeft: 9 });

    projection.rejectTextViewport(newer);
    expect(presentedTextViewport(projection.getState())).toEqual({ scrollTop: 0, scrollLeft: 0 });
  });

  it('drops a failed Text Viewport overlay after the binding has become read-only', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject(openResult(7, snapshotWithTextViewport(0, 0)));
    const token = projection.presentTextViewport({
      canvasId: 'canvas-1',
      projectRelativePath: 'notes/readme.md',
      scrollTop: 40,
      scrollLeft: 5
    });

    projection.endConnection(new Error('connection ended'));
    projection.rejectTextViewport(token);

    expect(projection.getState()).toMatchObject({ status: 'failed' });
    expect(presentedTextViewport(projection.getState())).toEqual({ scrollTop: 0, scrollLeft: 0 });
  });

  it('publishes each accepted Project state synchronously to subscribers', () => {
    const projection = createWorkbenchProjectProjection();
    const acceptedRevisions: number[] = [];
    const unsubscribe = projection.subscribe(() => {
      const state = projection.getState();
      if (state.status !== 'unbound') {
        acceptedRevisions.push(state.projectRevision);
      }
    });

    projection.acceptBoundProject(openResult(7, snapshotFixture('Bound')));
    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 8,
      snapshot: snapshotFixture('Accepted')
    });
    unsubscribe();
    projection.acceptProjectEvent({
      type: 'project.changed',
      projectId: 'project-1',
      projectRevision: 9,
      snapshot: snapshotFixture('Not observed')
    });

    expect(acceptedRevisions).toEqual([7, 8]);
  });
});

function openResult(
  projectRevision: number,
  snapshot: WorkbenchProjectSessionSnapshot
): WorkbenchProjectOpenResult {
  return {
    projectId: 'project-1',
    projectRevision,
    snapshot,
    workingCopies: { text: {}, feedback: {} }
  };
}

function snapshotFixture(projectName: string): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-1',
        name: projectName,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName,
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-23T00:00:00.000Z'
    }
  };
}

function snapshotWithTextViewport(
  scrollTop: number,
  scrollLeft: number
): WorkbenchProjectSessionSnapshot {
  const snapshot = snapshotFixture('Project');
  const node = {
    projectRelativePath: 'notes/readme.md',
    nodeKind: 'file' as const,
    mediaKind: 'text' as const,
    x: 10,
    y: 20,
    width: 420,
    height: 260,
    z: 0,
    textViewport: { scrollTop, scrollLeft }
  };
  return {
    ...snapshot,
    canvases: [{
      id: 'canvas-1',
      name: 'Canvas 1',
      nodeElements: [node],
      annotations: [],
      preferences: { showDiagnostics: true }
    }],
    projections: [{
      canvasId: 'canvas-1',
      nodes: [{
        ...node,
        availability: {
          state: 'available',
          size: 100,
          mimeType: 'text/markdown',
          fileUrl: '/api/projects/project-1/files/raw/notes/readme.md?v=revision',
          revision: 'revision'
        }
      }],
      edges: [],
      diagnostics: []
    }],
    canvasRegistry: { status: 'ready', canvasOrder: ['canvas-1'] }
  };
}

function presentedTextViewport(state: ReturnType<ReturnType<typeof createWorkbenchProjectProjection>['getState']>) {
  if (state.status === 'unbound') {
    return undefined;
  }
  return state.presentedSnapshot.canvases[0]?.nodeElements[0]?.textViewport;
}
