import { describe, expect, it, vi } from 'vitest';

import type { ActivityRecord } from '@debrute/app-protocol';
import {
  WORKBENCH_ACTIVITY_FLOAT_MS,
  WORKBENCH_ACTIVITY_MOTION_MS,
  createWorkbenchActivities,
  scopeWorkbenchActivityNoticeReporter,
  type WorkbenchActivities,
  type WorkbenchActivityFloatingCard
} from './WorkbenchActivities';

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
  it('uses a distinct exact eight-second presentation for task start and terminal transition', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    const activities = createActivities();

    try {
      activities.acceptFrame({
        type: 'activity.snapshot',
        activityRevision: 1,
        records: [task('running')]
      });
      expect(activities.getSnapshot().floatingCards).toEqual([]);

      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 2,
        record: {
          ...task('running'),
          id: 'task-2',
          progress: { type: 'determinate', completed: 0, total: 4 }
        }
      });
      const started = requirePresentCard(activities);
      expect(started.recordId).toBe('task-2');
      expect(started.expiresAt - started.startedAt).toBe(WORKBENCH_ACTIVITY_FLOAT_MS);

      vi.advanceTimersByTime(1_000);
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 3,
        record: {
          ...task('running'),
          id: 'task-2',
          progress: { type: 'determinate', completed: 2, total: 4 }
        }
      });
      expect(requirePresentCard(activities)).toEqual(started);

      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 4,
        record: { ...task('succeeded'), id: 'task-2' }
      });
      const completed = requirePresentCard(activities);
      expect(completed.recordId).toBe('task-2');
      expect(completed.presentationId).not.toBe(started.presentationId);
      expect(completed.startedAt).toBe(started.startedAt + 1_000);

      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_FLOAT_MS - 1);
      expect(presentRecordIds(activities)).toEqual(['task-2']);
      vi.advanceTimersByTime(1);
      expect(activities.getSnapshot().floatingCards).toEqual([]);
      expect(activities.getSnapshot().records.map((record) => record.id)).toEqual([
        'task-1',
        'task-2'
      ]);
    } finally {
      activities.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps at most three visual cards and consumes rather than replays them through Center', () => {
    vi.useFakeTimers();
    const activities = createActivities();

    try {
      activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
      for (let revision = 1; revision <= 4; revision += 1) {
        activities.acceptFrame({
          type: 'activity.upsert',
          activityRevision: revision,
          record: notice(`notice-${revision}`)
        });
      }

      expect(activities.getSnapshot().records).toHaveLength(4);
      expect(presentRecordIds(activities)).toEqual([
        'notice-4',
        'notice-3',
        'notice-2'
      ]);

      activities.openCenter();
      expect(activities.getSnapshot().centerPresentation).toBe('open');
      expect(activities.getSnapshot().floatingCards).toEqual([]);
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 5,
        record: notice('notice-5')
      });
      expect(activities.getSnapshot().floatingCards).toEqual([]);

      activities.closeCenter();
      expect(activities.getSnapshot().centerPresentation).toBe('exiting');
      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS - 1);
      expect(activities.getSnapshot().centerPresentation).toBe('exiting');
      vi.advanceTimersByTime(1);
      expect(activities.getSnapshot().centerPresentation).toBe('hidden');
      expect(activities.getSnapshot().records).toHaveLength(5);
      expect(activities.getSnapshot().floatingCards).toEqual([]);
    } finally {
      activities.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels Center exit when reopened without restoring consumed floats', () => {
    vi.useFakeTimers();
    const activities = createActivities();

    try {
      activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 1,
        record: notice('notice-1')
      });
      activities.openCenter();
      activities.closeCenter();
      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS - 1);
      activities.openCenter();
      vi.advanceTimersByTime(1);

      expect(activities.getSnapshot().centerPresentation).toBe('open');
      expect(activities.getSnapshot().floatingCards).toEqual([]);
    } finally {
      activities.dispose();
      vi.useRealTimers();
    }
  });

  it('retains explicit removals only as inert 120ms presentation copies', () => {
    vi.useFakeTimers();
    const activities = createActivities();

    try {
      activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 1,
        record: notice('floating')
      });
      activities.acceptFrame({
        type: 'activity.remove',
        activityRevision: 2,
        activityIds: ['floating']
      });

      expect(activities.getSnapshot().records).toEqual([]);
      expect(activities.getSnapshot().floatingCards).toEqual([
        expect.objectContaining({
          phase: 'exiting',
          record: expect.objectContaining({ id: 'floating' })
        })
      ]);
      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS);
      expect(activities.getSnapshot().floatingCards).toEqual([]);

      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 3,
        record: notice('center')
      });
      activities.openCenter();
      activities.acceptFrame({
        type: 'activity.remove',
        activityRevision: 4,
        activityIds: ['center']
      });
      expect(activities.getSnapshot().records).toEqual([]);
      expect(activities.getSnapshot().exitingCenterCards).toEqual([
        expect.objectContaining({ record: expect.objectContaining({ id: 'center' }) })
      ]);
      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS);
      expect(activities.getSnapshot().exitingCenterCards).toEqual([]);
      expect(activities.getSnapshot().centerPresentation).toBe('open');
    } finally {
      activities.dispose();
      vi.useRealTimers();
    }
  });

  it('fades Escape-hidden cards but drops covered presentation immediately without replay', () => {
    vi.useFakeTimers();
    const activities = createActivities();

    try {
      activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 1,
        record: notice('escape')
      });
      activities.hideFloating();
      expect(activities.getSnapshot().floatingCards[0]?.phase).toBe('exiting');
      vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS);
      expect(activities.getSnapshot().floatingCards).toEqual([]);

      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 2,
        record: notice('before-blocker')
      });
      expect(presentRecordIds(activities)).toEqual(['before-blocker']);
      activities.setPresentationBlocked(true);
      expect(activities.getSnapshot().floatingCards).toEqual([]);
      activities.setPresentationBlocked(false);
      expect(activities.getSnapshot().floatingCards).toEqual([]);

      activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 3,
        record: notice('after-blocker')
      });
      expect(presentRecordIds(activities)).toEqual(['after-blocker']);
    } finally {
      activities.dispose();
      vi.useRealTimers();
    }
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
});

function createActivities(): WorkbenchActivities {
  return createWorkbenchActivities({
    dismiss: vi.fn(async () => undefined),
    clearTerminal: vi.fn(async () => undefined)
  });
}

function presentCards(activities: WorkbenchActivities): readonly Extract<
  WorkbenchActivityFloatingCard,
  { phase: 'present' }
>[] {
  return activities.getSnapshot().floatingCards.filter((card) => (
    card.phase === 'present'
  ));
}

function presentRecordIds(activities: WorkbenchActivities): string[] {
  return presentCards(activities).map((card) => card.recordId);
}

function requirePresentCard(
  activities: WorkbenchActivities
): Extract<WorkbenchActivityFloatingCard, { phase: 'present' }> {
  const cards = presentCards(activities);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  if (!card) throw new Error('Expected a floating Activity presentation.');
  return card;
}
