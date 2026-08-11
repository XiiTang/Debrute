import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection';

describe('Workbench Project Projection', () => {
  it('accepts one ordered stream of complete Project snapshots', async () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject({
      bindingId: 'binding-1',
      canonicalRoot: '/projects/example',
      projectRevision: 4,
      snapshot: snapshotFixture('Initial'),
      workingCopies: { text: {}, feedback: {} }
    });
    const wait = projection.waitForRevision(1, 5);

    projection.acceptProjectEvent({
      type: 'project.changed',
      bindingId: 'binding-1',
      projectRevision: 5,
      snapshot: snapshotFixture('Updated')
    });

    await expect(wait).resolves.toBeUndefined();
    expect(projection.getState()).toMatchObject({
      status: 'bound',
      generation: 1,
      projectRevision: 5,
      snapshot: { health: { projectName: 'Updated' } }
    });
  });

  it('fails a binding when the Project revision is not consecutive', () => {
    const projection = createWorkbenchProjectProjection();
    projection.acceptBoundProject({
      bindingId: 'binding-1',
      canonicalRoot: '/projects/example',
      projectRevision: 4,
      snapshot: snapshotFixture('Initial'),
      workingCopies: { text: {}, feedback: {} }
    });

    expect(() => projection.acceptProjectEvent({
      type: 'project.changed',
      bindingId: 'binding-1',
      projectRevision: 6,
      snapshot: snapshotFixture('Skipped')
    })).toThrow('Rejected Project event');
    expect(projection.getState().status).toBe('failed');
  });

  it('applies only the authoritative Canvas State delta for an ordered event', () => {
    const projection = createWorkbenchProjectProjection();
    const initial = snapshotFixture('Initial');
    projection.acceptBoundProject({
      bindingId: 'binding-1',
      canonicalRoot: '/projects/example',
      projectRevision: 4,
      snapshot: initial,
      workingCopies: { text: {}, feedback: {} }
    });

    projection.acceptProjectEvent({
      type: 'canvas.state.changed',
      bindingId: 'binding-1',
      projectRevision: 5,
      change: {
        nodeStates: [{
          projectRelativePath: 'flow/a.png',
          state: {
            manualLayout: { x: 10, y: 20, width: 300, height: 200 }
          }
        }],
        occlusionOrder: ['flow/a.png']
      }
    });

    const state = projection.getState();
    expect(state.status).toBe('bound');
    if (state.status !== 'bound' || state.snapshot.canvasWorkspace.status !== 'available') {
      throw new Error('Expected an available bound Canvas Workspace.');
    }
    expect(state.snapshot.canvasWorkspace.workspace.nodeStates).toEqual({
      'flow/a.png': {
        manualLayout: { x: 10, y: 20, width: 300, height: 200 }
      }
    });
    expect(state.snapshot.canvasWorkspace.canvasResources).toBe(
      initial.canvasWorkspace.status === 'available'
        ? initial.canvasWorkspace.canvasResources
        : undefined
    );
    expect(state.snapshot.projectTree).toBe(initial.projectTree);
    expect(state.snapshot.canvasWorkspace.workspace.expandedDirectories).toBe(
      initial.canvasWorkspace.status === 'available'
        ? initial.canvasWorkspace.workspace.expandedDirectories
        : undefined
    );
  });

  it('removes an exact node state without replacing unrelated state', () => {
    const projection = createWorkbenchProjectProjection();
    const initial = snapshotFixture('Initial');
    if (initial.canvasWorkspace.status !== 'available') throw new Error('fixture');
    initial.canvasWorkspace.workspace.nodeStates = {
      'flow/a.png': { manualLayout: { x: 1, y: 2, width: 3, height: 4 } },
      'flow/b.png': { videoPlayback: { currentTimeMs: 12 } }
    };
    const retained = initial.canvasWorkspace.workspace.nodeStates['flow/b.png'];
    projection.acceptBoundProject({
      bindingId: 'binding-1', canonicalRoot: '/projects/example', projectRevision: 4,
      snapshot: initial, workingCopies: { text: {}, feedback: {} }
    });
    projection.acceptProjectEvent({
      type: 'canvas.state.changed', bindingId: 'binding-1', projectRevision: 5,
      change: { nodeStates: [{ projectRelativePath: 'flow/a.png', state: null }] }
    });
    const state = projection.getState();
    if (state.status !== 'bound' || state.snapshot.canvasWorkspace.status !== 'available') throw new Error('state');
    expect(state.snapshot.canvasWorkspace.workspace.nodeStates).toEqual({ 'flow/b.png': retained });
    expect(state.snapshot.canvasWorkspace.workspace.nodeStates['flow/b.png']).toBe(retained);
  });
});

function snapshotFixture(projectName: string): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: '/projects/example',
    canvasWorkspace: {
      status: 'available',
      workspace: {
        canonicalRoot: '/projects/example',
        expandedDirectories: [],
        nodeStates: {},
        occlusionOrder: []
      },
      canvasResources: { resources: [] },
      feedbackVideoResources: { resources: [] }
    },
    projectTree: [],
    diagnostics: [],
    health: {
      projectName,
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-08-05T00:00:00.000Z'
    }
  };
}
