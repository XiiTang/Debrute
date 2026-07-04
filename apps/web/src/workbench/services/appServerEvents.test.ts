import { describe, expect, it } from 'vitest';
import type { WorkbenchEvent, WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { nextSnapshotFromAppServerEvent } from './appServerEvents';

describe('appServerEvents', () => {
  it('applies Canvas feedback events without replacing the project snapshot', () => {
    const current = snapshotFixture();
    const event: WorkbenchEvent = {
      type: 'canvas.feedback.changed',
      projectId: 'project-live-id',
      projectRevision: 2,
      feedback: {
        updatedAt: '2026-06-12T00:00:00.000Z',
        entries: {
          'brief.md': {
            projectRelativePath: 'brief.md',
            marks: ['like'],
            nextMomentLabel: 1,
            nextSpatialLabel: 1,
            items: [{
              id: 'comment-1',
              kind: 'comment',
              scope: 'file',
              comment: 'Good',
              createdAt: '2026-06-12T00:00:00.000Z',
              updatedAt: '2026-06-12T00:00:00.000Z'
            }],
            updatedAt: '2026-06-12T00:00:00.000Z'
          }
        }
      }
    };

    expect(nextSnapshotFromAppServerEvent(event, current)).toBe(current);
  });
});

function snapshotFixture(): WorkbenchProjectSessionSnapshot {
  return {
    metadata: {
      project: {
        id: 'project-record-id',
        name: 'Test Project',
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:00:00.000Z'
      }
    },
    files: [],
    canvases: [],
    projections: [],
    diagnostics: [],
    canvasRegistry: { status: 'ready', canvasOrder: [] },
    health: {
      projectName: 'Test Project',
      canvasCount: 0,
      diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
      runtimeDataLocation: 'debrute-home',
      checkedAt: '2026-06-12T00:00:00.000Z'
    }
  };
}
