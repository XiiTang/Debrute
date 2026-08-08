import type {
  ActivityRecord,
  WorkbenchActivityFrame,
  WorkbenchActivityNoticeInput
} from '@debrute/app-protocol';

export const WORKBENCH_ACTIVITY_FLOAT_MS = 8_000;
export const WORKBENCH_ACTIVITY_MOTION_MS = 120;
const MAX_FLOATING_ACTIVITIES = 3;

export type WorkbenchActivityCenterPresentation = 'hidden' | 'open' | 'exiting';

export type WorkbenchActivityFloatingCard =
  | {
      readonly phase: 'present';
      readonly presentationId: number;
      readonly recordId: string;
      readonly startedAt: number;
      readonly expiresAt: number;
    }
  | {
      readonly phase: 'exiting';
      readonly presentationId: number;
      readonly record: ActivityRecord;
    };

export interface WorkbenchActivityExitingCenterCard {
  readonly exitId: number;
  readonly record: ActivityRecord;
}

export interface WorkbenchActivitiesSnapshot {
  readonly synchronized: boolean;
  readonly activityRevision: number;
  readonly centerPresentation: WorkbenchActivityCenterPresentation;
  readonly records: readonly ActivityRecord[];
  readonly floatingCards: readonly WorkbenchActivityFloatingCard[];
  readonly exitingCenterCards: readonly WorkbenchActivityExitingCenterCard[];
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
  const floatingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const floatingExitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const centerCardExitTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let presentationBlocked = false;
  let centerExitTimer: ReturnType<typeof setTimeout> | undefined;
  let nextPresentationId = 1;
  let nextCenterCardExitId = 1;
  let snapshot: WorkbenchActivitiesSnapshot = {
    synchronized: false,
    activityRevision: 0,
    centerPresentation: 'hidden',
    records: [],
    floatingCards: [],
    exitingCenterCards: []
  };

