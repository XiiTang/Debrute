import type {
  ActivityRecord,
  WorkbenchActivityFrame,
  WorkbenchActivityNoticeInput
} from '@debrute/app-protocol';

export const WORKBENCH_ACTIVITY_FLOAT_MS = 8_000;
const MAX_FLOATING_ACTIVITIES = 3;

export interface WorkbenchActivitiesSnapshot {
  readonly synchronized: boolean;
  readonly activityRevision: number;
  readonly centerOpen: boolean;
  readonly records: readonly ActivityRecord[];
  readonly floatingRecordIds: readonly string[];
}

export interface WorkbenchActivities {
  getSnapshot(): WorkbenchActivitiesSnapshot;
  subscribe(listener: () => void): () => void;
  acceptFrame(frame: WorkbenchActivityFrame): void;
  openCenter(): void;
  closeCenter(): void;
  hideFloating(): void;
  setPresentationBlocked(blocked: boolean): void;
  dismiss(id: string): Promise<void>;
  clearTerminal(): Promise<void>;
  dispose(): void;
}

export interface WorkbenchActivityNoticeReporter {
  report(input: WorkbenchActivityNoticeInput): void;
}

export function scopeWorkbenchActivityNoticeReporter(
  reporter: WorkbenchActivityNoticeReporter,
  isCurrent: () => boolean
): WorkbenchActivityNoticeReporter {
  return {
    report: (input) => {
      if (isCurrent()) reporter.report(input);
    }
  };
}

export function createWorkbenchActivities(actions: {
  dismiss(id: string): Promise<unknown>;
  clearTerminal(): Promise<unknown>;
}): WorkbenchActivities {
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let presentationBlocked = false;
  let snapshot: WorkbenchActivitiesSnapshot = {
    synchronized: false,
    activityRevision: 0,
    centerOpen: false,
    records: [],
    floatingRecordIds: []
  };

  const clearTimer = (id: string): void => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };
  const emit = (next: WorkbenchActivitiesSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const scheduleExpiry = (id: string): void => {
    clearTimer(id);
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      if (!snapshot.floatingRecordIds.includes(id)) return;
      emit({
        ...snapshot,
        floatingRecordIds: snapshot.floatingRecordIds.filter((recordId) => recordId !== id)
      });
    }, WORKBENCH_ACTIVITY_FLOAT_MS));
  };
  const clearFloating = (): void => {
    for (const id of snapshot.floatingRecordIds) clearTimer(id);
  };
  const acceptSnapshot = (frame: Extract<WorkbenchActivityFrame, { type: 'activity.snapshot' }>): void => {
    if (snapshot.synchronized) {
      throw new Error('Runtime sent more than one Activity snapshot.');
    }
    emit({
      synchronized: true,
      activityRevision: frame.activityRevision,
      centerOpen: snapshot.centerOpen,
      records: frame.records,
      floatingRecordIds: []
    });
  };
  const acceptEvent = (frame: Exclude<WorkbenchActivityFrame, { type: 'activity.snapshot' }>): void => {
    if (!snapshot.synchronized || frame.activityRevision !== snapshot.activityRevision + 1) {
      throw new Error('Runtime Activity revision is not contiguous.');
    }
    if (frame.type === 'activity.remove') {
      const removed = new Set(frame.activityIds);
      for (const id of removed) clearTimer(id);
      emit({
        ...snapshot,
        activityRevision: frame.activityRevision,
        records: snapshot.records.filter((record) => !removed.has(record.id)),
        floatingRecordIds: snapshot.floatingRecordIds.filter((id) => !removed.has(id))
      });
      return;
    }
    const previous = snapshot.records.find((record) => record.id === frame.record.id);
    const records = previous
      ? snapshot.records.map((record) => record.id === frame.record.id ? frame.record : record)
      : [...snapshot.records, frame.record];
    const terminalTransition = previous !== undefined
      && isActiveTask(previous)
      && isTerminalActivity(frame.record);
    const shouldFloat = !snapshot.centerOpen
      && !presentationBlocked
      && (previous === undefined || terminalTransition);
    const floatingRecordIds = shouldFloat
      ? [frame.record.id, ...snapshot.floatingRecordIds.filter((id) => id !== frame.record.id)]
        .slice(0, MAX_FLOATING_ACTIVITIES)
      : snapshot.floatingRecordIds;
    const dropped = snapshot.floatingRecordIds.filter((id) => !floatingRecordIds.includes(id));
    for (const id of dropped) clearTimer(id);
    emit({
      ...snapshot,
      activityRevision: frame.activityRevision,
      records,
      floatingRecordIds
    });
    if (shouldFloat) scheduleExpiry(frame.record.id);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptFrame: (frame) => {
      if (disposed) return;
      if (frame.type === 'activity.snapshot') acceptSnapshot(frame);
      else acceptEvent(frame);
    },
    openCenter: () => {
      if (snapshot.centerOpen) return;
      clearFloating();
      emit({ ...snapshot, centerOpen: true, floatingRecordIds: [] });
    },
    closeCenter: () => {
      if (!snapshot.centerOpen) return;
      emit({ ...snapshot, centerOpen: false });
    },
    hideFloating: () => {
      if (snapshot.floatingRecordIds.length === 0) return;
      clearFloating();
      emit({ ...snapshot, floatingRecordIds: [] });
    },
    setPresentationBlocked: (blocked) => {
      if (presentationBlocked === blocked) return;
      presentationBlocked = blocked;
      if (blocked && snapshot.floatingRecordIds.length > 0) {
        clearFloating();
        emit({ ...snapshot, floatingRecordIds: [] });
      }
    },
    dismiss: async (id) => {
      await actions.dismiss(id);
    },
    clearTerminal: async () => {
      await actions.clearTerminal();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    }
  };
}

export function isActiveTask(record: ActivityRecord): boolean {
  return record.type === 'task'
    && (record.status === 'running' || record.status === 'cancelling');
}

export function isTerminalActivity(record: ActivityRecord): boolean {
  return !isActiveTask(record);
}
