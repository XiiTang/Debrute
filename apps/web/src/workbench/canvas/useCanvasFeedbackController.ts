import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  WorkbenchApiClient,
  WorkbenchEvent,
  WorkbenchFeedbackWorkingCopy
} from '@debrute/app-protocol';
import type {
  CanvasFeedbackDocument,
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
import {
  canvasFeedbackAddItemForPending,
  pendingCanvasFeedbackItemLabel,
  type PendingCanvasFeedbackItem
} from './canvasFeedbackDraft';

export interface CanvasFeedbackController {
  feedback: CanvasFeedbackDocument | undefined;
  target: CanvasFeedbackBarTarget | undefined;
  currentTarget: CanvasFeedbackBarTarget | undefined;
  localMode: CanvasMediaFeedbackMode | undefined;
  pendingItem: PendingCanvasFeedbackItem | undefined;
  pendingComment: string;
  setPendingComment(value: string): void;
  updateEntry(input: UpdateCanvasFeedbackEntryInput): Promise<boolean>;
  handleTargetChange(target: CanvasFeedbackBarTarget | undefined): void;
  handlePointerEnter(): void;
  handlePointerLeave(): void;
  handleModeChange(mode: CanvasMediaFeedbackMode): void;
  handleDraft(draft: CanvasLocalFeedbackDraft): void;
  cancelPending(): void;
  savePending(): Promise<boolean>;
  restoreWorkingCopy(workingCopy: WorkbenchFeedbackWorkingCopy | null | undefined): void;
  load(): Promise<void>;
  reset(): void;
  applyEvent(event: WorkbenchEvent): void;
}

export function useCanvasFeedbackController(input: {
  api: WorkbenchApiClient;
  projectId: string | undefined;
  overlayRuntime: CanvasOverlayRuntime;
  notifyUnavailable(message: string): void;
}): CanvasFeedbackController {
  const [feedback, setFeedback] = useState<CanvasFeedbackDocument>();
  const [target, setTarget] = useState<CanvasFeedbackBarTarget>();
  const [localMode, setLocalMode] = useState<CanvasMediaFeedbackMode>();
  const [pendingItem, setPendingItem] = useState<PendingCanvasFeedbackItem>();
  const [pendingComment, setPendingComment] = useState('');
  const targetClearTimerRef = useRef<number | undefined>(undefined);
  const hoveredRef = useRef(false);
  const requestEpochRef = useRef(0);
  const draftVersionRef = useRef(0);
  const pendingItemRef = useRef<PendingCanvasFeedbackItem | undefined>(undefined);
  const pendingCommentRef = useRef('');
  const projectIdRef = useRef(input.projectId);
  const workingCopyCoordinatorsRef = useRef(new Map<string, {
    desired: WorkbenchFeedbackWorkingCopy | null | undefined;
    running: Promise<boolean>;
  }>());
  projectIdRef.current = input.projectId;

  const persistWorkingCopy = useCallback((workingCopy: WorkbenchFeedbackWorkingCopy | null) => {
    const projectId = projectIdRef.current;
    if (!projectId) {
      return Promise.resolve(false);
    }
    const active = workingCopyCoordinatorsRef.current.get(projectId);
    if (active) {
      active.desired = workingCopy;
      return active.running;
    }
    const coordinator = {
      desired: workingCopy as WorkbenchFeedbackWorkingCopy | null | undefined,
      running: Promise.resolve(true)
    };
    workingCopyCoordinatorsRef.current.set(projectId, coordinator);
    coordinator.running = (async () => {
      let succeeded = true;
      while (coordinator.desired !== undefined) {
        const desired = coordinator.desired;
        coordinator.desired = undefined;
        try {
          if (desired) {
            await input.api.putFeedbackWorkingCopy(projectId, desired);
          } else {
            await input.api.clearFeedbackWorkingCopy(projectId);
          }
        } catch (error) {
          succeeded = false;
          if (projectIdRef.current === projectId) {
            input.notifyUnavailable(errorMessage(error));
          }
        }
      }
      workingCopyCoordinatorsRef.current.delete(projectId);
      return succeeded;
    })();
    return coordinator.running;
  }, [input.api, input.notifyUnavailable]);

  const beginRequest = useCallback(() => {
    const epoch = requestEpochRef.current + 1;
    requestEpochRef.current = epoch;
    return epoch;
  }, []);

  const invalidateRequests = useCallback(() => {
    requestEpochRef.current += 1;
  }, []);

  const updateEntry = useCallback(async (updateInput: UpdateCanvasFeedbackEntryInput) => {
    const epoch = beginRequest();
    try {
      const result = await input.api.updateCanvasFeedbackEntry(updateInput);
      if (requestEpochRef.current === epoch) {
        setFeedback(result.feedback);
      }
      return true;
    } catch (error) {
      if (requestEpochRef.current === epoch) {
        input.notifyUnavailable(errorMessage(error));
      }
      return false;
    }
  }, [beginRequest, input.api, input.notifyUnavailable]);

  const updatePendingComment = useCallback((value: string) => {
    if (pendingCommentRef.current === value) {
      return;
    }
    pendingCommentRef.current = value;
    draftVersionRef.current += 1;
    setPendingComment(value);
    if (pendingItemRef.current) {
      persistWorkingCopy({
        pendingItem: pendingItemRef.current,
        pendingComment: value,
        localMode: localMode ?? null
      });
    }
  }, [localMode, persistWorkingCopy]);

  const clearTargetTimer = useCallback(() => {
    if (targetClearTimerRef.current !== undefined) {
      window.clearTimeout(targetClearTimerRef.current);
      targetClearTimerRef.current = undefined;
    }
  }, []);

  const clearTarget = useCallback(() => {
    input.overlayRuntime.clearFeedbackBarPlacement();
    setTarget(undefined);
  }, [input.overlayRuntime]);

  const handleTargetChange = useCallback((nextTarget: CanvasFeedbackBarTarget | undefined) => {
    clearTargetTimer();
    if (nextTarget) {
      setTarget((current) => (
        sameCanvasFeedbackBarTarget(current, nextTarget) ? current : nextTarget
      ));
      return;
    }
    targetClearTimerRef.current = window.setTimeout(() => {
      targetClearTimerRef.current = undefined;
      if (!hoveredRef.current) {
        clearTarget();
      }
    }, 120);
  }, [clearTarget, clearTargetTimer]);

  const handlePointerEnter = useCallback(() => {
    hoveredRef.current = true;
    clearTargetTimer();
  }, [clearTargetTimer]);

  const handlePointerLeave = useCallback(() => {
    hoveredRef.current = false;
    clearTargetTimer();
    clearTarget();
  }, [clearTarget, clearTargetTimer]);

  const handleModeChange = useCallback((mode: CanvasMediaFeedbackMode) => {
    void (async () => {
      if (!await persistWorkingCopy(null)) {
        return;
      }
      draftVersionRef.current += 1;
      pendingItemRef.current = undefined;
      pendingCommentRef.current = '';
      setLocalMode(mode);
      setPendingItem(undefined);
      setPendingComment('');
    })();
  }, [persistWorkingCopy]);

  const handleDraft = useCallback((draft: CanvasLocalFeedbackDraft) => {
    clearTargetTimer();
    setTarget(draft.feedbackBarTarget);
    const currentEntry = feedback?.entries[draft.projectRelativePath];
    const previousPendingItem = pendingItemRef.current;
    const shouldKeepComment = previousPendingItem?.projectRelativePath === draft.projectRelativePath
      && previousPendingItem.kind === draft.kind
      && previousPendingItem.scope === draft.scope
      && previousPendingItem.momentTimeSeconds === draft.momentTimeSeconds;
    const nextPendingItem: PendingCanvasFeedbackItem = {
      projectRelativePath: draft.projectRelativePath,
      kind: draft.kind,
      scope: draft.scope,
      momentTimeSeconds: draft.momentTimeSeconds,
      geometry: draft.geometry,
      label: pendingCanvasFeedbackItemLabel(draft, currentEntry)
    };
    if (!samePendingDraft(previousPendingItem, nextPendingItem)) {
      draftVersionRef.current += 1;
    }
    pendingItemRef.current = nextPendingItem;
    setPendingItem(nextPendingItem);
    setLocalMode(draft.kind === 'pin' ? 'pin' : draft.kind === 'region' ? 'rect' : undefined);
    if (!shouldKeepComment) {
      pendingCommentRef.current = '';
      setPendingComment('');
    }
    persistWorkingCopy({
      pendingItem: nextPendingItem,
      pendingComment: shouldKeepComment ? pendingCommentRef.current : '',
      localMode: draft.kind === 'pin' ? 'pin' : draft.kind === 'region' ? 'rect' : null
    });
  }, [clearTargetTimer, feedback, persistWorkingCopy]);

  const cancelPending = useCallback(() => {
    void (async () => {
      if (!await persistWorkingCopy(null)) {
        return;
      }
      draftVersionRef.current += 1;
      pendingItemRef.current = undefined;
      pendingCommentRef.current = '';
      if (pendingItem?.scope === 'moment') {
        setLocalMode(undefined);
      }
      setPendingItem(undefined);
      setPendingComment('');
    })();
  }, [pendingItem, persistWorkingCopy]);

  const savePending = useCallback(async () => {
    if (!pendingItem) {
      return false;
    }
    const comment = pendingComment.trim();
    if (!comment) {
      return false;
    }
    const item = canvasFeedbackAddItemForPending(pendingItem, comment);
    if (!item) {
      return false;
    }
    const savedDraftVersion = draftVersionRef.current;
    const saved = await updateEntry({
      operation: 'add-item',
      projectRelativePath: pendingItem.projectRelativePath,
      item
    });
    if (!saved) {
      return false;
    }
    if (draftVersionRef.current !== savedDraftVersion) {
      return true;
    }
    if (!await persistWorkingCopy(null)) {
      return false;
    }
    draftVersionRef.current += 1;
    pendingItemRef.current = undefined;
    pendingCommentRef.current = '';
    if (pendingItem.scope === 'moment') {
      setLocalMode(undefined);
    }
    setPendingItem(undefined);
    setPendingComment('');
    return true;
  }, [pendingComment, pendingItem, persistWorkingCopy, updateEntry]);

  const restoreWorkingCopy = useCallback((workingCopy: WorkbenchFeedbackWorkingCopy | null | undefined) => {
    draftVersionRef.current += 1;
    const pending = workingCopy?.pendingItem;
    pendingItemRef.current = pending;
    pendingCommentRef.current = workingCopy?.pendingComment ?? '';
    setPendingItem(pending);
    setPendingComment(workingCopy?.pendingComment ?? '');
    setLocalMode(workingCopy?.localMode ?? undefined);
  }, []);

  const load = useCallback(async () => {
    const epoch = beginRequest();
    try {
      const loadedFeedback = await input.api.readCanvasFeedback();
      if (requestEpochRef.current === epoch) {
        setFeedback(loadedFeedback);
      }
    } catch (error) {
      if (requestEpochRef.current === epoch) {
        setFeedback(undefined);
        input.notifyUnavailable(errorMessage(error));
      }
    }
  }, [beginRequest, input.api, input.notifyUnavailable]);

  const reset = useCallback(() => {
    invalidateRequests();
    draftVersionRef.current += 1;
    pendingItemRef.current = undefined;
    pendingCommentRef.current = '';
    clearTargetTimer();
    hoveredRef.current = false;
    input.overlayRuntime.clearFeedbackBarPlacement();
    setFeedback(undefined);
    setTarget(undefined);
    setLocalMode(undefined);
    setPendingItem(undefined);
    setPendingComment('');
  }, [clearTargetTimer, input.overlayRuntime, invalidateRequests]);

  const applyEvent = useCallback((event: WorkbenchEvent) => {
    if (event.type === 'canvas.feedback.changed') {
      invalidateRequests();
      setFeedback(event.feedback);
    }
  }, [invalidateRequests]);

  useEffect(() => () => {
    invalidateRequests();
    clearTargetTimer();
  }, [clearTargetTimer, invalidateRequests]);

  const currentTarget = useMemo(() => (
    target ? canvasFeedbackBarTargetWithCurrentEntry(target, feedback) : undefined
  ), [feedback, target]);

  return useMemo(() => ({
    feedback,
    target,
    currentTarget,
    localMode,
    pendingItem,
    pendingComment,
    setPendingComment: updatePendingComment,
    updateEntry,
    handleTargetChange,
    handlePointerEnter,
    handlePointerLeave,
    handleModeChange,
    handleDraft,
    cancelPending,
    savePending,
    restoreWorkingCopy,
    load,
    reset,
    applyEvent
  }), [
    applyEvent,
    cancelPending,
    currentTarget,
    feedback,
    handleDraft,
    handleModeChange,
    handlePointerEnter,
    handlePointerLeave,
    handleTargetChange,
    load,
    localMode,
    pendingComment,
    pendingItem,
    reset,
    restoreWorkingCopy,
    savePending,
    target,
    updatePendingComment,
    updateEntry
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePendingDraft(
  left: PendingCanvasFeedbackItem | undefined,
  right: PendingCanvasFeedbackItem | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.projectRelativePath === right.projectRelativePath
    && left.kind === right.kind
    && left.scope === right.scope
    && left.momentTimeSeconds === right.momentTimeSeconds
    && sameFeedbackGeometry(left.geometry, right.geometry);
}

function sameFeedbackGeometry(
  left: PendingCanvasFeedbackItem['geometry'],
  right: PendingCanvasFeedbackItem['geometry']
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.type !== right.type) {
    return false;
  }
  if (left.x !== right.x || left.y !== right.y) {
    return false;
  }
  return left.type === 'point'
    || (right.type === 'rect' && left.width === right.width && left.height === right.height);
}
