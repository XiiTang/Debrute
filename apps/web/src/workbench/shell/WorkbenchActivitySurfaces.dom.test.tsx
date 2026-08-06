import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ActivityRecord } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n/index.js';
import { createWorkbenchActivities } from '../services/WorkbenchActivities.js';
import { WorkbenchActivitySurfaces } from './WorkbenchActivitySurfaces.js';

const notice: ActivityRecord = {
  id: 'notice-1',
  source: 'canvas',
  project: { canonicalRoot: 'project-1', projectName: 'Alpha' },
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  type: 'notice',
  message: { kind: 'canvas-operation-failed', operation: 'save-layout' }
};

const task: ActivityRecord = {
  id: 'task-1',
  source: 'model-request',
  project: { canonicalRoot: 'project-1', projectName: 'Alpha' },
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:01.000Z',
  type: 'task',
  status: 'running',
  progress: { type: 'determinate', completed: 2, total: 4 },
  message: { kind: 'model-request', modelKind: 'video', itemCount: 4 }
};

describe('WorkbenchActivitySurfaces', () => {
  it('renders the same complete Activity card while floating and in the center', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });
    harness.activities.acceptFrame({ type: 'activity.upsert', activityRevision: 1, record: notice });

    try {
      await harness.render(false);
      const floatingCard = harness.container.querySelector(
        '[data-activity-container="floating"] .db-activity-card'
      );
      expect(floatingCard?.textContent).toContain('Notification · Canvas · Alpha');
      expect(floatingCard?.textContent).toContain('Save Canvas layout failed.');
      expect(floatingCard?.querySelector('[role="progressbar"]')).toBeNull();

      await act(async () => harness.activities.openCenter());
      expect(harness.container.querySelector('[data-activity-container="floating"]')).toBeNull();
      const center = harness.container.querySelector('[data-activity-container="center"]');
      expect(center?.textContent).toContain('Activity');
      expect(center?.querySelector('.db-activity-card')?.textContent)
        .toContain('Notification · Canvas · Alpha');
    } finally {
      await harness.dispose();
    }
  });

  it('shows real progress and does not allow an active task to be cleared', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 1,
      records: [task]
    });
    harness.activities.openCenter();

    try {
      await harness.render(false);
      const card = harness.container.querySelector('.db-activity-card');
      expect(card?.textContent).toContain('In Progress · Model Request · Alpha');
      expect(card?.textContent).toContain('2 / 4');
      expect(card?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
      expect(card?.querySelector('[aria-label="Clear activity"]')).toBeNull();
      expect(harness.container.querySelector<HTMLButtonElement>('[data-activity-clear-all]')?.disabled)
        .toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('suppresses new floating presentation beneath a blocking surface without replay', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });

    try {
      await harness.render(true);
      await act(async () => {
        harness.activities.acceptFrame({
          type: 'activity.upsert',
          activityRevision: 1,
          record: notice
        });
      });
      expect(harness.activities.getSnapshot().records).toEqual([notice]);
      expect(harness.activities.getSnapshot().floatingRecordIds).toEqual([]);

      await harness.render(false);
      expect(harness.activities.getSnapshot().floatingRecordIds).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

function createHarness() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const activities = createWorkbenchActivities({
    dismiss: async () => undefined,
    clearTerminal: async () => undefined
  });
  return {
    activities,
    container,
    render: async (interactionBlocked: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <WorkbenchActivitySurfaces
              activities={activities}
              activityBellRef={createRef<HTMLButtonElement>()}
              interactionBlocked={interactionBlocked}
            />
          </I18nProvider>
        );
      });
    },
    dispose: async () => {
      await act(async () => root.unmount());
      activities.dispose();
      container.remove();
    }
  };
}
