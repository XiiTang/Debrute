import { act, createRef, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityRecord } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n/index';
import {
  WORKBENCH_ACTIVITY_MOTION_MS,
  createWorkbenchActivities
} from '../services/WorkbenchActivities';
import { WorkbenchActivitySurfaces } from './WorkbenchActivitySurfaces';

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
  it('renders one complete Activity Card in the Floating Stack and named Center region', async () => {
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
      expect(center?.tagName).toBe('SECTION');
      expect(center?.getAttribute('role')).toBeNull();
      expect(center?.getAttribute('aria-label')).toBe('Activity');
      expect(center?.getAttribute('data-activity-phase')).toBe('open');
      expect(center?.querySelector('[aria-label="Close"]')).toBeNull();
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

  it('orders mixed groups and clears one terminal record without closing Center', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 1,
      records: [notice, task]
    });
    harness.activities.openCenter();

    try {
      await harness.render(false);
      const text = harness.container.textContent ?? '';
      expect(text.indexOf('Active')).toBeLessThan(text.indexOf('Recent'));
      expect(text.indexOf('In Progress · Model Request · Alpha'))
        .toBeLessThan(text.indexOf('Notification · Canvas · Alpha'));

      const noticeCard = harness.container.querySelector<HTMLElement>(
        `[data-activity-record-id="${notice.id}"]`
      );
      const dismiss = noticeCard?.querySelector<HTMLButtonElement>('[aria-label="Clear activity"]');
      await act(async () => dismiss?.click());

      expect(harness.dismiss).toHaveBeenCalledOnce();
      expect(harness.dismiss).toHaveBeenCalledWith(notice.id);
      expect(harness.activities.getSnapshot().centerPresentation).toBe('open');
    } finally {
      await harness.dispose();
    }
  });

  it('keeps Center open through Clear All and shows empty only after inert card exit', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 1,
      records: [notice]
    });
    harness.activities.openCenter();

    try {
      await harness.render(false);
      const clear = harness.container.querySelector<HTMLButtonElement>('[data-activity-clear-all]');
      await act(async () => clear?.click());
      expect(harness.clearTerminal).toHaveBeenCalledOnce();

      await act(async () => harness.activities.acceptFrame({
        type: 'activity.remove',
        activityRevision: 2,
        activityIds: [notice.id]
      }));
      const exiting = harness.container.querySelector('.db-activity-card-presence--exiting');
      expect(exiting?.getAttribute('aria-hidden')).toBe('true');
      expect(exiting?.hasAttribute('inert')).toBe(true);
      expect(harness.container.textContent).not.toContain('No activity');
      expect(harness.activities.getSnapshot().centerPresentation).toBe('open');

      await act(async () => vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS));
      expect(harness.container.textContent).toContain('No activity');
      expect(harness.activities.getSnapshot().centerPresentation).toBe('open');
    } finally {
      await harness.dispose();
      vi.useRealTimers();
    }
  });

  it('closes from an outside pointer or Escape without taking focus or consuming the gesture', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 1,
      records: [notice]
    });
    harness.activities.openCenter();

    try {
      await harness.render(false);
      harness.activityBellRef.current?.focus();
      expect(document.activeElement).toBe(harness.activityBellRef.current);

      const inside = harness.container.querySelector<HTMLElement>('.db-activity-card');
      await act(async () => inside?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      expect(harness.activities.getSnapshot().centerPresentation).toBe('open');

      const outsidePointer = vi.fn();
      harness.outside.addEventListener('pointerdown', outsidePointer);
      await act(async () => harness.outside.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true
      })));
      expect(outsidePointer).toHaveBeenCalledOnce();
      expect(harness.activities.getSnapshot().centerPresentation).toBe('exiting');
      const exitingCenter = harness.container.querySelector('[data-activity-phase="exiting"]');
      expect(exitingCenter?.getAttribute('aria-hidden')).toBe('true');
      expect(exitingCenter?.hasAttribute('inert')).toBe(true);
      const exitingDismiss = exitingCenter?.querySelector<HTMLButtonElement>(
        '[aria-label="Clear activity"]'
      );
      await act(async () => exitingDismiss?.click());
      expect(harness.dismiss).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(WORKBENCH_ACTIVITY_MOTION_MS));
      expect(harness.container.querySelector('[data-activity-container="center"]')).toBeNull();

      await act(async () => harness.activities.openCenter());
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      })));
      expect(harness.activities.getSnapshot().centerPresentation).toBe('exiting');
      expect(document.activeElement).toBe(harness.activityBellRef.current);
    } finally {
      await harness.dispose();
      vi.useRealTimers();
    }
  });

  it('preserves the visible record anchor when a newer Activity is inserted above it', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({
      type: 'activity.snapshot',
      activityRevision: 0,
      records: [notice]
    });
    harness.activities.openCenter();

    try {
      await harness.render(false);
      const body = harness.container.querySelector<HTMLDivElement>('.db-activity-center__body');
      const anchor = harness.container.querySelector<HTMLElement>(
        `[data-activity-record-id="${notice.id}"]`
      );
      if (!body || !anchor) throw new Error('Expected Activity scroll fixtures.');

      let anchorTop = 20;
      body.scrollTop = 100;
      Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 500 });
      vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect({ top: 0, bottom: 300 }));
      vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect({
        top: anchorTop,
        bottom: anchorTop + 60
      }));
      await act(async () => body.dispatchEvent(new Event('scroll', { bubbles: true })));

      anchorTop = 60;
      await act(async () => harness.activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 1,
        record: {
          ...notice,
          id: 'notice-new',
          createdAt: '2026-08-02T00:01:00.000Z',
          updatedAt: '2026-08-02T00:01:00.000Z'
        }
      }));
      expect(body.scrollTop).toBe(140);
    } finally {
      await harness.dispose();
    }
  });

  it('suppresses new floating presentation beneath a blocking surface without replay', async () => {
    const harness = createHarness();
    harness.activities.acceptFrame({ type: 'activity.snapshot', activityRevision: 0, records: [] });

    try {
      await harness.render(true);
      await act(async () => harness.activities.acceptFrame({
        type: 'activity.upsert',
        activityRevision: 1,
        record: notice
      }));
      expect(harness.activities.getSnapshot().records).toEqual([notice]);
      expect(harness.activities.getSnapshot().floatingCards).toEqual([]);

      await harness.render(false);
      expect(harness.activities.getSnapshot().floatingCards).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

function createHarness() {
  const container = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(container, outside);
  const root = createRoot(container);
  const dismiss = vi.fn(async () => undefined);
  const clearTerminal = vi.fn(async () => undefined);
  const activities = createWorkbenchActivities({ dismiss, clearTerminal });
  const activityBellRef = createRef<HTMLButtonElement>();
  return {
    activities,
    activityBellRef,
    clearTerminal,
    container,
    dismiss,
    outside,
    render: async (interactionBlocked: boolean) => {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <button ref={activityBellRef} data-workbench-activity-bell>Activity</button>
            <WorkbenchActivitySurfaces
              activities={activities}
              activityBellRef={activityBellRef as RefObject<HTMLButtonElement | null>}
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
      outside.remove();
    }
  };
}

function rect(input: { top: number; bottom: number }): DOMRect {
  return {
    x: 0,
    y: input.top,
    width: 380,
    height: input.bottom - input.top,
    top: input.top,
    right: 380,
    bottom: input.bottom,
    left: 0,
    toJSON: () => ({})
  };
}
