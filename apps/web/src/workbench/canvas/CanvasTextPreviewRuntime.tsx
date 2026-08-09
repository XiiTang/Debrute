import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { createPortal } from 'react-dom';
import {
  canvasPreviewContinuityKey,
  type CanvasPreviewTargetKey
} from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { TextFileBuffer } from '../../types.js';
import type { CanvasSceneActions } from './CanvasSceneActions.js';
import {
  canvasTextPreviewTargetIdentity,
  canvasTextPreviewTargetKey,
  canvasTextPreviewSourceSize,
  type CanvasTextPreviewCandidate,
  type CanvasTextPreviewCaptureResult,
  type CanvasTextPreviewCaptureTarget,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture.js';
import { CanvasTextPreviewCaptureLane } from './CanvasTextPreviewCaptureLane.js';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFieldsForTarget,
  canvasTextPreviewFailureFromUnknown
} from './CanvasTextPreviewFailure.js';
import {
  sameCanvasRasterPreviewRequest,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation.js';
import {
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshotForDocument
} from './CanvasTextPreviewStyleKey.js';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor.js';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler.js';
import type { CanvasSourceResolutionRuntime } from './CanvasSourceResolutionRuntime.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  canvasChangedRecordPaths,
  canvasRecordsMatchingTargetKeys,
  canvasRecordValuesEqual,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';
import { canvasRawFileBindingId } from './canvasRawFileUrls.js';
import { useCanvasTextRenderProfile } from './CanvasTextRenderProfileContext.js';
import type { CanvasTextPreparedFont } from './CanvasTextRenderProfile.js';
import {
  canvasTextPreviewCoverageContains,
  collectCanvasTextPreviewCoverage,
  mergeCanvasTextPreviewCoverage
} from './font-subset/CanvasTextPreviewCoverage.js';
import type { CanvasTextPreviewFontPreparation } from './font-subset/CanvasTextPreviewFontSession.js';
import { useCanvasTextProjectFontEnvironment } from './font-subset/CanvasTextProjectFontEnvironment.js';
import {
  CANVAS_TEXT_PREVIEW_CONTENT_MAX_CONCURRENT_READS,
  canvasTextPreviewContentWindow,
  canvasTextPreviewExecutingTask,
  canvasTextPreviewTaskHoldsContent,
  reconcileCanvasTextPreviewTasks,
  type CanvasTextPreviewTask
} from './CanvasTextPreviewTaskRegistry.js';
import { orderCanvasPreviewItemsByNode } from './CanvasPreviewScheduling.js';
import { canvasTextPresentationGeometry } from './CanvasNodePresentationGeometry.js';
import { useCanvasPreviewInteractionGate } from './useCanvasPreviewInteractionGate.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';

export interface CanvasTextPreviewSourceAvailability {
  targetKey: CanvasPreviewTargetKey;
  available: boolean;
}

interface CanvasTextPreviewErrorState {
  targetKey: CanvasPreviewTargetKey;
  error: Error;
}

interface CanvasTextPreviewAvailabilityRequest {
  epoch: number;
}

interface CanvasTextPreviewTargetInput {
  readonly bindingId: string;
  readonly projectRelativePath: string;
  readonly contentDigest?: string | undefined;
  readonly dirtyContent?: string | undefined;
  readonly estimatedBytes: number;
  readonly language: NonNullable<ProjectedCanvasNode['textLanguage']>;
  readonly wordWrap: boolean;
  readonly contentCssWidth: number;
  readonly contentCssHeight: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly styleKey: string;
}

interface CanvasTextPreviewTargetResolution {
  readonly input: CanvasTextPreviewTargetInput;
  readonly pending: Promise<CanvasTextPreviewTarget>;
  target?: CanvasTextPreviewTarget | undefined;
}

function beginCanvasTextPreviewTargetResolution(
  input: CanvasTextPreviewTargetInput,
  onResolved: (target: CanvasTextPreviewTarget) => void
): CanvasTextPreviewTargetResolution {
  const resolution: CanvasTextPreviewTargetResolution = {
    input,
    pending: resolveCanvasTextPreviewTarget(input).then((target) => {
      resolution.target = target;
      onResolved(target);
      return target;
    })
  };
  return resolution;
}

interface CanvasTextPreviewCoverageJob {
  readonly abortController: AbortController;
}

type CanvasTextPreviewAttemptTarget = CanvasTextPreviewTarget & Pick<CanvasTextPreviewTask, 'attempt'>;
type CanvasTextPreviewExecutionTarget = CanvasTextPreviewCaptureTarget & Pick<CanvasTextPreviewTask, 'attempt'>;

interface CanvasTextPreviewFontBuild {
  readonly abortController: AbortController;
  readonly coverage: Uint32Array;
  readonly attempts: ReadonlyMap<string, object>;
}

interface CanvasTextPreviewFontCandidate {
  readonly coverage: Uint32Array;
  readonly preparation: CanvasTextPreviewFontPreparation;
}

export interface CanvasTextPreviewRuntimeValue {
  retryPreview(projectRelativePath: string): void;
  acceptNode(node: ProjectedCanvasNode): void;
  getNodeSnapshot(node: ProjectedCanvasNode): CanvasTextPreviewNodeSnapshot;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export interface CanvasTextPreviewNodeSnapshot {
  readonly request: CanvasRasterPreviewRequest;
  readonly previewError: string | undefined;
}

const CanvasTextPreviewRuntimeContext = createContext<CanvasTextPreviewRuntimeValue | undefined>(undefined);

export function useCanvasTextPreviewRuntime(): CanvasTextPreviewRuntimeValue {
  const runtime = useContext(CanvasTextPreviewRuntimeContext);
  if (!runtime) {
    throw new Error('CanvasTextPreviewProvider is required.');
  }
  return runtime;
}

export function useCanvasTextPreviewNode(node: ProjectedCanvasNode): CanvasTextPreviewNodeSnapshot {
  const runtime = useCanvasTextPreviewRuntime();
  useLayoutEffect(() => {
    runtime.acceptNode(node);
  }, [node, runtime]);
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeNode(node, listener),
    [node, runtime]
  );
  const getSnapshot = useCallback(() => runtime.getNodeSnapshot(node), [node, runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function CanvasTextPreviewProvider({
  nodes,
  sourceResolutionRuntime,
  activeInlineTextPath,
  textFileBuffers,
  actions,
  previewOrder,
  styleDependencyKey,
  perfMonitor,
  previewResourceScheduler,
  children
}: {
  nodes: ProjectedCanvasNode[];
  sourceResolutionRuntime: Pick<CanvasSourceResolutionRuntime, 'getNode'>;
  activeInlineTextPath?: string | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  actions: CanvasSceneActions;
  previewOrder: CanvasPreviewOrderSource;
  styleDependencyKey: string;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const renderProfile = useCanvasTextRenderProfile();
  const fontEnvironment = useCanvasTextProjectFontEnvironment();
  const previewFontSession = fontEnvironment.previewSession;
  const [sourceAvailability, setSourceAvailability] = useState<Record<string, CanvasTextPreviewSourceAvailability>>({});
  const [activePreparedFont, setActivePreparedFont] = useState<CanvasTextPreparedFont>();
  const [fontCandidate, setFontCandidate] = useState<CanvasTextPreviewFontCandidate>();
  const [captureLayerRoot, setCaptureLayerRoot] = useState<HTMLElement>();
  const [previewErrors, setPreviewErrors] = useState<Record<string, CanvasTextPreviewErrorState>>({});
  const [tasks, setTasks] = useState<Map<string, CanvasTextPreviewTask>>(() => new Map());
  const [availabilitySettlementVersion, setAvailabilitySettlementVersion] = useState(0);
  const [contentReadSettlementVersion, setContentReadSettlementVersion] = useState(0);
  const [styleKeyState, setStyleKeyState] = useState<{ key?: string; error?: Error }>({});
  const currentTargetKeysRef = useRef(new Map<string, CanvasPreviewTargetKey>());
  const currentTargetsRef = useRef<Record<string, CanvasTextPreviewTarget>>({});
  const targetResolutionsRef = useRef(new Map<string, CanvasTextPreviewTargetResolution>());
  const tasksRef = useRef(tasks);
  const sourceAvailabilityRef = useRef(sourceAvailability);
  const previewErrorsRef = useRef(previewErrors);
  const changedNodePathsRef = useRef(new Set<string>());
  const textFileBuffersRef = useRef(textFileBuffers);
  const activeInlineTextPathRef = useRef(activeInlineTextPath);
  const styleKeyRef = useRef(styleKeyState.key);
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const runtimeEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const availabilityInFlightRef = useRef<CanvasTextPreviewAvailabilityRequest | undefined>(undefined);
  const contentReadsRef = useRef(new Set<number>());
  const contentReadIdByPathRef = useRef(new Map<string, number>());
  const nextContentReadIdRef = useRef(0);
  const coverageJobRef = useRef<CanvasTextPreviewCoverageJob | undefined>(undefined);
  const fontBuildRef = useRef<CanvasTextPreviewFontBuild | undefined>(undefined);
  const fontCandidateRef = useRef<CanvasTextPreviewFontCandidate | undefined>(fontCandidate);
  const activeFontCoverageRef = useRef<Uint32Array>(new Uint32Array());
  const epochCoverageRef = useRef<Uint32Array>(new Uint32Array());
  const registryWasEmptyRef = useRef(true);
  const hasPendingPreviewWork = useCallback(() => (
    [...tasksRef.current.values()].some((task) => (
      task.state === 'checking'
      || task.state === 'needs-content'
      || task.state === 'ready'
      || task.state === 'waiting-font'
    ))
  ), []);
  const {
    interactionActiveRef,
    resumeVersion: interactionResumeVersion
  } = useCanvasPreviewInteractionGate({
    scheduler: previewResourceScheduler,
    hasPendingWork: hasPendingPreviewWork
  });
  const markNodePathChanged = useCallback((path: string) => {
    changedNodePathsRef.current.add(path);
  }, []);
  const markChangedNodeRecords = useCallback(<Value,>(
    previous: Readonly<Record<string, Value>>,
    next: Readonly<Record<string, Value>>
  ) => {
    for (const path of canvasChangedRecordPaths(previous, next)) {
      changedNodePathsRef.current.add(path);
    }
  }, []);
  textFileBuffersRef.current = textFileBuffers;
  activeInlineTextPathRef.current = activeInlineTextPath;
  styleKeyRef.current = styleKeyState.key;
  tasksRef.current = tasks;
  sourceAvailabilityRef.current = sourceAvailability;
  previewErrorsRef.current = previewErrors;
  fontCandidateRef.current = fontCandidate;

  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  const orderedTasks = useMemo(() => orderCanvasTextPreviewTasks({
    tasks,
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [nodesByPath, previewOrderSnapshot, tasks]);
  const executingTask = canvasTextPreviewExecutingTask(tasks);
  const captureTask = executingTask?.state === 'capturing' && executingTask.content !== undefined
    ? executingTask
    : undefined;
  const captureTarget = useMemo<CanvasTextPreviewExecutionTarget | undefined>(() => (
    captureTask?.content === undefined
      ? undefined
      : { ...captureTask, content: captureTask.content }
  ), [captureTask]);

  const recordTextPreviewCounter = useCallback((
    name: CanvasPerfCounterName,
    detail?: Record<string, unknown>
  ) => {
    perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: performance.now(),
      source: 'CanvasTextPreviewRuntime',
      name,
      detail
    });
  }, [perfMonitor]);
  const beginTargetResolution = useCallback((input: CanvasTextPreviewTargetInput) => (
    beginCanvasTextPreviewTargetResolution(input, (target) => {
      recordTextPreviewCounter('text-preview-target-identity-computed', {
        projectRelativePath: target.projectRelativePath,
        targetIdentity: target.targetIdentity,
        contentDigest: target.contentDigest,
        estimatedBytes: target.estimatedBytes,
        language: target.language,
        wordWrap: target.wordWrap,
        contentCssWidth: target.contentCssWidth,
        contentCssHeight: target.contentCssHeight,
        scrollTop: target.scrollTop,
        scrollLeft: target.scrollLeft,
        styleKey: target.styleKey,
        sourcePixelWidth: target.sourcePixelWidth,
        sourcePixelHeight: target.sourcePixelHeight,
        sourceScale: target.sourceScale
      });
    })
  ), [recordTextPreviewCounter]);
  const updateTasks = useCallback((
    update: (current: Map<string, CanvasTextPreviewTask>) => Map<string, CanvasTextPreviewTask>
  ) => {
    setTasks((current) => {
      const next = update(current);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const commitTargets = useCallback((targets: CanvasTextPreviewTarget[]) => {
    const targetKeys = new Map(targets.map((target) => [
      target.projectRelativePath,
      canvasTextPreviewTargetKey(target)
    ]));
    const byPath = Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
    markChangedNodeRecords(currentTargetsRef.current, byPath);
    currentTargetKeysRef.current = targetKeys;
    currentTargetsRef.current = byPath;

    const nextAvailability = canvasTextPreviewCurrentSourceAvailability({
      targets,
      sourceAvailability: sourceAvailabilityRef.current
    });
    if (!canvasRecordValuesEqual(sourceAvailabilityRef.current, nextAvailability)) {
      markChangedNodeRecords(sourceAvailabilityRef.current, nextAvailability);
      sourceAvailabilityRef.current = nextAvailability;
      setSourceAvailability(nextAvailability);
    }

    const nextErrors = canvasRecordsMatchingTargetKeys(previewErrorsRef.current, targetKeys);
    if (!canvasRecordValuesEqual(previewErrorsRef.current, nextErrors)) {
      markChangedNodeRecords(previewErrorsRef.current, nextErrors);
      previewErrorsRef.current = nextErrors;
      setPreviewErrors(nextErrors);
    }

    const workTargets = targets.filter((target) => (
      target.projectRelativePath !== activeInlineTextPathRef.current
    ));
    updateTasks((current) => reconcileCanvasTextPreviewTasks({
      previous: current,
      targets: workTargets,
      sourceAvailability: sourceAvailabilityRef.current
    }));
  }, [markChangedNodeRecords, updateTasks]);

  const isCurrentTarget = useCallback((epoch: number, target: CanvasTextPreviewTarget): boolean => (
    mountedRef.current
    && epoch === runtimeEpochRef.current
    && currentTargetKeysRef.current.get(target.projectRelativePath) === canvasTextPreviewTargetKey(target)
  ), []);

  const setCurrentPreviewFailure = useCallback((
    target: CanvasTextPreviewAttemptTarget,
    error: CanvasTextPreviewFailure
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    if (currentTargetKeysRef.current.get(target.projectRelativePath) !== targetKey
      || tasksRef.current.get(target.projectRelativePath)?.attempt !== target.attempt) {
      return;
    }
    setPreviewErrors((current) => {
      markNodePathChanged(target.projectRelativePath);
      return {
        ...current,
        [target.projectRelativePath]: { targetKey, error }
      };
    });
    updateTasks((current) => updateCanvasTextPreviewTask(current, target, {
      state: 'failed',
      content: undefined,
      contentBytes: undefined,
      coverage: undefined
    }));
    recordTextPreviewCounter('text-preview-failed', {
      projectRelativePath: target.projectRelativePath,
      targetIdentity: target.targetIdentity,
      stage: error.stage,
      message: error.message
    });
  }, [markNodePathChanged, recordTextPreviewCounter, updateTasks]);

  const clearCurrentPreviewFailure = useCallback((target: CanvasTextPreviewTarget) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    setPreviewErrors((current) => {
      const existing = current[target.projectRelativePath];
      if (!existing || existing.targetKey !== targetKey) {
        return current;
      }
      markNodePathChanged(target.projectRelativePath);
      return withoutRecordPath(current, target.projectRelativePath);
    });
  }, [markNodePathChanged]);

  const retryPreview = useCallback<CanvasTextPreviewRuntimeValue['retryPreview']>((projectRelativePath) => {
    const target = currentTargetsRef.current[projectRelativePath];
    const error = previewErrorsRef.current[projectRelativePath];
    if (!target
      || error?.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    setSourceAvailability((current) => {
      const next = withoutRecordPath(current, projectRelativePath);
      sourceAvailabilityRef.current = next;
      markChangedNodeRecords(current, next);
      return next;
    });
    setPreviewErrors((current) => {
      const next = withoutRecordPath(current, projectRelativePath);
      markNodePathChanged(projectRelativePath);
      return next;
    });
    updateTasks((current) => {
      const existing = current.get(projectRelativePath);
      const checking = {
        state: 'checking' as const,
        content: undefined,
        contentBytes: undefined,
        coverage: undefined
      };
      if (existing && canvasTextPreviewTargetKey(existing) === canvasTextPreviewTargetKey(target)) {
        const next = new Map(current);
        next.set(projectRelativePath, { ...target, ...checking, attempt: {} });
        return next;
      }
      return new Map(current).set(projectRelativePath, { ...target, ...checking, attempt: {} });
    });
  }, [markChangedNodeRecords, markNodePathChanged, updateTasks]);

  useEffect(() => {
    fontEnvironment.setPreviewMetricsObserver((metrics) => {
      recordTextPreviewCounter('text-preview-font-subset-completed', { ...metrics });
    });
    return () => fontEnvironment.setPreviewMetricsObserver(undefined);
  }, [fontEnvironment, recordTextPreviewCounter]);

  useEffect(() => {
    mountedRef.current = true;
    runtimeEpochRef.current += 1;
    const epoch = runtimeEpochRef.current;
    return () => {
      if (runtimeEpochRef.current === epoch) {
        runtimeEpochRef.current += 1;
      }
      mountedRef.current = false;
      coverageJobRef.current?.abortController.abort();
      coverageJobRef.current = undefined;
      fontBuildRef.current?.abortController.abort();
      fontBuildRef.current = undefined;
      fontCandidateRef.current?.preparation.discard();
      fontCandidateRef.current = undefined;
      availabilityInFlightRef.current = undefined;
      for (const path of currentTargetKeysRef.current.keys()) {
        previewResourceScheduler.cancel('text', path);
      }
    };
  }, [previewResourceScheduler]);

  useEffect(() => {
    coverageJobRef.current?.abortController.abort();
    coverageJobRef.current = undefined;
    fontBuildRef.current?.abortController.abort();
    fontBuildRef.current = undefined;
    setFontCandidate((current) => {
      current?.preparation.discard();
      return undefined;
    });
    setActivePreparedFont(undefined);
    activeFontCoverageRef.current = new Uint32Array();
    epochCoverageRef.current = new Uint32Array();
    updateTasks((current) => resetCanvasTextPreviewCapturingTasks(current));
  }, [previewFontSession, updateTasks]);

  useEffect(() => {
    setCaptureLayerRoot(document.body);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => canvasTextPreviewStyleSnapshotForDocument(renderProfile))
      .then((snapshot) => canvasTextPreviewStyleKey(snapshot))
      .then((key) => {
        if (!cancelled) {
          setStyleKeyState((current) => current.key === key && !current.error ? current : { key });
        }
      }, (error: unknown) => {
        if (!cancelled) {
          setStyleKeyState({ error: errorFromUnknown(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [renderProfile, styleDependencyKey]);

  if (styleKeyState.error) {
    throw styleKeyState.error;
  }

  useEffect(() => {
    if (!styleKeyState.key) {
      return;
    }
    const previous = targetResolutionsRef.current;
    const next = new Map<string, CanvasTextPreviewTargetResolution>();
    for (const projectedNode of nodes) {
      const node = sourceResolutionRuntime.getNode(projectedNode.projectRelativePath)
        ?? projectedNode;
      if (!isStableCanvasTextNode(node)) {
        continue;
      }
      const path = node.projectRelativePath;
      if (path === activeInlineTextPath) {
        const retained = previous.get(path);
        if (retained) {
          next.set(path, retained);
        }
        continue;
      }
      const targetInput = canvasTextPreviewTargetInput({
        node,
        buffer: textFileBuffers[path],
        styleKey: styleKeyState.key
      });
      if (!targetInput) {
        continue;
      }
      const existing = previous.get(path);
      if (existing && canvasTextPreviewTargetInputsEqual(existing.input, targetInput)) {
        next.set(path, existing);
        continue;
      }
      const resolution = beginTargetResolution(targetInput);
      next.set(path, resolution);
    }
    targetResolutionsRef.current = next;
    commitTargets([...next.values()].flatMap((resolution) => resolution.target ? [resolution.target] : []));
    void Promise.all([...next.values()].map((resolution) => resolution.pending)).then((resolved) => {
      if (!mountedRef.current
        || targetResolutionsRef.current !== next) {
        return;
      }
      commitTargets(resolved);
    });
  }, [activeInlineTextPath, beginTargetResolution, commitTargets, nodes, sourceResolutionRuntime, styleKeyState.key, textFileBuffers]);

  useEffect(() => {
    const path = activeInlineTextPath;
    if (!path) {
      return;
    }
    previewResourceScheduler.cancel('text', path);
    setPreviewErrors((current) => {
      if (!(path in current)) {
        return current;
      }
      markNodePathChanged(path);
      return withoutRecordPath(current, path);
    });
  }, [activeInlineTextPath, markNodePathChanged, previewResourceScheduler]);

  useEffect(() => {
    const stateCounts = Object.fromEntries(
      [...tasks.values()].reduce((counts, task) => {
        counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
        return counts;
      }, new Map<CanvasTextPreviewTask['state'], number>())
    );
    const heldContent = [...tasks.values()].filter(canvasTextPreviewTaskHoldsContent);
    const taskInState = (state: CanvasTextPreviewTask['state']) => (
      [...tasks.values()].find((task) => task.state === state)?.projectRelativePath
    );
    recordTextPreviewCounter('text-preview-registry-state', {
      total: tasks.size,
      orderedTotal: orderedTasks.length,
      states: stateCounts,
      contentTargetCount: heldContent.length,
      contentBytes: heldContent.reduce((total, task) => total + (task.contentBytes ?? 0), 0),
      readInFlight: contentReadsRef.current.size,
      uploadInFlight: [...tasks.values()].filter((task) => task.state === 'uploading').length,
      readingPath: taskInState('reading'),
      readyPath: taskInState('ready'),
      waitingFontPath: taskInState('waiting-font'),
      capturingPath: taskInState('capturing'),
      orderedCapturingPath: captureTask?.projectRelativePath,
      uploadingPath: taskInState('uploading')
    });
  }, [captureTask?.projectRelativePath, orderedTasks, recordTextPreviewCounter, tasks]);

  useEffect(() => {
    const empty = tasks.size === 0;
    if (empty === registryWasEmptyRef.current) {
      return;
    }
    registryWasEmptyRef.current = empty;
    if (empty) {
      epochCoverageRef.current = new Uint32Array();
      recordTextPreviewCounter('text-preview-work-epoch-completed');
    } else {
      recordTextPreviewCounter('text-preview-work-epoch-started', { targetCount: tasks.size });
    }
  }, [recordTextPreviewCounter, tasks]);

  useEffect(() => {
    if (interactionActiveRef.current || availabilityInFlightRef.current) {
      return;
    }
    const checking = orderedTasks.filter((task) => task.state === 'checking');
    if (checking.length === 0) {
      return;
    }
    const request: CanvasTextPreviewAvailabilityRequest = {
      epoch: runtimeEpochRef.current
    };
    availabilityInFlightRef.current = request;
    recordTextPreviewCounter('text-preview-source-check-requested', { count: checking.length });
    void actions.readCanvasTextPreviewSources({
      sources: checking.map(canvasTextPreviewSourceTargetForApi)
    }).then((result) => {
      if (availabilityInFlightRef.current !== request
        || request.epoch !== runtimeEpochRef.current
        || !mountedRef.current) {
        return;
      }
      availabilityInFlightRef.current = undefined;
      const successful: CanvasTextPreviewTask[] = [];
      for (const target of checking) {
        const currentTask = tasksRef.current.get(target.projectRelativePath);
        if (currentTask?.attempt !== target.attempt || currentTask.state !== 'checking') {
          continue;
        }
        const source = result.sources[target.projectRelativePath];
        if (!source || source.status === 'error') {
          setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
            'source_availability_failed',
            canvasTextPreviewFailureFieldsForTarget(target),
            source && 'message' in source
              ? source.message
              : `Canvas text preview source response is missing ${target.projectRelativePath}.`
          ));
          continue;
        }
        successful.push(target);
        recordTextPreviewCounter('text-preview-source-availability-resolved', {
          projectRelativePath: target.projectRelativePath,
          targetIdentity: target.targetIdentity,
          available: source.status === 'available'
        });
      }
      const currentAvailability = sourceAvailabilityRef.current;
      const nextAvailability = canvasTextPreviewSourcesWithAvailability({
        current: currentAvailability,
        targets: successful,
        sources: result.sources
      });
      sourceAvailabilityRef.current = nextAvailability;
      markChangedNodeRecords(currentAvailability, nextAvailability);
      setSourceAvailability(nextAvailability);
      updateTasks((current) => {
        let next = current;
        for (const target of successful) {
          const source = result.sources[target.projectRelativePath];
          if (!source || source.status === 'error') {
            continue;
          }
          next = source.status === 'available'
            ? withoutCanvasTextPreviewTask(next, target)
            : updateCanvasTextPreviewTask(next, target, { state: 'needs-content' });
        }
        return next;
      });
      setAvailabilitySettlementVersion((current) => current + 1);
    }, (error: unknown) => {
      if (availabilityInFlightRef.current !== request
        || request.epoch !== runtimeEpochRef.current
        || !mountedRef.current) {
        return;
      }
      availabilityInFlightRef.current = undefined;
      for (const target of checking) {
        const currentTask = tasksRef.current.get(target.projectRelativePath);
        if (currentTask?.attempt !== target.attempt || currentTask.state !== 'checking') {
          continue;
        }
        setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
          'source_availability_failed',
          canvasTextPreviewFailureFieldsForTarget(target),
          error
        ));
      }
      setAvailabilitySettlementVersion((current) => current + 1);
    });
  }, [
    actions,
    availabilitySettlementVersion,
    interactionResumeVersion,
    markChangedNodeRecords,
    orderedTasks,
    recordTextPreviewCounter,
    setCurrentPreviewFailure,
    updateTasks
  ]);

  useEffect(() => {
    if (interactionActiveRef.current) {
      return;
    }
    const allocated = orderedTasks.filter(canvasTextPreviewTaskHoldsContent);
    const selected = canvasTextPreviewContentWindow({
      orderedTasks,
      allocatedTasks: allocated
    });
    if (selected.length === 0) {
      return;
    }
    const reusable = selected.flatMap((task) => {
      const buffer = textFileBuffers[task.projectRelativePath];
      const resolution = targetResolutionsRef.current.get(task.projectRelativePath);
      return buffer && canvasTextPreviewBufferMatchesTarget(buffer, task, resolution)
        ? [{ task, buffer }]
        : [];
    });
    if (reusable.length > 0) {
      updateTasks((current) => {
        let next = current;
        for (const { task, buffer } of reusable) {
          next = updateCanvasTextPreviewTask(next, task, {
            state: 'ready',
            content: buffer.content,
            contentBytes: task.estimatedBytes
          });
        }
        return next;
      });
    }
    let availableReadSlots = CANVAS_TEXT_PREVIEW_CONTENT_MAX_CONCURRENT_READS - contentReadsRef.current.size;
    for (const task of selected) {
      if (
        availableReadSlots <= 0
        || reusable.some((item) => item.task === task)
        || contentReadIdByPathRef.current.has(task.projectRelativePath)
      ) {
        continue;
      }
      availableReadSlots -= 1;
      const readId = nextContentReadIdRef.current + 1;
      nextContentReadIdRef.current = readId;
      contentReadsRef.current.add(readId);
      contentReadIdByPathRef.current.set(task.projectRelativePath, readId);
      updateTasks((current) => updateCanvasTextPreviewTask(current, task, { state: 'reading' }));
      recordTextPreviewCounter('text-preview-content-read-started', {
        projectRelativePath: task.projectRelativePath,
        estimatedBytes: task.estimatedBytes,
        inFlight: contentReadsRef.current.size
      });
      const releaseRead = (): boolean => {
        if (!contentReadsRef.current.delete(readId)) {
          return false;
        }
        if (contentReadIdByPathRef.current.get(task.projectRelativePath) === readId) {
          contentReadIdByPathRef.current.delete(task.projectRelativePath);
        }
        if (mountedRef.current) {
          setContentReadSettlementVersion((current) => current + 1);
        }
        return true;
      };
      void actions.readProjectTextFile(task.projectRelativePath).then((file) => {
        if (!releaseRead()) {
          return;
        }
        const current = tasksRef.current.get(task.projectRelativePath);
        if (!current || current.attempt !== task.attempt || current.state !== 'reading') {
          return;
        }
        if (file.revision !== task.contentDigest || file.language !== task.language) {
          updateTasks((registry) => updateCanvasTextPreviewTask(registry, task, {
            state: 'waiting-projection',
            content: undefined,
            contentBytes: undefined
          }));
          return;
        }
        updateTasks((registry) => updateCanvasTextPreviewTask(registry, task, {
          state: 'ready',
          content: file.content,
          contentBytes: file.size
        }));
        recordTextPreviewCounter('text-preview-content-read-completed', {
          projectRelativePath: task.projectRelativePath,
          bytes: file.size,
          inFlight: contentReadsRef.current.size
        });
      }, (error: unknown) => {
        if (!releaseRead()) {
          return;
        }
        setCurrentPreviewFailure(task, canvasTextPreviewFailureFromUnknown(
          'content_read_failed',
          canvasTextPreviewFailureFieldsForTarget(task),
          error
        ));
      });
    }
  }, [actions, contentReadSettlementVersion, interactionResumeVersion, orderedTasks, recordTextPreviewCounter, setCurrentPreviewFailure, tasks, textFileBuffers, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || coverageJobRef.current) {
      return;
    }
    const uncovered = orderedTasks.filter((task) => task.state === 'ready' && task.content !== undefined);
    if (uncovered.length === 0) {
      return;
    }
    const abortController = new AbortController();
    const job: CanvasTextPreviewCoverageJob = { abortController };
    coverageJobRef.current = job;
    void collectCanvasTextPreviewCoverage(
      uncovered.map((task) => task.content!),
      {
        signal: abortController.signal,
        isInteractionActive: () => interactionActiveRef.current
      }
    ).then((coverage) => {
      if (coverageJobRef.current !== job || !mountedRef.current) {
        return;
      }
      coverageJobRef.current = undefined;
      epochCoverageRef.current = mergeCanvasTextPreviewCoverage(epochCoverageRef.current, coverage.codepoints);
      updateTasks((current) => {
        let next = current;
        for (const task of uncovered) {
          const currentTask = next.get(task.projectRelativePath);
          if (currentTask === task) {
            next = updateCanvasTextPreviewTask(next, task, {
              state: 'waiting-font',
              coverage: coverage.codepoints
            });
          }
        }
        return next;
      });
      recordTextPreviewCounter('text-preview-font-coverage-collected', {
        targetCount: uncovered.length,
        codepointCount: coverage.codepoints.length,
        durationMs: coverage.durationMs,
        activeScanDurationMs: coverage.activeScanDurationMs,
        maxSynchronousSliceMs: coverage.maxSynchronousSliceMs
      });
    }).catch((error: unknown) => {
      if (abortController.signal.aborted || coverageJobRef.current !== job) {
        return;
      }
      coverageJobRef.current = undefined;
      for (const task of uncovered) {
        setCurrentPreviewFailure(task, canvasTextPreviewFailureFromUnknown(
          'font_prepare_failed',
          canvasTextPreviewFailureFieldsForTarget(task),
          error
        ));
      }
    });
  }, [interactionResumeVersion, orderedTasks, recordTextPreviewCounter, setCurrentPreviewFailure, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || fontBuildRef.current || fontCandidate) {
      return;
    }
    const waitingTasks = orderedTasks.filter((task) => task.state === 'waiting-font'
      && task.coverage
      && !canvasTextPreviewCoverageContains(activeFontCoverageRef.current, task.coverage));
    if (waitingTasks.length === 0 || epochCoverageRef.current.length === 0) {
      return;
    }
    const abortController = new AbortController();
    const coverage = epochCoverageRef.current.slice();
    const build: CanvasTextPreviewFontBuild = {
      abortController,
      coverage,
      attempts: new Map(waitingTasks.map((task) => [task.projectRelativePath, task.attempt]))
    };
    fontBuildRef.current = build;
    void previewFontSession.prepareCoverage(coverage, abortController.signal).then((preparation) => {
      if (fontBuildRef.current !== build || !mountedRef.current) {
        preparation.discard();
        return;
      }
      fontBuildRef.current = undefined;
      const nextCandidate = { coverage, preparation };
      fontCandidateRef.current = nextCandidate;
      setFontCandidate(nextCandidate);
    }).catch((error: unknown) => {
      if (abortController.signal.aborted || fontBuildRef.current !== build) {
        return;
      }
      fontBuildRef.current = undefined;
      for (const task of tasksRef.current.values()) {
        if (task.state === 'waiting-font'
          && build.attempts.get(task.projectRelativePath) === task.attempt) {
          setCurrentPreviewFailure(task, canvasTextPreviewFailureFromUnknown(
            'font_prepare_failed',
            canvasTextPreviewFailureFieldsForTarget(task),
            error
          ));
        }
      }
    });
  }, [fontCandidate, interactionResumeVersion, orderedTasks, previewFontSession, setCurrentPreviewFailure]);

  useEffect(() => {
    if (!fontCandidate) {
      return;
    }
    const candidateStillUseful = orderedTasks.some((task) => task.state === 'waiting-font'
      && task.coverage
      && canvasTextPreviewCoverageContains(fontCandidate.coverage, task.coverage));
    if (!candidateStillUseful) {
      fontCandidate.preparation.discard();
      fontCandidateRef.current = undefined;
      setFontCandidate(undefined);
    }
  }, [fontCandidate, orderedTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || executingTask) {
      return;
    }
    let preparedFont = activePreparedFont;
    let activeCoverage = activeFontCoverageRef.current;
    let candidate = fontCandidate;
    const firstRunnable = orderedTasks.find((task) => {
      if (task.state !== 'waiting-font' || !task.content || !task.coverage) {
        return false;
      }
      return Boolean(preparedFont && canvasTextPreviewCoverageContains(activeCoverage, task.coverage))
        || Boolean(candidate && canvasTextPreviewCoverageContains(candidate.coverage, task.coverage));
    });
    if (!firstRunnable?.content || !firstRunnable.coverage) {
      return;
    }
    if ((!preparedFont || !canvasTextPreviewCoverageContains(activeCoverage, firstRunnable.coverage)) && candidate) {
      const candidateToActivate = candidate;
      try {
        preparedFont = candidateToActivate.preparation.activate();
        activeCoverage = candidateToActivate.coverage;
        activeFontCoverageRef.current = candidateToActivate.coverage;
        setActivePreparedFont(preparedFont);
        fontCandidateRef.current = undefined;
        setFontCandidate(undefined);
        candidate = undefined;
      } catch (error) {
        candidateToActivate.preparation.discard();
        fontCandidateRef.current = undefined;
        setFontCandidate(undefined);
        setCurrentPreviewFailure(firstRunnable, canvasTextPreviewFailureFromUnknown(
          'font_prepare_failed',
          canvasTextPreviewFailureFieldsForTarget(firstRunnable),
          error
        ));
        return;
      }
    }
    if (!preparedFont || !canvasTextPreviewCoverageContains(activeCoverage, firstRunnable.coverage)) {
      return;
    }
    updateTasks((current) => updateCanvasTextPreviewTask(current, firstRunnable, { state: 'capturing' }));
  }, [activePreparedFont, executingTask, fontCandidate, interactionResumeVersion, orderedTasks, setCurrentPreviewFailure, updateTasks]);

  const finishExecutingTask = useCallback((target: CanvasTextPreviewTarget) => {
    updateTasks((current) => {
      const withoutExecutor = withoutCanvasTextPreviewTask(current, target);
      const workTargets = Object.values(currentTargetsRef.current).filter((candidate) => (
        candidate.projectRelativePath !== activeInlineTextPathRef.current
      ));
      return reconcileCanvasTextPreviewTasks({
        previous: withoutExecutor,
        targets: workTargets,
        sourceAvailability: sourceAvailabilityRef.current
      });
    });
  }, [updateTasks]);

  const finishRasterizedTarget = useCallback((
    target: CanvasTextPreviewExecutionTarget,
    raster: CanvasTextPreviewCaptureResult
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    const epoch = runtimeEpochRef.current;
    const task = tasksRef.current.get(target.projectRelativePath);
    if (!mountedRef.current
      || epoch !== runtimeEpochRef.current
      || !task
      || task.state !== 'capturing'
      || canvasTextPreviewTargetKey(task) !== targetKey) {
      return;
    }
    updateTasks((current) => updateCanvasTextPreviewTask(current, target, {
      state: 'uploading',
      content: undefined,
      contentBytes: undefined,
      coverage: undefined
    }));
    const startedAt = performance.now();
    recordTextPreviewCounter('text-preview-source-upload-started', {
      projectRelativePath: target.projectRelativePath,
      bytes: raster.sourcePng.size,
      inFlight: 1
    });
    void actions.saveCanvasTextPreviewSource({
      ...canvasTextPreviewSourceTargetForApi(target),
      sourcePng: raster.sourcePng
    }).then(() => {
      if (!mountedRef.current || epoch !== runtimeEpochRef.current) {
        return;
      }
      if (isCurrentTarget(epoch, target)) {
        const current = sourceAvailabilityRef.current;
        const next = {
          ...current,
          [target.projectRelativePath]: { targetKey, available: true }
        };
        sourceAvailabilityRef.current = next;
        markChangedNodeRecords(current, next);
        setSourceAvailability(next);
        clearCurrentPreviewFailure(target);
      }
      finishExecutingTask(target);
      recordTextPreviewCounter('text-preview-source-upload-completed', {
        projectRelativePath: target.projectRelativePath,
        targetIdentity: target.targetIdentity,
        durationMs: performance.now() - startedAt,
        inFlight: 0
      });
    }, (error: unknown) => {
      if (isCurrentTarget(epoch, target)) {
        setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
          'source_upload_failed',
          canvasTextPreviewFailureFieldsForTarget(target),
          error
        ));
      } else if (mountedRef.current && epoch === runtimeEpochRef.current) {
        finishExecutingTask(target);
      }
    });
  }, [
    actions,
    clearCurrentPreviewFailure,
    finishExecutingTask,
    isCurrentTarget,
    markChangedNodeRecords,
    recordTextPreviewCounter,
    setCurrentPreviewFailure,
    updateTasks
  ]);

  const finishFailedTarget = useCallback((
    target: CanvasTextPreviewExecutionTarget,
    failure: CanvasTextPreviewFailure
  ) => {
    if (isCurrentTarget(runtimeEpochRef.current, target)) {
      setCurrentPreviewFailure(target, failure);
    } else {
      finishExecutingTask(target);
    }
  }, [finishExecutingTask, isCurrentTarget, setCurrentPreviewFailure]);

  const currentTargetForRenderedNode = useCallback((node: ProjectedCanvasNode): CanvasTextPreviewTarget | undefined => {
    const styleKey = styleKeyRef.current;
    const target = currentTargetsRef.current[node.projectRelativePath];
    const resolution = targetResolutionsRef.current.get(node.projectRelativePath);
    if (!styleKey || !target || resolution?.target !== target) {
      return undefined;
    }
    const renderedInput = canvasTextPreviewTargetInput({
      node,
      buffer: textFileBuffersRef.current[node.projectRelativePath],
      styleKey
    });
    return renderedInput && canvasTextPreviewTargetInputsEqual(resolution.input, renderedInput)
      ? target
      : undefined;
  }, []);

  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasTextPreviewNodeSnapshot => {
    const target = currentTargetForRenderedNode(node);
    let request: CanvasRasterPreviewRequest = {};
    let previewError: string | undefined;
    if (target) {
      const targetKey = canvasTextPreviewTargetKey(target);
      const availability = sourceAvailabilityRef.current[node.projectRelativePath];
      request = canvasTextRasterPreviewRequest({
        target,
        available: availability?.targetKey === targetKey && availability.available
      });
      const error = previewErrorsRef.current[node.projectRelativePath];
      if (error?.targetKey === targetKey) {
        previewError = error.error.message;
      }
    }
    return { request, previewError };
  }, [currentTargetForRenderedNode]);

  const nodeSnapshotStore = useMemo(() => createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: sameCanvasTextPreviewNodeSnapshot
  }), [deriveNodeSnapshot]);

  const acceptNode = useCallback((node: ProjectedCanvasNode) => {
    const styleKey = styleKeyRef.current;
    if (!styleKey) {
      return;
    }
    const path = node.projectRelativePath;
    const input = path === activeInlineTextPathRef.current
      ? undefined
      : canvasTextPreviewTargetInput({
        node,
        buffer: textFileBuffersRef.current[path],
        styleKey
      });
    const previous = targetResolutionsRef.current.get(path);
    if (!input) {
      if (!previous) {
        return;
      }
      const nextResolutions = new Map(targetResolutionsRef.current);
      nextResolutions.delete(path);
      targetResolutionsRef.current = nextResolutions;
      currentTargetKeysRef.current.delete(path);
      delete currentTargetsRef.current[path];
      if (path in sourceAvailabilityRef.current) {
        const nextAvailability = withoutRecordPath(sourceAvailabilityRef.current, path);
        sourceAvailabilityRef.current = nextAvailability;
        setSourceAvailability(nextAvailability);
      }
      if (path in previewErrorsRef.current) {
        const nextErrors = withoutRecordPath(previewErrorsRef.current, path);
        previewErrorsRef.current = nextErrors;
        setPreviewErrors(nextErrors);
      }
      updateTasks((current) => {
        if (!current.has(path)) {
          return current;
        }
        const next = new Map(current);
        next.delete(path);
        return next;
      });
      previewResourceScheduler.cancel('text', path);
      nodeSnapshotStore.flush(new Set([path]));
      return;
    }
    if (previous && canvasTextPreviewTargetInputsEqual(previous.input, input)) {
      return;
    }
    const resolution = beginTargetResolution(input);
    targetResolutionsRef.current = new Map(targetResolutionsRef.current).set(path, resolution);
    void resolution.pending.then((target) => {
      if (!mountedRef.current || targetResolutionsRef.current.get(path) !== resolution) {
        return;
      }
      const targetKey = canvasTextPreviewTargetKey(target);
      currentTargetKeysRef.current.set(path, targetKey);
      currentTargetsRef.current[path] = target;
      const availability = sourceAvailabilityRef.current[path];
      if (availability && availability.targetKey !== targetKey) {
        const nextAvailability = withoutRecordPath(sourceAvailabilityRef.current, path);
        sourceAvailabilityRef.current = nextAvailability;
        setSourceAvailability(nextAvailability);
      }
      const previewError = previewErrorsRef.current[path];
      if (previewError && previewError.targetKey !== targetKey) {
        const nextErrors = withoutRecordPath(previewErrorsRef.current, path);
        previewErrorsRef.current = nextErrors;
        setPreviewErrors(nextErrors);
      }
      updateTasks((current) => reconcileCanvasTextPreviewTarget({
        previous: current,
        target,
        active: activeInlineTextPathRef.current === path,
        availability: sourceAvailabilityRef.current[path]
      }));
      nodeSnapshotStore.flush(new Set([path]));
    });
  }, [beginTargetResolution, nodeSnapshotStore, previewResourceScheduler, updateTasks]);

  const commandHandlersRef = useRef({ retryPreview, acceptNode });
  commandHandlersRef.current = { retryPreview, acceptNode };

  useLayoutEffect(() => {
    const changedPaths = new Set(changedNodePathsRef.current);
    changedNodePathsRef.current.clear();
    nodeSnapshotStore.flush(changedPaths);
  });

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    retryPreview: (...args) => commandHandlersRef.current.retryPreview(...args),
    acceptNode: (...args) => commandHandlersRef.current.acceptNode(...args),
    getNodeSnapshot: nodeSnapshotStore.getSnapshot,
    subscribeNode: nodeSnapshotStore.subscribe
  }), [nodeSnapshotStore]);

  const captureLayer = (
    <CanvasTextPreviewCaptureLane
      target={captureTarget}
      renderProfile={renderProfile}
      preparedFont={activePreparedFont}
      interactionSource={previewResourceScheduler}
      perfMonitor={perfMonitor}
      onRasterized={finishRasterizedTarget}
      onFailure={finishFailedTarget}
    />
  );

  return (
    <CanvasTextPreviewRuntimeContext.Provider value={value}>
      {children}
      {captureLayerRoot ? createPortal(captureLayer, captureLayerRoot) : null}
    </CanvasTextPreviewRuntimeContext.Provider>
  );
}

