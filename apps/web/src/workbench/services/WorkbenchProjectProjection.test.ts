import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { createWorkbenchProjectProjection } from './WorkbenchProjectProjection.js';

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
});

function snapshotFixture(projectName: string): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: '/projects/example',
    canvasWorkspace: {
      status: 'available',
      workspace: {
        canonicalRoot: '/projects/example',
        activeCanvasId: 'main',
        canvases: [{
          id: 'main',
          name: 'Main',
          expandedDirectories: [],
          nodeStates: {},
          occlusionOrder: []
        }]
      },
      activeCanvasResources: { canvasId: 'main', resources: [], diagnostics: [] }
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
