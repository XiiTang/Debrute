import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkbenchApiClient,
  WorkbenchEvent,
  WorkbenchFeedbackWorkingCopy
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
  CanvasFeedbackGeometry,
  CanvasFeedbackItem,
  CanvasFeedbackMark,
  UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import {
  canvasFeedbackBarTargetWithCurrentEntry,
  sameCanvasFeedbackBarTarget,
  type CanvasFeedbackBarTarget,
  type CanvasLocalFeedbackDraft
} from '../shell/floatingBars';
import type { CanvasMediaFeedbackMode } from './CanvasMediaFeedbackLayer';
import type { CanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasFeedbackComposition } from './canvasFeedbackComposition';
import { CanvasFeedbackBar } from './CanvasFeedbackBar';

const FEEDBACK_BAR_DISMISS_DELAY_MS = 120;

export interface CanvasFeedbackCapsule {
  itemId: string;
  createdAt: string;
  projectRelativePath: string;
  kind: 'comment' | 'pin' | 'region';
  scope: 'file' | 'moment';
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
  target: CanvasFeedbackBarTarget | undefined;
  currentTarget: CanvasFeedbackBarTarget | undefined;
  localMode: CanvasMediaFeedbackMode | undefined;
  composition: CanvasFeedbackComposition | undefined;
  authoringItemId: string | undefined;
  focusedCapsuleId: string | undefined;
  capsulesForPath(projectRelativePath: string): CanvasFeedbackCapsule[];
  createFileCapsule(projectRelativePath: string): string;
  changeCapsule(itemId: string, value: string): void;
  focusCapsule(itemId: string): void;
  activateCapsule(target: CanvasFeedbackBarTarget, itemId: string): void;
  blurCapsule(itemId: string): Promise<void>;
  deleteCapsule(itemId: string): Promise<void>;
  setMarks(projectRelativePath: string, marks: CanvasFeedbackMark[]): Promise<void>;
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

export interface CanvasFeedbackCanvasBinding {
  localMode: CanvasMediaFeedbackMode | undefined;
  composition: CanvasFeedbackComposition | undefined;
  localSpatialItems: readonly CanvasFeedbackComposition[];
  suppressedSpatialItemIds: ReadonlySet<string>;
  focusedCapsuleId: string | undefined;
  currentTargetProjectRelativePath: string | undefined;
  handleTargetChange(target: CanvasFeedbackBarTarget | undefined): void;
  invalidateTarget(projectRelativePath: string): void;
  handleDraft(draft: CanvasLocalFeedbackDraft): void;
  activateCapsule(target: CanvasFeedbackBarTarget, itemId: string): void;
}

export function useCanvasFeedbackInteraction(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  notifyUnavailable(message: string): void;
}): CanvasFeedbackInteraction {
  const [feedback, setFeedback] = useState<CanvasFeedbackDocument | undefined>(undefined);
  const feedbackRef = useRef<CanvasFeedbackDocument | undefined>(undefined);
  const [localValues, setLocalValues] = useState<Record<string, WorkbenchFeedbackWorkingCopy>>({});
  const localValuesRef = useRef<Record<string, WorkbenchFeedbackWorkingCopy>>({});
  const versionsRef = useRef(new Map<string, number>());
  const deletingItemKeysRef = useRef(new Set<string>());
  const mutatingMarksKeysRef = useRef(new Set<string>());
  const [target, setTarget] = useState<CanvasFeedbackBarTarget | undefined>(undefined);
  const targetRef = useRef<CanvasFeedbackBarTarget | undefined>(undefined);
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
  const projectIdRef = useRef(input.projectId);
  const workingCopyCoordinatorsRef = useRef(new Map<string, {
    desired: WorkbenchFeedbackWorkingCopy | null | undefined;
    running: Promise<boolean>;
  }>());
  projectIdRef.current = input.projectId;
  feedbackRef.current = feedback;
  localValuesRef.current = localValues;
  focusedCapsuleIdRef.current = focusedCapsuleId;
  targetRef.current = target;

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
    const projectId = projectIdRef.current;
    if (!projectId) {
      return Promise.resolve(false);
    }
    const key = `${projectId}\u0000${itemId}`;
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
            await input.api.putFeedbackWorkingCopy(projectId, desired);
          } else {
            await input.api.clearFeedbackWorkingCopy(projectId, itemId);
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

  const updateEntry = useCallback(async (updateInput: UpdateCanvasFeedbackEntryInput) => {
    try {
      await input.api.updateCanvasFeedbackEntry(updateInput);
      return true;
    } catch {
      return false;
    }
  }, [input.api]);

  const deleteAcceptedItem = useCallback(async (itemId: string, projectRelativePath: string) => {
    const projectId = projectIdRef.current;
    if (!projectId) {
      return false;
    }
    const key = `${projectId}\u0000${itemId}`;
    if (deletingItemKeysRef.current.has(key)) {
      return false;
    }
    deletingItemKeysRef.current.add(key);
    try {
      return await updateEntry({
        operation: 'delete-item',
        projectRelativePath,
        itemId
      });
    } finally {
      deletingItemKeysRef.current.delete(key);
    }
  }, [updateEntry]);

  const setMarks = useCallback(async (projectRelativePath: string, marks: CanvasFeedbackMark[]) => {
    const projectId = projectIdRef.current;
    if (!projectId) {
      return;
    }
    const key = `${projectId}\u0000${projectRelativePath}`;
    if (mutatingMarksKeysRef.current.has(key)) {
      return;
    }
    mutatingMarksKeysRef.current.add(key);
    try {
      await updateEntry({
        operation: 'set-marks',
        projectRelativePath,
        marks
      });
    } finally {
      mutatingMarksKeysRef.current.delete(key);
    }
  }, [updateEntry]);

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
    if (capsule?.scope === 'moment' && capsule.momentTimeSeconds !== undefined) {
      target?.seekToMoment?.(capsule.momentTimeSeconds);
    }
  }, [descriptorForItem, target]);

  const blurCapsule = useCallback(async (itemId: string) => {
    releaseAuthoringItem(itemId);
    if (focusedCapsuleIdRef.current === itemId) {
      const deferredTarget = focusDeferredTargetRef.current;
      focusDeferredTargetRef.current = undefined;
      focusedCapsuleIdRef.current = undefined;
      setFocusedCapsuleId(undefined);
      if (deferredTarget) {
        targetEpochRef.current += 1;
        targetRef.current = deferredTarget;
        setTarget((current) => (
          sameCanvasFeedbackBarTarget(current, deferredTarget) ? current : deferredTarget
        ));
      } else if (deferredTarget === null && !hoveredRef.current) {
        targetEpochRef.current += 1;
        input.overlayRuntime.clearFeedbackBarPlacement();
        targetRef.current = undefined;
        setTarget(undefined);
      } else if (!hoveredRef.current && targetClearTimerRef.current === undefined) {
        const targetEpoch = targetEpochRef.current;
        window.setTimeout(() => {
          if (
            targetEpochRef.current === targetEpoch
            && !hoveredRef.current
            && !focusedCapsuleIdRef.current
          ) {
            input.overlayRuntime.clearFeedbackBarPlacement();
            targetRef.current = undefined;
            setTarget(undefined);
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
    const saved = await updateEntry(accepted
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
  }, [clearComposition, deleteAcceptedItem, input.overlayRuntime, persistWorkingCopy, releaseAuthoringItem, setLocalValue, updateEntry]);

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

  const createFileCapsule = useCallback((projectRelativePath: string) => {
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
      scope: 'file',
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

  const activateCapsule = useCallback((nextTarget: CanvasFeedbackBarTarget, itemId: string) => {
    clearTargetTimer();
    targetEpochRef.current += 1;
    targetRef.current = nextTarget;
    setTarget(nextTarget);
    focusDeferredTargetRef.current = undefined;
    focusedCapsuleIdRef.current = itemId;
    setFocusedCapsuleId(itemId);
    const capsule = descriptorForItem(itemId);
    if (capsule?.scope === 'moment' && capsule.momentTimeSeconds !== undefined) {
      nextTarget.seekToMoment?.(capsule.momentTimeSeconds);
    }
  }, [clearTargetTimer, descriptorForItem]);

  const clearTarget = useCallback(() => {
    if (focusedCapsuleIdRef.current) {
      return;
    }
    input.overlayRuntime.clearFeedbackBarPlacement();
    targetRef.current = undefined;
    setTarget(undefined);
  }, [input.overlayRuntime]);

  const scheduleTargetClear = useCallback(() => {
    clearTargetTimer();
    targetClearTimerRef.current = window.setTimeout(() => {
      targetClearTimerRef.current = undefined;
      if (!hoveredRef.current) {
        clearTarget();
      }
    }, FEEDBACK_BAR_DISMISS_DELAY_MS);
  }, [clearTarget, clearTargetTimer]);

  const handleTargetChange = useCallback((nextTarget: CanvasFeedbackBarTarget | undefined) => {
    clearTargetTimer();
    if (focusedCapsuleIdRef.current) {
      focusDeferredTargetRef.current = nextTarget ?? null;
      return;
    }
    focusDeferredTargetRef.current = undefined;
    targetEpochRef.current += 1;
    if (nextTarget) {
      targetRef.current = nextTarget;
      setTarget((current) => (
        sameCanvasFeedbackBarTarget(current, nextTarget) ? current : nextTarget
      ));
      return;
    }
    scheduleTargetClear();
  }, [clearTargetTimer, scheduleTargetClear]);

  const invalidateTarget = useCallback((projectRelativePath: string) => {
    if (targetRef.current?.projectRelativePath !== projectRelativePath) {
      return;
    }
    clearTargetTimer();
    targetEpochRef.current += 1;
    focusDeferredTargetRef.current = undefined;
    hoveredRef.current = false;
    focusedCapsuleIdRef.current = undefined;
    setFocusedCapsuleId(undefined);
    targetRef.current = undefined;
    input.overlayRuntime.clearFeedbackBarPlacement();
    setTarget(undefined);
  }, [clearTargetTimer, input.overlayRuntime]);

  const handlePointerEnter = useCallback(() => {
    hoveredRef.current = true;
    clearTargetTimer();
  }, [clearTargetTimer]);

  const handlePointerLeave = useCallback(() => {
    hoveredRef.current = false;
    scheduleTargetClear();
  }, [scheduleTargetClear]);

  const handleModeChange = useCallback((mode: CanvasMediaFeedbackMode) => {
    if (!mode) {
      if (compositionRef.current && !compositionRef.current.geometry) {
        compositionRef.current = undefined;
        setComposition(undefined);
      }
      setLocalMode(undefined);
      return;
    }
    if (!target) {
      return;
    }
    const itemId = createFeedbackItemId();
    const nextComposition: CanvasFeedbackComposition = {
      itemId,
      createdAt: new Date().toISOString(),
      projectRelativePath: target.projectRelativePath,
      kind: mode === 'pin' ? 'pin' : 'region',
      scope: 'file'
    };
    compositionRef.current = nextComposition;
    setComposition(nextComposition);
    setLocalMode(mode);
  }, [target]);

  const handleDraft = useCallback((draft: CanvasLocalFeedbackDraft) => {
    clearTargetTimer();
    targetEpochRef.current += 1;
    targetRef.current = draft.feedbackBarTarget;
    setTarget(draft.feedbackBarTarget);
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
  }, [clearTargetTimer, setLocalValue]);

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

  const currentTarget = useMemo(() => (
    target ? canvasFeedbackBarTargetWithCurrentEntry(target, feedback) : undefined
  ), [feedback, target]);

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
    currentTargetProjectRelativePath: currentTarget?.projectRelativePath,
    handleTargetChange,
    invalidateTarget,
    handleDraft,
    activateCapsule
  }), [
    activateCapsule,
    focusedCapsuleId,
    handleDraft,
    handleTargetChange,
    invalidateTarget,
    localMode,
    localSpatialItems,
    currentTarget?.projectRelativePath,
    composition,
    suppressedSpatialItemIds
  ]);

  return useMemo(() => ({
    feedback,
    target,
    currentTarget,
    localMode,
    composition,
    authoringItemId,
    focusedCapsuleId,
    capsulesForPath,
    createFileCapsule,
    changeCapsule,
    focusCapsule,
    activateCapsule,
    blurCapsule,
    deleteCapsule,
    setMarks,
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
    createFileCapsule,
    currentTarget,
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
    authoringItemId,
    composition,
    restoreWorkingCopies,
    setMarks,
    target
  ]);
}

export function CanvasFeedbackInteractionBar({
  interaction,
  overlayRuntime
}: {
  interaction: CanvasFeedbackInteraction;
  overlayRuntime: CanvasOverlayRuntime;
}): React.ReactElement | null {
  const target = interaction.currentTarget;
  if (!target) {
    return null;
  }
  return (
    <CanvasFeedbackBar
      projectRelativePath={target.projectRelativePath}
      capsules={interaction.capsulesForPath(target.projectRelativePath)}
      focusedCapsuleId={interaction.focusedCapsuleId}
      authoringItemId={interaction.authoringItemId}
      marks={target.entry?.marks ?? []}
      onSetMarks={(marks) => {
        void interaction.setMarks(target.projectRelativePath, marks);
      }}
      overlayRuntime={overlayRuntime}
      localToolset={target.localToolset}
      localFeedbackMode={target.localToolset === 'none' ? undefined : interaction.localMode}
      onLocalFeedbackModeChange={target.localToolset === 'image' ? interaction.handleModeChange : undefined}
      canStartVideoMomentFeedback={target.canStartVideoMomentFeedback}
      onStartVideoMomentFeedback={target.startVideoMomentFeedback}
      onCreateFileCapsule={() => interaction.createFileCapsule(target.projectRelativePath)}
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
  if (composition.scope === 'file') {
    if (composition.kind === 'comment') {
      return { ...base, kind: 'comment', scope: 'file' };
    }
    if (composition.kind === 'pin' && composition.geometry?.type === 'point') {
      return { ...base, kind: 'pin', scope: 'file', geometry: composition.geometry };
    }
    if (composition.kind === 'region' && composition.geometry?.type === 'rect') {
      return { ...base, kind: 'region', scope: 'file', geometry: composition.geometry };
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
): Extract<UpdateCanvasFeedbackEntryInput, { operation: 'add-item' }>['item'] {
  if (workingCopy.scope === 'file') {
    if (workingCopy.kind === 'comment') {
      return { id: workingCopy.itemId, createdAt: workingCopy.createdAt, kind: 'comment', scope: 'file', comment };
    }
    if (!workingCopy.geometry) {
      throw new Error('Spatial Feedback Working Copy requires geometry.');
    }
    return {
      id: workingCopy.itemId,
      createdAt: workingCopy.createdAt,
      kind: workingCopy.kind,
      scope: 'file',
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