function isStableCanvasTextNode(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'file'
    && node.mediaKind === 'text'
    && node.availability.state === 'available'
    && node.textLanguage !== undefined;
}

function canvasTextPreviewTargetInput(input: {
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  styleKey: string;
}): CanvasTextPreviewTargetInput | undefined {
  const { node, buffer } = input;
  if (!isStableCanvasTextNode(node) || node.availability.state !== 'available' || !node.textLanguage) {
    return undefined;
  }
  const geometry = canvasTextPresentationGeometry(node);
  return {
    bindingId: canvasRawFileBindingId(node.availability.fileUrl),
    projectRelativePath: node.projectRelativePath,
    ...(buffer?.dirty
      ? { dirtyContent: buffer.content }
      : { contentDigest: node.availability.revision }),
    estimatedBytes: buffer?.dirty ? 0 : node.availability.size,
    language: buffer?.dirty ? buffer.language : node.textLanguage,
    wordWrap: buffer?.wordWrap ?? false,
    contentCssWidth: geometry.contentCssWidth,
    contentCssHeight: geometry.contentCssHeight,
    scrollTop: node.textViewport?.scrollTop ?? 0,
    scrollLeft: node.textViewport?.scrollLeft ?? 0,
    styleKey: input.styleKey
  };
}

async function resolveCanvasTextPreviewTarget(
  targetInput: CanvasTextPreviewTargetInput
): Promise<CanvasTextPreviewTarget> {
  const dirtyIdentity = targetInput.dirtyContent === undefined
    ? undefined
    : await canvasTextContentIdentity(targetInput.dirtyContent);
  const contentDigest = targetInput.contentDigest ?? dirtyIdentity!.digest;
  const sourceSize = canvasTextPreviewSourceSize(targetInput);
  const candidate: CanvasTextPreviewCandidate = {
    bindingId: targetInput.bindingId,
    projectRelativePath: targetInput.projectRelativePath,
    contentDigest,
    estimatedBytes: dirtyIdentity?.bytes ?? targetInput.estimatedBytes,
    language: targetInput.language,
    wordWrap: targetInput.wordWrap,
    contentCssWidth: targetInput.contentCssWidth,
    contentCssHeight: targetInput.contentCssHeight,
    scrollTop: targetInput.scrollTop,
    scrollLeft: targetInput.scrollLeft,
    styleKey: targetInput.styleKey,
    ...sourceSize
  };
  return { ...candidate, targetIdentity: await canvasTextPreviewTargetIdentity(candidate) };
}