  const clearFloatingTimer = (presentationId: number): void => {
    const timer = floatingTimers.get(presentationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      floatingTimers.delete(presentationId);
    }
  };
  const clearFloatingExitTimer = (presentationId: number): void => {
    const timer = floatingExitTimers.get(presentationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      floatingExitTimers.delete(presentationId);
    }
  };
  const clearCenterCardExitTimer = (exitId: number): void => {
    const timer = centerCardExitTimers.get(exitId);
    if (timer !== undefined) {
      clearTimeout(timer);
      centerCardExitTimers.delete(exitId);
    }
  };
  const emit = (next: WorkbenchActivitiesSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const scheduleFloatingExpiry = (
    presentation: Extract<WorkbenchActivityFloatingCard, { phase: 'present' }>
  ): void => {
    clearFloatingTimer(presentation.presentationId);
    floatingTimers.set(presentation.presentationId, setTimeout(() => {
      floatingTimers.delete(presentation.presentationId);
      if (!snapshot.floatingCards.some((card) => (
        card.phase === 'present' && card.presentationId === presentation.presentationId
      ))) return;
      emit({
        ...snapshot,
        floatingCards: snapshot.floatingCards.filter((card) => (
          card.presentationId !== presentation.presentationId
        ))
      });
    }, Math.max(0, presentation.expiresAt - Date.now())));
  };
  const scheduleFloatingExit = (presentationId: number): void => {
    clearFloatingExitTimer(presentationId);
    floatingExitTimers.set(presentationId, setTimeout(() => {
      floatingExitTimers.delete(presentationId);
      if (!snapshot.floatingCards.some((card) => (
        card.phase === 'exiting' && card.presentationId === presentationId
      ))) return;
      emit({
        ...snapshot,
        floatingCards: snapshot.floatingCards.filter((card) => (
          card.presentationId !== presentationId
        ))
      });
    }, WORKBENCH_ACTIVITY_MOTION_MS));
  };
  const scheduleCenterCardExit = (exitId: number): void => {
    clearCenterCardExitTimer(exitId);
    centerCardExitTimers.set(exitId, setTimeout(() => {
      centerCardExitTimers.delete(exitId);
      if (!snapshot.exitingCenterCards.some((card) => card.exitId === exitId)) return;
      emit({
        ...snapshot,
        exitingCenterCards: snapshot.exitingCenterCards.filter((card) => (
          card.exitId !== exitId
        ))
      });
    }, WORKBENCH_ACTIVITY_MOTION_MS));
  };
  const clearFloatingCardsImmediately = (): void => {
    for (const card of snapshot.floatingCards) {
      clearFloatingTimer(card.presentationId);
      clearFloatingExitTimer(card.presentationId);
    }
  };
  const clearCenterCardExitsImmediately = (): void => {
    for (const card of snapshot.exitingCenterCards) {
      clearCenterCardExitTimer(card.exitId);
    }
  };
  const clearCenterExitTimer = (): void => {
    if (centerExitTimer === undefined) return;
    clearTimeout(centerExitTimer);
    centerExitTimer = undefined;
  };
  const dropFloatingCards = (
    cards: readonly WorkbenchActivityFloatingCard[],
    retained: readonly WorkbenchActivityFloatingCard[]
  ): void => {
    const retainedIds = new Set(retained.map((card) => card.presentationId));
    for (const card of cards) {
      if (retainedIds.has(card.presentationId)) continue;
      clearFloatingTimer(card.presentationId);
      clearFloatingExitTimer(card.presentationId);
    }
  };
  const floatingExitFor = (
    card: Extract<WorkbenchActivityFloatingCard, { phase: 'present' }>,
    records: readonly ActivityRecord[]
  ): Extract<WorkbenchActivityFloatingCard, { phase: 'exiting' }> | undefined => {
    const record = records.find((candidate) => candidate.id === card.recordId);
    if (!record) return undefined;
    clearFloatingTimer(card.presentationId);
    return {
      phase: 'exiting',
      presentationId: card.presentationId,
      record
    };
  };
  const acceptSnapshot = (frame: Extract<WorkbenchActivityFrame, { type: 'activity.snapshot' }>): void => {
    if (snapshot.synchronized) {
      throw new Error('Runtime sent more than one Activity snapshot.');
    }
    clearFloatingCardsImmediately();
    clearCenterCardExitsImmediately();
    emit({
      synchronized: true,
      activityRevision: frame.activityRevision,
      centerPresentation: snapshot.centerPresentation,
      records: frame.records,
      floatingCards: [],
      exitingCenterCards: []
    });
  };
  const acceptEvent = (frame: Exclude<WorkbenchActivityFrame, { type: 'activity.snapshot' }>): void => {
    if (!snapshot.synchronized || frame.activityRevision !== snapshot.activityRevision + 1) {
      throw new Error('Runtime Activity revision is not contiguous.');
    }
    if (frame.type === 'activity.remove') {
      const removed = new Set(frame.activityIds);
      const removedRecords = snapshot.records.filter((record) => removed.has(record.id));
      const floatingExitIds: number[] = [];
      const floatingCards = snapshot.floatingCards.flatMap((card) => {
        if (card.phase === 'exiting' || !removed.has(card.recordId)) return [card];
        const exiting = floatingExitFor(card, snapshot.records);
        if (!exiting) return [];
        floatingExitIds.push(exiting.presentationId);
        return [exiting];
      });
      const centerExits = snapshot.centerPresentation === 'open'
        ? removedRecords.map((record) => ({
            exitId: nextCenterCardExitId++,
            record
          }))
        : [];
      emit({
        ...snapshot,
        activityRevision: frame.activityRevision,
        records: snapshot.records.filter((record) => !removed.has(record.id)),
        floatingCards,
        exitingCenterCards: [...snapshot.exitingCenterCards, ...centerExits]
      });
      for (const presentationId of floatingExitIds) scheduleFloatingExit(presentationId);
      for (const card of centerExits) scheduleCenterCardExit(card.exitId);
      return;
    }
    const previous = snapshot.records.find((record) => record.id === frame.record.id);
    const records = previous
      ? snapshot.records.map((record) => record.id === frame.record.id ? frame.record : record)
      : [...snapshot.records, frame.record];
    const terminalTransition = previous !== undefined
      && isActiveTask(previous)
      && isTerminalActivity(frame.record);
    const shouldFloat = snapshot.centerPresentation !== 'open'
      && !presentationBlocked
      && (previous === undefined || terminalTransition);
    let floatingCards = snapshot.floatingCards;
    let presentation: Extract<WorkbenchActivityFloatingCard, { phase: 'present' }> | undefined;
    if (shouldFloat) {
      const startedAt = Date.now();
      presentation = {
        phase: 'present',
        presentationId: nextPresentationId++,
        recordId: frame.record.id,
        startedAt,
        expiresAt: startedAt + WORKBENCH_ACTIVITY_FLOAT_MS
      };
      floatingCards = [
        presentation,
        ...snapshot.floatingCards.filter((card) => (
          (card.phase === 'present' ? card.recordId : card.record.id) !== frame.record.id
        ))
      ].slice(0, MAX_FLOATING_ACTIVITIES);
      dropFloatingCards(snapshot.floatingCards, floatingCards);
    }
    emit({
      ...snapshot,
      activityRevision: frame.activityRevision,
      records,
      floatingCards
    });
    if (presentation) scheduleFloatingExpiry(presentation);
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
      if (snapshot.centerPresentation === 'open') return;
      clearCenterExitTimer();
      clearFloatingCardsImmediately();
      clearCenterCardExitsImmediately();
      emit({
        ...snapshot,
        centerPresentation: 'open',
        floatingCards: [],
        exitingCenterCards: []
      });
    },
    closeCenter: () => {
      if (snapshot.centerPresentation !== 'open') return;
      clearCenterExitTimer();
      emit({ ...snapshot, centerPresentation: 'exiting' });
      centerExitTimer = setTimeout(() => {
        centerExitTimer = undefined;
        if (snapshot.centerPresentation !== 'exiting') return;
        emit({ ...snapshot, centerPresentation: 'hidden' });
      }, WORKBENCH_ACTIVITY_MOTION_MS);
    },
    hideFloating: () => {
      const exitingIds: number[] = [];
      const floatingCards = snapshot.floatingCards.flatMap((card) => {
        if (card.phase === 'exiting') return [card];
        const exiting = floatingExitFor(card, snapshot.records);
        if (!exiting) return [];
        exitingIds.push(exiting.presentationId);
        return [exiting];
      });
      if (exitingIds.length === 0) return;
      emit({ ...snapshot, floatingCards });
      for (const presentationId of exitingIds) scheduleFloatingExit(presentationId);
    },
    setPresentationBlocked: (blocked) => {
      if (presentationBlocked === blocked) return;
      presentationBlocked = blocked;
      if (blocked && snapshot.floatingCards.length > 0) {
        clearFloatingCardsImmediately();
        emit({ ...snapshot, floatingCards: [] });
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
      clearCenterExitTimer();
      for (const timer of floatingTimers.values()) clearTimeout(timer);
      for (const timer of floatingExitTimers.values()) clearTimeout(timer);
      for (const timer of centerCardExitTimers.values()) clearTimeout(timer);
      floatingTimers.clear();
      floatingExitTimers.clear();
      centerCardExitTimers.clear();
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
