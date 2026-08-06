import { describe, expect, it, vi } from 'vitest';

import type { ActivityRecord } from '@debrute/app-protocol';
import {
  WORKBENCH_ACTIVITY_FLOAT_MS,
  createWorkbenchActivities,
  scopeWorkbenchActivityNoticeReporter
} from './WorkbenchActivities.js';

function task(
  status: 'running' | 'succeeded'
): Extract<ActivityRecord, { type: 'task' }> {
  return {
    id: 'task-1',
    source: 'model-request',
    project: { canonicalRoot: 'project-1', projectName: 'Project One' },
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: status === 'running'
      ? '2026-08-02T00:00:01.000Z'
      : '2026-08-02T00:00:02.000Z',
    type: 'task',
    status,
    progress: {
      type: 'determinate',
      completed: status === 'running' ? 3 : 4,
      total: 4
    },
    message: { kind: 'model-request', modelKind: 'video', itemCount: 4 }
  };
}

function notice(id: string): ActivityRecord {
  return {
    id,
    source: 'workbench',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    type: 'notice',
    message: { kind: 'workbench-operation-failed', operation: 'window-command' }
  };
}

describe('WorkbenchActivities', () => {
  it('does not replay history and floats only task start and terminal transitions for eight seconds', () => {
    vi.useFakeTimers();
    const activities = createWorkbenchActivities({
      dismiss: vi.fn(async () => undefined),
      clearTerminal: vi.fn(async () => undefined)
    });

    activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 1,
      records: [task('running')]
    });
    expect(activities.getSnapshot().floatingRecordIds).toEqual([]);

    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 2,
      record: {
        ...task('running'),
        id: 'task-2',
        progress: { type: 'determinate', completed: 0, total: 4 }
      }
    });
    expect(activities.getSnapshot().floatingRecordIds).toEqual(['task-2']);

    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 3,
      record: {
        ...task('running'),
        id: 'task-2',
        progress: { type: 'determinate', completed: 2, total: 4 }
      }
    });
    expect(activities.getSnapshot().floatingRecordIds).toEqual(['task-2']);

    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 4,
      record: { ...task('succeeded'), id: 'task-2' }
    });
    vi.advanceTimersByTime(WORKBENCH_ACTIVITY_FLOAT_MS - 1);
    expect(activities.getSnapshot().floatingRecordIds).toEqual(['task-2']);
    vi.advanceTimersByTime(1);
    expect(activities.getSnapshot().floatingRecordIds).toEqual([]);
    expect(activities.getSnapshot().records.map((record) => record.id)).toEqual([
      'task-1',
      'task-2'
    ]);

    activities.dispose();
    vi.useRealTimers();
  });

  it('drops reports after a Project generation is retired', () => {
    const report = vi.fn();
    let current = true;
    const scoped = scopeWorkbenchActivityNoticeReporter({ report }, () => current);

    scoped.report({ kind: 'canvas-operation-failed', operation: 'save-layout' });
    current = false;
    scoped.report({ kind: 'canvas-operation-failed', operation: 'reset-layout' });

    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      kind: 'canvas-operation-failed',
      operation: 'save-layout'
    });
  });

  it('keeps complete history while floating only the three newest event-time cards', () => {
    vi.useFakeTimers();
    const activities = createWorkbenchActivities({
      dismiss: vi.fn(async () => undefined),
      clearTerminal: vi.fn(async () => undefined)
    });
    activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
    for (let revision = 1; revision <= 4; revision += 1) {
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: revision,
        record: notice(`notice-${revision}`)
      });
    }

    expect(activities.getSnapshot().records).toHaveLength(4);
    expect(activities.getSnapshot().floatingRecordIds).toEqual([
      'notice-4',
      'notice-3',
      'notice-2'
    ]);

    activities.openCenter();
    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 5,
      record: notice('notice-5')
    });
    activities.closeCenter();
    expect(activities.getSnapshot().records).toHaveLength(5);
    expect(activities.getSnapshot().floatingRecordIds).toEqual([]);

    activities.dispose();
    vi.useRealTimers();
  });

  it('does not restore a floating card after a blocking surface has hidden it', () => {
    vi.useFakeTimers();
    const activities = createWorkbenchActivities({
      dismiss: vi.fn(async () => undefined),
      clearTerminal: vi.fn(async () => undefined)
    });
    activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 1,
      record: notice('before-blocker')
    });
    expect(activities.getSnapshot().floatingRecordIds).toEqual(['before-blocker']);

    activities.setPresentationBlocked(true);
    activities.setPresentationBlocked(false);
    expect(activities.getSnapshot().floatingRecordIds).toEqual([]);
    expect(activities.getSnapshot().records.map((record) => record.id)).toEqual([
      'before-blocker'
    ]);

    activities.acceptFrame({
      type: 'activity.upsert',
      activityRevision: 2,
      record: notice('after-blocker')
    });
    expect(activities.getSnapshot().floatingRecordIds).toEqual(['after-blocker']);

    activities.dispose();
    vi.useRealTimers();
  });
});