async function canvasTextContentIdentity(content: string): Promise<{ digest: string; bytes: number }> {
  const encoded = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return {
    digest: `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    bytes: encoded.byteLength
  };
}

function canvasTextPreviewTargetInputsEqual(
  left: CanvasTextPreviewTargetInput,
  right: CanvasTextPreviewTargetInput
): boolean {
  return left.bindingId === right.bindingId
    && left.projectRelativePath === right.projectRelativePath
    && left.contentDigest === right.contentDigest
    && left.dirtyContent === right.dirtyContent
    && left.estimatedBytes === right.estimatedBytes
    && left.language === right.language
    && left.wordWrap === right.wordWrap
    && left.contentCssWidth === right.contentCssWidth
    && left.contentCssHeight === right.contentCssHeight
    && left.scrollTop === right.scrollTop
    && left.scrollLeft === right.scrollLeft
    && left.styleKey === right.styleKey;
}

function orderCanvasTextPreviewTasks(input: {
  tasks: ReadonlyMap<string, CanvasTextPreviewTask>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasTextPreviewTask[] {
  return orderCanvasPreviewItemsByNode({
    items: [...input.tasks.values()],
    nodesByPath: input.nodesByPath,
    visibleRect: input.visibleRect
  });
}

function reconcileCanvasTextPreviewTarget(input: {
  previous: Map<string, CanvasTextPreviewTask>;
  target: CanvasTextPreviewTarget;
  active: boolean;
  availability: CanvasTextPreviewSourceAvailability | undefined;
}): Map<string, CanvasTextPreviewTask> {
  const path = input.target.projectRelativePath;
  const targetKey = canvasTextPreviewTargetKey(input.target);
  if (input.active || (input.availability?.targetKey === targetKey && input.availability.available)) {
    if (!input.previous.has(path)) {
      return input.previous;
    }
    const next = new Map(input.previous);
    next.delete(path);
    return next;
  }
  const existing = input.previous.get(path);
  if (existing && canvasTextPreviewTargetKey(existing) === targetKey) {
    if (input.availability?.targetKey === targetKey
      && !input.availability.available
      && existing.state === 'checking') {
      const next = new Map(input.previous);
      next.set(path, { ...existing, state: 'needs-content' });
      return next;
    }
    return input.previous;
  }
  return new Map(input.previous).set(path, {
    ...input.target,
    attempt: {},
    state: input.availability?.targetKey === targetKey ? 'needs-content' : 'checking'
  });
}

function updateCanvasTextPreviewTask(
  current: Map<string, CanvasTextPreviewTask>,
  target: CanvasTextPreviewTarget | CanvasTextPreviewTask,
  patch: Partial<CanvasTextPreviewTask>
): Map<string, CanvasTextPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing
    || canvasTextPreviewTargetKey(existing) !== canvasTextPreviewTargetKey(target)
    || ('attempt' in target && existing.attempt !== target.attempt)) {
    return current;
  }
  const next = new Map(current);
  next.set(target.projectRelativePath, { ...existing, ...patch });
  return next;
}

function withoutCanvasTextPreviewTask(
  current: Map<string, CanvasTextPreviewTask>,
  target: CanvasTextPreviewTarget | CanvasTextPreviewTask
): Map<string, CanvasTextPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing
    || canvasTextPreviewTargetKey(existing) !== canvasTextPreviewTargetKey(target)
    || ('attempt' in target && existing.attempt !== target.attempt)) {
    return current;
  }
  const next = new Map(current);
  next.delete(target.projectRelativePath);
  return next;
}

function resetCanvasTextPreviewCapturingTasks(
  current: Map<string, CanvasTextPreviewTask>
): Map<string, CanvasTextPreviewTask> {
  let next = current;
  for (const task of current.values()) {
    if (task.state !== 'capturing') {
      continue;
    }
    if (next === current) {
      next = new Map(current);
    }
    next.set(task.projectRelativePath, {
      ...task,
      state: task.coverage ? 'waiting-font' : 'ready'
    });
  }
  return next;
}

function canvasTextPreviewBufferMatchesTarget(
  buffer: TextFileBuffer,
  target: CanvasTextPreviewTarget,
  resolution: CanvasTextPreviewTargetResolution | undefined
): boolean {
  if (
    buffer.error
    || buffer.language !== target.language
    || !resolution?.target
    || canvasTextPreviewTargetKey(resolution.target) !== canvasTextPreviewTargetKey(target)
  ) {
    return false;
  }
  return buffer.dirty
    ? resolution.input.dirtyContent === buffer.content
    : buffer.baseRevision === target.contentDigest;
}

export function canvasTextRasterPreviewRequest(input: {
  target: CanvasTextPreviewTarget;
  available: boolean;
}): CanvasRasterPreviewRequest {
  const { target } = input;
  const continuityKey = canvasPreviewContinuityKey({
    mediaKind: 'text',
    bindingId: target.bindingId,
    projectRelativePath: target.projectRelativePath,
    continuityIdentity: target.targetIdentity
  });
  if (!input.available) {
    return { continuityKey };
  }
  return {
    continuityKey,
    variantTarget: {
      mediaKind: 'text',
      bindingId: target.bindingId,
      projectRelativePath: target.projectRelativePath,
      targetIdentity: target.targetIdentity,
      sourceWidth: target.sourcePixelWidth,
      srcForWidth: (width) => {
        const params = new URLSearchParams({
          path: target.projectRelativePath,
          targetIdentity: target.targetIdentity,
          w: String(width)
        });
        return `/api/workbench/bindings/${target.bindingId}/canvas-text-preview?${params.toString()}`;
      }
    }
  };
}

function canvasTextPreviewSourcesWithAvailability(input: {
  current: Record<string, CanvasTextPreviewSourceAvailability>;
  targets: CanvasTextPreviewTarget[];
  sources: Record<string, {
    targetIdentity: string;
    status: 'available' | 'missing' | 'error';
  }>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  let next = input.current;
  for (const target of input.targets) {
    const source = input.sources[target.projectRelativePath];
    if (!source || source.status === 'error') {
      continue;
    }
    const availability = {
      targetKey: canvasTextPreviewTargetKey(target),
      available: source.status === 'available'
    };
    const existing = next[target.projectRelativePath];
    if (existing?.targetKey === availability.targetKey && existing.available === availability.available) {
      continue;
    }
    next = next === input.current ? { ...input.current } : next;
    next[target.projectRelativePath] = availability;
  }
  return next;
}

function canvasTextPreviewCurrentSourceAvailability(input: {
  targets: CanvasTextPreviewTarget[];
  sourceAvailability: Record<string, CanvasTextPreviewSourceAvailability>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  const targetKeys = new Map(input.targets.map((target) => [target.projectRelativePath, canvasTextPreviewTargetKey(target)]));
  return Object.fromEntries(Object.entries(input.sourceAvailability).filter(([path, availability]) => (
    targetKeys.get(path) === availability.targetKey
  )));
}

function canvasTextPreviewSourceTargetForApi(target: CanvasTextPreviewTarget) {
  return { projectRelativePath: target.projectRelativePath, targetIdentity: target.targetIdentity };
}

function sameCanvasTextPreviewNodeSnapshot(
  left: CanvasTextPreviewNodeSnapshot,
  right: CanvasTextPreviewNodeSnapshot
): boolean {
  return sameCanvasRasterPreviewRequest(left.request, right.request)
    && left.previewError === right.previewError;
}

function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error instanceof Event) {
    return new Error(`Browser event: ${error.type || 'unknown'}.`);
  }
  return new Error(typeof error === 'string' && error.trim() !== '' ? error : 'Canvas text preview operation failed.');
}

function withoutRecordPath<T>(current: Record<string, T>, path: string): Record<string, T> {
  if (!(path in current)) {
    return current;
  }
  const next = { ...current };
  delete next[path];
  return next;
}
