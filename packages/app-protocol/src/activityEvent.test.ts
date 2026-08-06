import { describe, expect, it } from 'vitest';

import { decodeWorkbenchActivityFrame } from './index.js';

describe('Workbench Activity protocol', () => {
  it('accepts a closed Runtime snapshot containing notices and tasks', () => {
    const frame = decodeWorkbenchActivityFrame({
      type: 'activity.snapshot',
      activityRevision: 4,
      records: [
        {
          id: 'notice-1',
          source: 'canvas',
          project: { canonicalRoot: '/projects/project-1', projectName: 'Project One' },
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          type: 'notice',
          message: { kind: 'canvas-operation-failed', operation: 'save-layout' }
        },
        {
          id: 'task-1',
          source: 'model-request',
          project: { canonicalRoot: '/projects/project-1', projectName: 'Project One' },
          createdAt: '2026-08-02T00:00:01.000Z',
          updatedAt: '2026-08-02T00:00:02.000Z',
          type: 'task',
          status: 'running',
          progress: { type: 'determinate', completed: 3, total: 4 },
          message: { kind: 'model-request', modelKind: 'video', itemCount: 4 }
        }
      ]
    });

    expect(frame?.type).toBe('activity.snapshot');
    expect(frame && 'records' in frame ? frame.records.map((record) => record.id) : []).toEqual([
      'notice-1',
      'task-1'
    ]);
  });

  it('rejects arbitrary messages and impossible progress', () => {
    expect(decodeWorkbenchActivityFrame({
      type: 'activity.upsert',
      activityRevision: 1,
      record: {
        id: 'task-1',
        source: 'model-request',
        createdAt: 'now',
        updatedAt: 'now',
        type: 'task',
        status: 'running',
        progress: { type: 'determinate', completed: 5, total: 4 },
        message: { kind: 'arbitrary-text', text: 'anything' }
      }
    })).toBeUndefined();
  });
});
