import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  WorkbenchApiClient,
  WorkbenchEvent,
  WorkbenchFeedbackWorkingCopy
} from '@debrute/app-protocol';
import {
  CANVAS_FEEDBACK_MARKS,
  CanvasFeedbackDocument,
  CanvasFeedbackGeometry,
  CanvasFeedbackItem,
  CanvasFeedbackMark,
  UpdateCanvasFeedbackInput
} from '@debrute/app-protocol';
import {
  sameCanvasFeedbackBarTarget,
  feedbackBarPlacementForCanvasTarget,
  type FloatingBarRect,
  type CanvasFeedbackBarTarget,
  type CanvasFeedbackNodeBarTarget,
  type CanvasLocalFeedbackDraft
} from '../shell/floatingBars';
import type { CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import type { CanvasFeedbackComposition } from './canvasFeedbackComposition';
import { CanvasFeedbackBar, CanvasFeedbackSelectionBar } from './CanvasFeedbackBar.js';

const FEEDBACK_BAR_DISMISS_DELAY_MS = 120;
const EMPTY_FLOATING_BAR_RECTS: readonly FloatingBarRect[] = [];

type CanvasFeedbackApi = Pick<WorkbenchApiClient,
  | 'putFeedbackWorkingCopy'
  | 'clearFeedbackWorkingCopy'
  | 'updateCanvasFeedback'
  | 'readCanvasFeedback'
>;

export interface CanvasFeedbackCapsule {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'node' | 'moment';
  momentTimeSeconds?: number | undefined;
  momentLabel?: string | undefined;
  geometry?: CanvasFeedbackGeometry | undefined;
  label?: number | undefined;
  comment: string;
  isNew: boolean;
  unsynchronized: boolean;
}

export interface CanvasFeedbackInteraction {
  feedback: CanvasFeedbackDocument | undefined;
  targetStore: CanvasFeedbackTargetStore;
  localMode: CanvasMediaFeedbackMode | undefined;
  composition: CanvasFeedbackComposition | undefined;
  authoringItemId: string | undefined;
  focusedCapsuleId: string | undefined;
  marksMutationPending: boolean;
  capsulesForPath(projectRelativePath: string): CanvasFeedbackCapsule[];
  marksForPaths(projectRelativePaths: readonly string[]): CanvasFeedbackMark[];
  createNodeCapsule(projectRelativePath: string): string;
  changeCapsule(itemId: string, value: string): void;
  focusCapsule(itemId: string): void;
  activateCapsule(target: CanvasFeedbackNodeBarTarget, itemId: string): void;
  blurCapsule(itemId: string): Promise<void>;
  deleteCapsule(itemId: string): Promise<void>;
  setMark(projectRelativePaths: readonly string[], mark: CanvasFeedbackMark, selected: boolean): Promise<void>;
  handleTargetChange(target: CanvasFeedbackBarTarget | undefined): void;
  invalidateTarget(projectRelativePath: string): void;
  handlePointerEnter(): void;
  handlePointerLeave(): void;
  handleModeChange(mode: CanvasMediaFeedbackMode): void;
  handleDraft(draft: CanvasLocalFeedbackDraft): void;
  restoreWorkingCopies(workingCopies: Record<string, WorkbenchFeedbackWorkingCopy> | undefined): void;
  load(): Promise<void>;
  applyEvent(event: WorkbenchEvent): void;
  canvas: CanvasFeedbackCanvasBinding;
}

export interface CanvasFeedbackTargetStore {
  getSnapshot(): CanvasFeedbackBarTarget | undefined;
  subscribe(listener: () => void): () => void;
  publish(target: CanvasFeedbackBarTarget | undefined): void;
}

function createCanvasFeedbackTargetStore(): CanvasFeedbackTargetStore {
  let target: CanvasFeedbackBarTarget | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => target,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next) {
      if (sameCanvasFeedbackTargetSnapshot(target, next)) {
        return;
      }
      target = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

function sameCanvasFeedbackTargetSnapshot(
  left: CanvasFeedbackBarTarget | undefined,
  right: CanvasFeedbackBarTarget | undefined
): boolean {
  return sameCanvasFeedbackBarTarget(left, right)
    && (left?.kind !== 'node' || right?.kind !== 'node' || (
      left.startVideoMomentFeedback === right.startVideoMomentFeedback
      && left.seekToMoment === right.seekToMoment
    ));
}

export interface CanvasFeedbackCanvasBinding {
  localMode: CanvasMediaFeedbackMode | undefined;
  composition: CanvasFeedbackComposition | undefined;
  localSpatialItems: readonly CanvasFeedbackComposition[];
  suppressedSpatialItemIds: ReadonlySet<string>;
  focusedCapsuleId: string | undefined;
  getCurrentTargetProjectRelativePath(): string | undefined;
  suspendHoverTarget(): void;
  dismissTarget(): void;
  handleTargetChange(target: CanvasFeedbackBarTarget | undefined): void;
  invalidateTarget(projectRelativePath: string): void;
  handleDraft(draft: CanvasLocalFeedbackDraft): void;
  activateCapsule(target: CanvasFeedbackNodeBarTarget, itemId: string): void;
}

export function useCanvasFeedbackInteraction(input: {
  api: CanvasFeedbackApi;
  bindingId: string | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  notifyUnavailable(message: string): void;
  notifySaveFailed(message: string): void;
}): CanvasFeedbackInteraction {
  const [feedback, setFeedback] = useState<CanvasFeedbackDocument | undefined>(undefined);
  const feedbackRef = useRef<CanvasFeedbackDocument | undefined>(undefined);
  const [localValues, setLocalValues] = useState<Record<string, WorkbenchFeedbackWorkingCopy>>({});
  const localValuesRef = useRef<Record<string, WorkbenchFeedbackWorkingCopy>>({});
  const versionsRef = useRef(new Map<string, number>());
  const deletingItemKeysRef = useRef(new Set<string>());
  const marksMutationPendingRef = useRef(false);
  const [marksMutationPending, setMarksMutationPending] = useState(false);
  const targetStoreRef = useRef<CanvasFeedbackTargetStore | undefined>(undefined);
  targetStoreRef.current ??= createCanvasFeedbackTargetStore();
  const targetStore = targetStoreRef.current;
  const [localMode, setLocalMode] = useState<CanvasMediaFeedbackMode>(undefined);
  const [composition, setComposition] = useState<CanvasFeedbackComposition | undefined>(undefined);
  const compositionRef = useRef<CanvasFeedbackComposition | undefined>(undefined);
  const [authoringItemId, setAuthoringItemId] = useState<string | undefined>(undefined);
  const authoringItemIdRef = useRef<string | undefined>(undefined);
  const [focusedCapsuleId, setFocusedCapsuleId] = useState<string | undefined>(undefined);
  const focusedCapsuleIdRef = useRef<string | undefined>(undefined);
  const focusDeferredTargetRef = useRef<CanvasFeedbackBarTarget | null | undefined>(undefined);
  const targetClearTimerRef = useRef<number | undefined>(undefined);
  const targetEpochRef = useRef(0);
  const hoveredRef = useRef(false);
  const loadEpochRef = useRef(0);
  const feedbackAcceptanceEpochRef = useRef(0);
  const bindingIdRef = useRef(input.bindingId);
  const workingCopyCoordinatorsRef = useRef(new Map<string, {
    desired: WorkbenchFeedbackWorkingCopy | null | undefined;
    running: Promise<boolean>;
  }>());
  bindingIdRef.current = input.bindingId;
  feedbackRef.current = feedback;
  localValuesRef.current = localValues;
  focusedCapsuleIdRef.current = focusedCapsuleId;

  const clearComposition = useCallback((itemId: string) => {
    if (compositionRef.current?.itemId !== itemId) {
      return;
    }
    compositionRef.current = undefined;
    setComposition((current) => current?.itemId === itemId ? undefined : current);
    setLocalMode(undefined);
  }, []);

  const releaseAuthoringItem = useCallback((itemId: string) => {
    if (authoringItemIdRef.current !== itemId) {
      return;
    }
    authoringItemIdRef.current = undefined;
    setAuthoringItemId((current) => current === itemId ? undefined : current);
  }, []);

  const setLocalValue = useCallback((itemId: string, value: WorkbenchFeedbackWorkingCopy | undefined) => {
    setLocalValues((current) => {
      if (value) {
        if (current[itemId] === value) {
          return current;
        }
        return { ...current, [itemId]: value };
      }
      if (!(itemId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }, []);

  const persistWorkingCopy = useCallback((itemId: string, workingCopy: WorkbenchFeedbackWorkingCopy | null) => {
    const bindingId = bindingIdRef.current;
    if (!bindingId) {
      return Promise.resolve(false);
    }
    const key = `${bindingId}\u0000${itemId}`;
    const active = workingCopyCoordinatorsRef.current.get(key);
    if (active) {
      active.desired = workingCopy;
      return active.running;
    }
    const coordinator = {
      desired: workingCopy as WorkbenchFeedbackWorkingCopy | null | undefined,
      running: Promise.resolve(true)
    };
    workingCopyCoordinatorsRef.current.set(key, coordinator);
    coordinator.running = (async () => {
      let succeeded = true;
      while (coordinator.desired !== undefined) {
        const desired = coordinator.desired;
        coordinator.desired = undefined;
        try {
          if (desired) {
            await input.api.putFeedbackWorkingCopy(bindingId, desired);
          } else {
            await input.api.clearFeedbackWorkingCopy(bindingId, itemId);
          }
        } catch {
          succeeded = false;
        }
      }
      workingCopyCoordinatorsRef.current.delete(key);
      return succeeded;
    })();
    return coordinator.running;
  }, [input.api]);

  const acceptFeedback = useCallback((next: CanvasFeedbackDocument) => {
    feedbackAcceptanceEpochRef.current += 1;
    feedbackRef.current = next;
    setFeedback(next);
  }, []);

  const updateFeedback = useCallback(async (updateInput: UpdateCanvasFeedbackInput) => {
    try {
      await input.api.updateCanvasFeedback(updateInput);
      return true;
    } catch {
      return false;
    }
  }, [input.api]);

  const deleteAcceptedItem = useCallback(async (itemId: string, projectRelativePath: string) => {
    const bindingId = bindingIdRef.current;
    if (!bindingId) {
      return false;
    }
    const key = `${bindingId}\u0000${itemId}`;
    if (deletingItemKeysRef.current.has(key)) {
      return false;
    }
    deletingItemKeysRef.current.add(key);
    try {
      return await updateFeedback({
        operation: 'delete-item',
        projectRelativePath,
        itemId
      });
    } finally {
      deletingItemKeysRef.current.delete(key);
    }
  }, [updateFeedback]);

  const setMark = useCallback(async (
    projectRelativePaths: readonly string[],
    mark: CanvasFeedbackMark,
    selected: boolean
  ) => {
    const bindingId = bindingIdRef.current;
    if (!bindingId || marksMutationPendingRef.current) {
      return;
    }
    const frozenPaths = [...projectRelativePaths];
    marksMutationPendingRef.current = true;
    setMarksMutationPending(true);
    try {
      await input.api.updateCanvasFeedback({
        operation: 'set-mark',
        projectRelativePaths: frozenPaths,
        mark,
        selected
      });
    } catch (error) {
      input.notifySaveFailed(errorMessage(error));
    } finally {
      marksMutationPendingRef.current = false;
      setMarksMutationPending(false);
    }
  }, [input.api, input.notifySaveFailed]);

  const marksForPaths = useCallback((projectRelativePaths: readonly string[]): CanvasFeedbackMark[] => {
    if (projectRelativePaths.length === 0) {
      return [];
    }
    return CANVAS_FEEDBACK_MARKS.filter((mark) => projectRelativePaths.every((path) => (
      feedbackRef.current?.entries[path]?.marks.includes(mark) ?? false
    )));
  }, []);

  const capsulesForPath = useCallback((projectRelativePath: string): CanvasFeedbackCapsule[] => {
    const entry = feedbackRef.current?.entries[projectRelativePath];
    const acceptedIds = new Set(entry?.items.map((item) => item.id) ?? []);
    const accepted = (entry?.items ?? []).map((item) => capsuleFromItem(
      projectRelativePath,
      item,
      localValuesRef.current[item.id]
    ));
    const localOnly = Object.values(localValuesRef.current)
      .filter((value) => value.projectRelativePath === projectRelativePath && !acceptedIds.has(value.itemId))
      .sort((left, right) => left.itemId.localeCompare(right.itemId))
      .map(capsuleFromWorkingCopy);
    return [...accepted, ...localOnly].sort(compareCapsuleCreationOrder);
  }, []);

  const descriptorForItem = useCallback((itemId: string): WorkbenchFeedbackWorkingCopy | undefined => {
    const local = localValuesRef.current[itemId];
    if (local) {
      return local;
    }
    for (const entry of Object.values(feedbackRef.current?.entries ?? {})) {
      const item = entry.items.find((candidate) => candidate.id === itemId);
      if (item) {
        return workingCopyFromItem(entry.projectRelativePath, item);
      }
    }
    return undefined;
  }, []);

  const changeCapsule = useCallback((itemId: string, value: string) => {
    const descriptor = descriptorForItem(itemId);
    if (!descriptor) {
      return;
    }
    const next = { ...descriptor, comment: value };
    versionsRef.current.set(itemId, (versionsRef.current.get(itemId) ?? 0) + 1);
    localValuesRef.current = { ...localValuesRef.current, [itemId]: next };
    setLocalValue(itemId, next);
    const accepted = findAcceptedItem(feedbackRef.current, itemId);
    if (value !== '' || accepted) {
      void persistWorkingCopy(itemId, next);
    }
  }, [descriptorForItem, persistWorkingCopy, setLocalValue]);

  const focusCapsule = useCallback((itemId: string) => {
    focusDeferredTargetRef.current = undefined;
    focusedCapsuleIdRef.current = itemId;
    setFocusedCapsuleId(itemId);
    const capsule = descriptorForItem(itemId);
    const target = targetStore.getSnapshot();
    if (target?.kind === 'node'
      && capsule?.scope === 'moment'
      && capsule.momentTimeSeconds !== undefined) {
      target?.seekToMoment?.(capsule.momentTimeSeconds);
    }
  }, [descriptorForItem, targetStore]);

  const blurCapsule = useCallback(async (itemId: string) => {
    releaseAuthoringItem(itemId);
    if (focusedCapsuleIdRef.current === itemId) {
      const deferredTarget = focusDeferredTargetRef.current;
      focusDeferredTargetRef.current = undefined;
      focusedCapsuleIdRef.current = undefined;
      setFocusedCapsuleId(undefined);
      if (deferredTarget) {
        targetEpochRef.current += 1;
        targetStore.publish(deferredTarget);
      } else if (deferredTarget === null && !hoveredRef.current) {
        targetEpochRef.current += 1;
        input.overlayRuntime.clearFeedbackBarPlacement();
        targetStore.publish(undefined);
      } else if (!hoveredRef.current && targetClearTimerRef.current === undefined) {
        const targetEpoch = targetEpochRef.current;
        window.setTimeout(() => {
          if (
            targetEpochRef.current === targetEpoch
            && !hoveredRef.current
            && !focusedCapsuleIdRef.current
          ) {
            input.overlayRuntime.clearFeedbackBarPlacement();
            targetStore.publish(undefined);
          }
        }, 0);
      }
    }
    const workingCopy = localValuesRef.current[itemId];
    if (!workingCopy) {
      return;
    }
    const version = versionsRef.current.get(itemId) ?? 0;
    const accepted = findAcceptedItem(feedbackRef.current, itemId);
    const comment = workingCopy.comment;
    const hasComment = comment.trim().length > 0;
    if (!accepted && !hasComment) {
      versionsRef.current.delete(itemId);
      const next = { ...localValuesRef.current };
      delete next[itemId];
      localValuesRef.current = next;
      setLocalValue(itemId, undefined);
      clearComposition(itemId);
      if (version > 0) {
        await persistWorkingCopy(itemId, null);
      }
      return;
    }
    if (accepted && !hasComment) {
      if (!await deleteAcceptedItem(itemId, workingCopy.projectRelativePath)) {
        return;
      }
      if (versionsRef.current.get(itemId) !== version) {
        return;
      }
      if (!await persistWorkingCopy(itemId, null)) {
        return;
      }
      if (versionsRef.current.get(itemId) !== version) {
        return;
      }
      versionsRef.current.delete(itemId);
      const next = { ...localValuesRef.current };
      delete next[itemId];
      localValuesRef.current = next;
      setLocalValue(itemId, undefined);
      clearComposition(itemId);
      return;
    }
    if (!await persistWorkingCopy(itemId, workingCopy)) {
      return;
    }
    const saved = await updateFeedback(accepted
      ? {
          operation: 'update-item',
          projectRelativePath: workingCopy.projectRelativePath,
          itemId,
          comment
        }
      : {
          operation: 'add-item',
          projectRelativePath: workingCopy.projectRelativePath,
          item: addItemFromWorkingCopy(workingCopy, comment)
        });
    if (!saved || versionsRef.current.get(itemId) !== version) {
      return;
    }
    if (!await persistWorkingCopy(itemId, null)) {
      return;
    }
    if (versionsRef.current.get(itemId) !== version) {
      return;
    }
    versionsRef.current.delete(itemId);
    const next = { ...localValuesRef.current };
    delete next[itemId];
    localValuesRef.current = next;
    setLocalValue(itemId, undefined);
    clearComposition(itemId);
  }, [clearComposition, deleteAcceptedItem, input.overlayRuntime, persistWorkingCopy, releaseAuthoringItem, setLocalValue, targetStore, updateFeedback]);

  const deleteCapsule = useCallback(async (itemId: string) => {
    const descriptor = descriptorForItem(itemId);
    if (!descriptor) {
      return;
    }
    const accepted = findAcceptedItem(feedbackRef.current, itemId);
    if (accepted) {
      const version = versionsRef.current.get(itemId) ?? 0;
      const hasWorkingCopy = itemId in localValuesRef.current;
      if (!await deleteAcceptedItem(itemId, descriptor.projectRelativePath)) {
        return;
      }
      if (versionsRef.current.get(itemId) !== version) {
        return;
      }
      if (hasWorkingCopy && !await persistWorkingCopy(itemId, null)) {
        return;
      }
      if (versionsRef.current.get(itemId) !== version) {
        return;
      }
    }
    if (focusedCapsuleIdRef.current === itemId) {
      focusedCapsuleIdRef.current = undefined;
      setFocusedCapsuleId(undefined);
    }
    versionsRef.current.delete(itemId);
    const next = { ...localValuesRef.current };
    delete next[itemId];
    localValuesRef.current = next;
    setLocalValue(itemId, undefined);
    releaseAuthoringItem(itemId);
    clearComposition(itemId);
    if (!accepted) {
      await persistWorkingCopy(itemId, null);
    }
  }, [clearComposition, deleteAcceptedItem, descriptorForItem, persistWorkingCopy, releaseAuthoringItem, setLocalValue]);

  const createNodeCapsule = useCallback((projectRelativePath: string) => {
    if (
      compositionRef.current
      && (compositionRef.current.kind === 'pin' || compositionRef.current.kind === 'region')
      && !compositionRef.current.geometry
    ) {
      compositionRef.current = undefined;
      setComposition(undefined);
      setLocalMode(undefined);
    }
    const itemId = createFeedbackItemId();
    const workingCopy: WorkbenchFeedbackWorkingCopy = {
      itemId,
      createdAt: new Date().toISOString(),
      projectRelativePath,
      kind: 'comment',
      scope: 'node',
      comment: ''
    };
    localValuesRef.current = { ...localValuesRef.current, [itemId]: workingCopy };
    setLocalValue(itemId, workingCopy);
    authoringItemIdRef.current = itemId;
    setAuthoringItemId(itemId);
    focusDeferredTargetRef.current = undefined;
    focusedCapsuleIdRef.current = itemId;
    setFocusedCapsuleId(itemId);
    return itemId;
  }, [setLocalValue]);

  const clearTargetTimer = useCallback(() => {
    if (targetClearTimerRef.current !== undefined) {
      window.clearTimeout(targetClearTimerRef.current);
      targetClearTimerRef.current = undefined;
    }
  }, []);

  const activateCapsule = useCallback((nextTarget: CanvasFeedbackNodeBarTarget, itemId: string) => {
    clearTargetTimer();
    targetEpochRef.current += 1;
    targetStore.publish(nextTarget);
    focusDeferredTargetRef.current = undefined;
    focusedCapsuleIdRef.current = itemId;
    setFocusedCapsuleId(itemId);
    const capsule = descriptorForItem(itemId);
    if (capsule?.scope === 'moment' && capsule.momentTimeSeconds !== undefined) {
      nextTarget.seekToMoment?.(capsule.momentTimeSeconds);
    }
  }, [clearTargetTimer, descriptorForItem, targetStore]);

  const clearTarget = useCallback(() => {
    if (focusedCapsuleIdRef.current) {
      return;
    }
    input.overlayRuntime.clearFeedbackBarPlacement();
    targetStore.publish(undefined);
  }, [input.overlayRuntime, targetStore]);

  const scheduleTargetClear = useCallback(() => {
    clearTargetTimer();
    targetClearTimerRef.current = window.setTimeout(() => {
      targetClearTimerRef.current = undefined;
      if (!hoveredRef.current) {
        clearTarget();
      }
    }, FEEDBACK_BAR_DISMISS_DELAY_MS);
  }, [clearTarget, clearTargetTimer]);

  const getCurrentTargetProjectRelativePath = useCallback(() => {
    const target = targetStore.getSnapshot();
    return target?.kind === 'node' ? target.projectRelativePath : undefined;
  }, [targetStore]);

  const suspendHoverTarget = useCallback(() => {
    clearTargetTimer();
    if (focusedCapsuleIdRef.current || targetStore.getSnapshot()?.kind !== 'node') {
      return;
    }
    input.overlayRuntime.suspendFeedbackBarPlacement();
  }, [clearTargetTimer, input.overlayRuntime, targetStore]);

  const dismissTarget = useCallback(() => {
    clearTargetTimer();
    targetEpochRef.current += 1;
    focusDeferredTargetRef.current = undefined;
    hoveredRef.current = false;
    focusedCapsuleIdRef.current = undefined;
    setFocusedCapsuleId(undefined);
    input.overlayRuntime.clearFeedbackBarPlacement();
    targetStore.publish(undefined);
  }, [clearTargetTimer, input.overlayRuntime, targetStore]);

  const handleTargetChange = useCallback((nextTarget: CanvasFeedbackBarTarget | undefined) => {
    clearTargetTimer();
    const currentTarget = targetStore.getSnapshot();
    if (!nextTarget && !currentTarget) {
      return;
    }
    if (nextTarget?.kind === 'selection') {
      input.overlayRuntime.resumeFeedbackBarPlacement();
    } else if (nextTarget?.kind === 'node') {
      if (
        currentTarget?.kind === 'node'
        && currentTarget.projectRelativePath === nextTarget.projectRelativePath
      ) {
        input.overlayRuntime.resumeFeedbackBarPlacement();
      } else {
        input.overlayRuntime.resumeFeedbackBarPlacementAfterNextUpdate();
      }
    }
    if (nextTarget?.kind === 'selection') {
      focusDeferredTargetRef.current = undefined;
      targetEpochRef.current += 1;
      targetStore.publish(nextTarget);
      return;
    }
    if (currentTarget?.kind === 'selection') {
      focusDeferredTargetRef.current = undefined;
      targetEpochRef.current += 1;
      if (nextTarget) {
        targetStore.publish(nextTarget);
      } else {
        input.overlayRuntime.clearFeedbackBarPlacement();
        targetStore.publish(undefined);
      }
      return;
    }
    if (focusedCapsuleIdRef.current) {
      focusDeferredTargetRef.current = nextTarget ?? null;
      return;
    }
    focusDeferredTargetRef.current = undefined;
    targetEpochRef.current += 1;
    if (nextTarget) {
      targetStore.publish(nextTarget);
      return;
    }
    scheduleTargetClear();
  }, [clearTargetTimer, input.overlayRuntime, scheduleTargetClear, targetStore]);

  const invalidateTarget = useCallback((projectRelativePath: string) => {
    const target = targetStore.getSnapshot();
    if (target?.kind !== 'node' || target.projectRelativePath !== projectRelativePath) {
      return;
    }
    dismissTarget();
  }, [dismissTarget, targetStore]);

  const handlePointerEnter = useCallback(() => {
    hoveredRef.current = true;
    clearTargetTimer();
  }, [clearTargetTimer]);

  const handlePointerLeave = useCallback(() => {
    hoveredRef.current = false;
    if (targetStore.getSnapshot()?.kind === 'selection') {
      return;
    }
    scheduleTargetClear();
  }, [scheduleTargetClear, targetStore]);

  const handleModeChange = useCallback((mode: CanvasMediaFeedbackMode) => {
    if (!mode) {
      if (compositionRef.current && !compositionRef.current.geometry) {
        compositionRef.current = undefined;
        setComposition(undefined);
      }
      setLocalMode(undefined);
      return;
    }
    const target = targetStore.getSnapshot();
    if (target?.kind !== 'node') {
      return;
    }
    const itemId = createFeedbackItemId();
    const nextComposition: CanvasFeedbackComposition = {
      itemId,
      createdAt: new Date().toISOString(),
      projectRelativePath: target.projectRelativePath,
      kind: mode === 'pin' ? 'pin' : 'region',
      scope: 'node'
    };
    compositionRef.current = nextComposition;
    setComposition(nextComposition);
    setLocalMode(mode);
  }, [targetStore]);

  const handleDraft = useCallback((draft: CanvasLocalFeedbackDraft) => {
    clearTargetTimer();
    targetEpochRef.current += 1;
    targetStore.publish(draft.feedbackBarTarget);
    const currentComposition = compositionRef.current;
    const reuseCurrent = currentComposition
      && currentComposition.geometry === undefined
      && draft.geometry !== undefined
      && currentComposition.projectRelativePath === draft.projectRelativePath
      && currentComposition.kind === draft.kind
      && currentComposition.scope === draft.scope
      && currentComposition.momentTimeSeconds === draft.momentTimeSeconds;
    const itemId = reuseCurrent ? currentComposition.itemId : createFeedbackItemId();
    const createdAt = reuseCurrent
      ? currentComposition.createdAt
      : new Date().toISOString();
    const nextComposition: CanvasFeedbackComposition = {
      itemId,
      createdAt,
      projectRelativePath: draft.projectRelativePath,
      kind: draft.kind,
      scope: draft.scope,
      ...(draft.momentTimeSeconds === undefined ? {} : { momentTimeSeconds: draft.momentTimeSeconds }),
      ...(draft.geometry ? { geometry: draft.geometry } : {})
    };
    compositionRef.current = nextComposition;
    setComposition(nextComposition);
    if ((draft.kind === 'pin' || draft.kind === 'region') && !draft.geometry) {
      setLocalMode(draft.kind === 'pin' ? 'pin' : 'rect');
      return;
    }
    const workingCopy = workingCopyFromComposition(
      nextComposition,
      reuseCurrent ? localValuesRef.current[itemId]?.comment ?? '' : ''
    );
    localValuesRef.current = { ...localValuesRef.current, [itemId]: workingCopy };
    setLocalValue(itemId, workingCopy);
    authoringItemIdRef.current = itemId;
    setAuthoringItemId(itemId);
    focusDeferredTargetRef.current = undefined;
    focusedCapsuleIdRef.current = itemId;
    setFocusedCapsuleId(itemId);
    setLocalMode(undefined);
  }, [clearTargetTimer, setLocalValue, targetStore]);

  const restoreWorkingCopies = useCallback((workingCopies: Record<string, WorkbenchFeedbackWorkingCopy> | undefined) => {
    const next = workingCopies ?? {};
    localValuesRef.current = next;
    setLocalValues(next);
    versionsRef.current.clear();
    for (const itemId of Object.keys(next)) {
      versionsRef.current.set(itemId, 1);
    }
  }, []);

  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    const acceptanceEpoch = feedbackAcceptanceEpochRef.current;
    try {
      const loaded = await input.api.readCanvasFeedback();
      if (
        loadEpochRef.current === epoch
        && feedbackAcceptanceEpochRef.current === acceptanceEpoch
      ) {
        acceptFeedback(loaded);
      }
    } catch (error) {
      if (loadEpochRef.current === epoch) {
        input.notifyUnavailable(errorMessage(error));
      }
    }
  }, [acceptFeedback, input.api, input.notifyUnavailable]);

  const applyEvent = useCallback((event: WorkbenchEvent) => {
    if (event.type === 'canvas.feedback.changed') {
      acceptFeedback(event.feedback);
    }
  }, [acceptFeedback]);

  useEffect(() => () => {
    loadEpochRef.current += 1;
    clearTargetTimer();
  }, [clearTargetTimer]);

  const localSpatialItems = useMemo(() => Object.values(localValues)
    .filter((value): value is WorkbenchFeedbackWorkingCopy & { geometry: CanvasFeedbackGeometry } => (
      (value.kind === 'pin' || value.kind === 'region')
      && value.geometry !== undefined
      && !findAcceptedItem(feedback, value.itemId)
      && (value.comment.trim().length > 0 || composition?.itemId === value.itemId)
    ))
    .map((value) => ({
      itemId: value.itemId,
      createdAt: value.createdAt,
      projectRelativePath: value.projectRelativePath,
      kind: value.kind,
      scope: value.scope,
      ...(value.momentTimeSeconds === undefined ? {} : { momentTimeSeconds: value.momentTimeSeconds }),
      geometry: value.geometry
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.itemId.localeCompare(right.itemId)), [composition, feedback, localValues]);

  const suppressedSpatialItemIds = useMemo(() => new Set(Object.values(localValues)
    .filter((value) => value.comment.trim().length === 0)
    .map((value) => findAcceptedItem(feedback, value.itemId))
    .filter((item): item is CanvasFeedbackItem => item?.kind === 'pin' || item?.kind === 'region')
    .map((item) => item.id)), [feedback, localValues]);

  const canvas = useMemo<CanvasFeedbackCanvasBinding>(() => ({
    localMode,
    composition,
    localSpatialItems,
    suppressedSpatialItemIds,
    focusedCapsuleId,
    getCurrentTargetProjectRelativePath,
    suspendHoverTarget,
    dismissTarget,
    handleTargetChange,
    invalidateTarget,
    handleDraft,
    activateCapsule
  }), [
    activateCapsule,
    focusedCapsuleId,
    getCurrentTargetProjectRelativePath,
    handleDraft,
    handleTargetChange,
    invalidateTarget,
    localMode,
    localSpatialItems,
    suspendHoverTarget,
    dismissTarget,
    composition,
    suppressedSpatialItemIds
  ]);

  return useMemo(() => ({
    feedback,
    targetStore,
    localMode,
    composition,
    authoringItemId,
    focusedCapsuleId,
    marksMutationPending,
    capsulesForPath,
    marksForPaths,
    createNodeCapsule,
    changeCapsule,
    focusCapsule,
    activateCapsule,
    blurCapsule,
    deleteCapsule,
    setMark,
    handleTargetChange,
    invalidateTarget,
    handlePointerEnter,
    handlePointerLeave,
    handleModeChange,
    handleDraft,
    restoreWorkingCopies,
    load,
    applyEvent,
    canvas
  }), [
    applyEvent,
    activateCapsule,
    blurCapsule,
    capsulesForPath,
    canvas,
    changeCapsule,
    createNodeCapsule,
    deleteCapsule,
    feedback,
    focusCapsule,
    focusedCapsuleId,
    handleDraft,
    handleModeChange,
    handlePointerEnter,
    handlePointerLeave,
    handleTargetChange,
    invalidateTarget,
    load,
    localMode,
    marksForPaths,
    marksMutationPending,
    authoringItemId,
    composition,
    restoreWorkingCopies,
    setMark,
    targetStore
  ]);
}

export function CanvasFeedbackInteractionBar({
  interaction,
  overlayRuntime,
  canvasRuntime,
  viewportRect,
  reservedRects = EMPTY_FLOATING_BAR_RECTS
}: {
  interaction: CanvasFeedbackInteraction;
  overlayRuntime: CanvasOverlayRuntime;
  canvasRuntime?: CanvasEditorRuntime | undefined;
  viewportRect?: FloatingBarRect | undefined;
  reservedRects?: readonly FloatingBarRect[] | undefined;
}): React.ReactElement | null {
  const target = useSyncExternalStore(
    interaction.targetStore.subscribe,
    interaction.targetStore.getSnapshot,
    interaction.targetStore.getSnapshot
  );
  useEffect(() => {
    if (!canvasRuntime || !target || !viewportRect) {
      return;
    }
    const syncPlacement = (camera: ReturnType<typeof canvasRuntime.camera.getCamera>) => {
      const placement = feedbackBarPlacementForCanvasTarget({
        target,
        camera,
        viewportRect,
        reservedRects
      });
      if (placement) {
        overlayRuntime.setFeedbackBarPlacement(placement);
      } else {
        overlayRuntime.clearFeedbackBarPlacement();
      }
    };
    syncPlacement(canvasRuntime.camera.getCamera());
    return canvasRuntime.subscribeCamera(syncPlacement);
  }, [canvasRuntime, overlayRuntime, reservedRects, target, viewportRect]);
  if (!target) {
    return null;
  }
  if (target.kind === 'selection') {
    const marks = interaction.marksForPaths(target.projectRelativePaths);
    return (
      <CanvasFeedbackSelectionBar
        marks={marks}
        marksMutationPending={interaction.marksMutationPending}
        onSetMark={(mark, selected) => {
          void interaction.setMark(target.projectRelativePaths, mark, selected);
        }}
        overlayRuntime={overlayRuntime}
      />
    );
  }
  const marks = interaction.marksForPaths([target.projectRelativePath]);
  return (
    <CanvasFeedbackBar
      projectRelativePath={target.projectRelativePath}
      capsules={interaction.capsulesForPath(target.projectRelativePath)}
      focusedCapsuleId={interaction.focusedCapsuleId}
      authoringItemId={interaction.authoringItemId}
      marks={marks}
      marksMutationPending={interaction.marksMutationPending}
      onSetMark={(mark, selected) => {
        void interaction.setMark([target.projectRelativePath], mark, selected);
      }}
      overlayRuntime={overlayRuntime}
      localToolset={target.localToolset}
      localFeedbackMode={target.localToolset === 'none' ? undefined : interaction.localMode}
      onLocalFeedbackModeChange={target.localToolset === 'image' ? interaction.handleModeChange : undefined}
      canStartVideoMomentFeedback={target.canStartVideoMomentFeedback}
      onStartVideoMomentFeedback={target.startVideoMomentFeedback}
      onCreateNodeCapsule={() => interaction.createNodeCapsule(target.projectRelativePath)}
      onCapsuleChange={interaction.changeCapsule}
      onCapsuleFocus={interaction.focusCapsule}
      onCapsuleBlur={interaction.blurCapsule}
      onCapsuleDelete={interaction.deleteCapsule}
      onPointerEnter={interaction.handlePointerEnter}
      onPointerLeave={interaction.handlePointerLeave}
    />
  );
}

function capsuleFromItem(
  projectRelativePath: string,
  item: CanvasFeedbackItem,
  local: WorkbenchFeedbackWorkingCopy | undefined
): CanvasFeedbackCapsule {
  return {
    itemId: item.id,
    createdAt: item.createdAt,
    projectRelativePath,
    kind: item.kind,
    scope: item.scope,
    ...(item.scope === 'moment' ? {
      momentTimeSeconds: item.moment.currentTimeSeconds,
      momentLabel: item.moment.label
    } : {}),
    ...(item.kind === 'pin' || item.kind === 'region'
      ? { geometry: item.geometry, label: item.label }
      : {}),
    comment: local?.comment ?? item.comment,
    isNew: false,
    unsynchronized: Boolean(local)
  };
}

function capsuleFromWorkingCopy(value: WorkbenchFeedbackWorkingCopy): CanvasFeedbackCapsule {
  return {
    ...value,
    ...(value.momentTimeSeconds === undefined ? {} : { momentTimeSeconds: value.momentTimeSeconds }),
    ...(value.geometry ? { geometry: value.geometry } : {}),
    isNew: true,
    unsynchronized: value.comment !== ''
  };
}

function workingCopyFromItem(
  projectRelativePath: string,
  item: CanvasFeedbackItem
): WorkbenchFeedbackWorkingCopy {
  return workingCopyFromComposition({
    itemId: item.id,
    createdAt: item.createdAt,
    projectRelativePath,
    kind: item.kind,
    scope: item.scope,
    ...(item.scope === 'moment' ? { momentTimeSeconds: item.moment.currentTimeSeconds } : {}),
    ...(item.kind === 'pin' || item.kind === 'region' ? { geometry: item.geometry } : {})
  }, item.comment);
}

function workingCopyFromComposition(
  composition: CanvasFeedbackComposition,
  comment: string
): WorkbenchFeedbackWorkingCopy {
  const base = {
    itemId: composition.itemId,
    createdAt: composition.createdAt,
    projectRelativePath: composition.projectRelativePath,
    comment
  };
  if (composition.scope === 'node') {
    if (composition.kind === 'comment') {
      return { ...base, kind: 'comment', scope: 'node' };
    }
    if (composition.kind === 'pin' && composition.geometry?.type === 'point') {
      return { ...base, kind: 'pin', scope: 'node', geometry: composition.geometry };
    }
    if (composition.kind === 'region' && composition.geometry?.type === 'rect') {
      return { ...base, kind: 'region', scope: 'node', geometry: composition.geometry };
    }
    throw new Error(`Incomplete ${composition.kind} Feedback Working Copy composition.`);
  }
  if (composition.momentTimeSeconds === undefined) {
    throw new Error('Moment Feedback Working Copy composition requires momentTimeSeconds.');
  }
  if (composition.kind === 'comment') {
    return {
      ...base,
      kind: 'comment',
      scope: 'moment',
      momentTimeSeconds: composition.momentTimeSeconds
    };
  }
  if (composition.kind === 'pin' && composition.geometry?.type === 'point') {
    return {
      ...base,
      kind: 'pin',
      scope: 'moment',
      momentTimeSeconds: composition.momentTimeSeconds,
      geometry: composition.geometry
    };
  }
  if (composition.kind === 'region' && composition.geometry?.type === 'rect') {
    return {
      ...base,
      kind: 'region',
      scope: 'moment',
      momentTimeSeconds: composition.momentTimeSeconds,
      geometry: composition.geometry
    };
  }
  throw new Error(`Incomplete ${composition.kind} Feedback Working Copy composition.`);
}

function addItemFromWorkingCopy(
  workingCopy: WorkbenchFeedbackWorkingCopy,
  comment: string
): Extract<UpdateCanvasFeedbackInput, { operation: 'add-item' }>['item'] {
  if (workingCopy.scope === 'node') {
    if (workingCopy.kind === 'comment') {
      return { id: workingCopy.itemId, createdAt: workingCopy.createdAt, kind: 'comment', scope: 'node', comment };
    }
    if (!workingCopy.geometry) {
      throw new Error('Spatial Feedback Working Copy requires geometry.');
    }
    return {
      id: workingCopy.itemId,
      createdAt: workingCopy.createdAt,
      kind: workingCopy.kind,
      scope: 'node',
      geometry: workingCopy.geometry,
      comment
    };
  }
  if (workingCopy.momentTimeSeconds === undefined) {
    throw new Error('Moment Feedback Working Copy requires momentTimeSeconds.');
  }
  if (workingCopy.kind === 'comment') {
    return {
      id: workingCopy.itemId,
      createdAt: workingCopy.createdAt,
      kind: 'comment',
      scope: 'moment',
      momentTimeSeconds: workingCopy.momentTimeSeconds,
      comment
    };
  }
  if (!workingCopy.geometry) {
    throw new Error('Spatial Feedback Working Copy requires geometry.');
  }
  return {
    id: workingCopy.itemId,
    createdAt: workingCopy.createdAt,
    kind: workingCopy.kind,
    scope: 'moment',
    momentTimeSeconds: workingCopy.momentTimeSeconds,
    geometry: workingCopy.geometry,
    comment
  };
}

function findAcceptedItem(
  feedback: CanvasFeedbackDocument | undefined,
  itemId: string
): CanvasFeedbackItem | undefined {
  for (const entry of Object.values(feedback?.entries ?? {})) {
    const item = entry.items.find((candidate) => candidate.id === itemId);
    if (item) {
      return item;
    }
  }
  return undefined;
}

function compareCapsuleCreationOrder(
  left: CanvasFeedbackCapsule,
  right: CanvasFeedbackCapsule
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.itemId.localeCompare(right.itemId);
}

let feedbackItemSequence = 0;

function createFeedbackItemId(): string {
  feedbackItemSequence = (feedbackItemSequence + 1) % 1_679_616;
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const sequence = feedbackItemSequence.toString(36).padStart(4, '0');
  return `feedback-${timestamp}-${sequence}-${crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
