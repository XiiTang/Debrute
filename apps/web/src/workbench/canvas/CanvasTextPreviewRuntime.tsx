import React, {
  createContext,
  startTransition,
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
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types.js';
import {
  canvasTextPreviewFingerprint,
  canvasTextPreviewSourceSize,
  type CanvasTextPreviewCandidate,
  type CanvasTextPreviewCaptureResult,
  type CanvasTextPreviewCaptureTarget,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture.js';
import { CanvasTextPreviewCaptureLane } from './CanvasTextPreviewCaptureLane.js';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure.js';
import type { CanvasTextPreviewPresentation } from './CanvasTextPreviewImageHandoff.js';
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
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  canvasChangedRecordPaths,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';
import { canvasRawFileProjectId } from './canvasRawFileUrls.js';
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
  canvasTextPreviewTaskHoldsContent,
  reconcileCanvasTextPreviewTasks,
  type CanvasTextPreviewTask
} from './CanvasTextPreviewTaskRegistry.js';
import { orderCanvasPreviewTasks } from './CanvasPreviewScheduling.js';
import { canvasTextPresentationGeometry } from './CanvasTextPresentationGeometry.js';
import { useCanvasPreviewInteractionGate } from './useCanvasPreviewInteractionGate.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';

export interface CanvasTextPreviewSource {
  projectRelativePath: string;
  sourceKey: string;
  src: string;
  previewWidth: number;
  fingerprint: string;
}

export interface CanvasTextPreviewSourceAvailability {
  fingerprint: string;
  available: boolean;
}

interface CanvasTextPreviewLayerState {
  targetKey: string;
  sourceKey: string;
  source: CanvasTextPreviewSource;
  committed: boolean;
}

interface CanvasTextPreviewPresentationState {
  visible?: CanvasTextPreviewLayerState | undefined;
  pending?: CanvasTextPreviewLayerState | undefined;
}

interface CanvasTextPreviewPresentationWork extends CanvasTextPreviewLayerState {
  epoch: number;
}

const CANVAS_TEXT_PREVIEW_PUBLICATION_PHASES = ['mount', 'promote', 'commit'] as const;
type CanvasTextPreviewPublicationPhase = typeof CANVAS_TEXT_PREVIEW_PUBLICATION_PHASES[number];
type CanvasTextPreviewPresentationQueues = Record<
  CanvasTextPreviewPublicationPhase,
  Map<string, CanvasTextPreviewPresentationWork>
>;

interface CanvasTextPreviewErrorState {
  targetKey: string;
  sourceKey?: string | undefined;
  error: Error;
}

interface CanvasTextPreviewAvailabilityRequest {
  epoch: number;
  targetKeys: ReadonlySet<string>;
}

interface CanvasTextPreviewTargetInput {
  readonly canvasId: string;
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

interface CanvasTextPreviewCoverageJob {
  readonly abortController: AbortController;
  readonly targetKeys: ReadonlyMap<string, string>;
}

interface CanvasTextPreviewFontBuild {
  readonly abortController: AbortController;
  readonly coverage: Uint32Array;
}

interface CanvasTextPreviewFontCandidate {
  readonly coverage: Uint32Array;
  readonly preparation: CanvasTextPreviewFontPreparation;
}

export interface CanvasTextPreviewRuntimeValue {
  retryPreview(projectRelativePath: string): void;
  reportPendingReady(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
  reportPendingFailure(node: ProjectedCanvasNode, source: CanvasTextPreviewSource, error: unknown): void;
  reportVisibleFailure(node: ProjectedCanvasNode, source: CanvasTextPreviewSource, error: unknown): void;
  reportVisibleCommitted(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
  getNodeSnapshot(node: ProjectedCanvasNode): CanvasTextPreviewNodeSnapshot;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export interface CanvasTextPreviewNodeSnapshot {
  readonly presentation: CanvasTextPreviewPresentation;
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
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeNode(node, listener),
    [node, runtime]
  );
  const getSnapshot = useCallback(() => runtime.getNodeSnapshot(node), [node, runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function CanvasTextPreviewProvider({
  canvasId,
  nodes,
  activeInlineTextPath,
  textFileBuffers,
  actions,
  resourceZoom,
  devicePixelRatio,
  previewOrder,
  styleDependencyKey,
  perfMonitor,
  previewResourceScheduler,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeInlineTextPath?: string | undefined;
  textFileBuffers: Record<string, TextFileBuffer>;
  actions: WorkbenchActions;
  resourceZoom: number;
  devicePixelRatio: number;
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
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasTextPreviewTarget>>({});
  const [tasks, setTasks] = useState<Map<string, CanvasTextPreviewTask>>(() => new Map());
  const [contentReadSettlementVersion, setContentReadSettlementVersion] = useState(0);
  const [previewPresentations, setPreviewPresentations] = useState<Record<string, CanvasTextPreviewPresentationState>>({});
  const [styleKeyState, setStyleKeyState] = useState<{ key?: string; error?: Error }>({});
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentTargetsRef = useRef<Record<string, CanvasTextPreviewTarget>>({});
  const targetResolutionsRef = useRef(new Map<string, CanvasTextPreviewTargetResolution>());
  const targetGenerationRef = useRef(0);
  const tasksRef = useRef(tasks);
  const sourceAvailabilityRef = useRef(sourceAvailability);
  const previewPresentationsRef = useRef(previewPresentations);
  const previewErrorsRef = useRef(previewErrors);
  const changedNodePathsRef = useRef(new Set<string>());
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const currentCanvasIdRef = useRef(canvasId);
  const textFileBuffersRef = useRef(textFileBuffers);
  const styleKeyRef = useRef(styleKeyState.key);
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const activeInlineTextPathRef = useRef(activeInlineTextPath);
  const runtimeEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const availabilityInFlightRef = useRef<CanvasTextPreviewAvailabilityRequest | undefined>(undefined);
  const sourceCheckedTargetKeysRef = useRef(new Map<string, string>());
  const contentReadsRef = useRef(new Set<number>());
  const contentReadIdByPathRef = useRef(new Map<string, number>());
  const nextContentReadIdRef = useRef(0);
  const coverageJobRef = useRef<CanvasTextPreviewCoverageJob | undefined>(undefined);
  const fontBuildRef = useRef<CanvasTextPreviewFontBuild | undefined>(undefined);
  const fontCandidateRef = useRef<CanvasTextPreviewFontCandidate | undefined>(fontCandidate);
  const activeFontCoverageRef = useRef<Uint32Array>(new Uint32Array());
  const epochCoverageRef = useRef<Uint32Array>(new Uint32Array());
  const registryWasEmptyRef = useRef(true);
  const uploadingTargetKeysRef = useRef(new Set<string>());
  const presentationQueuesRef = useRef<CanvasTextPreviewPresentationQueues>({
    mount: new Map(),
    promote: new Map(),
    commit: new Map()
  });
  const publishingSourceKeysRef = useRef(new Set<string>());
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
  const setCurrentResourceKey = useCallback((path: string, sourceKey: string | undefined) => {
    if (currentResourceKeysRef.current.get(path) === sourceKey) {
      return;
    }
    if (sourceKey === undefined) {
      currentResourceKeysRef.current.delete(path);
    } else {
      currentResourceKeysRef.current.set(path, sourceKey);
    }
    changedNodePathsRef.current.add(path);
  }, []);

  currentCanvasIdRef.current = canvasId;
  textFileBuffersRef.current = textFileBuffers;
  styleKeyRef.current = styleKeyState.key;
  activeInlineTextPathRef.current = activeInlineTextPath;
  currentTargetsRef.current = currentTargets;
  tasksRef.current = tasks;
  sourceAvailabilityRef.current = sourceAvailability;
  previewPresentationsRef.current = previewPresentations;
  previewErrorsRef.current = previewErrors;
  fontCandidateRef.current = fontCandidate;

  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  const orderedTasks = useMemo(() => orderCanvasTextPreviewTasks({
    tasks,
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [nodesByPath, previewOrderSnapshot, tasks]);
  const orderedCurrentTargets = useMemo(() => orderCanvasTextPreviewTargets({
    targets: Object.values(currentTargets),
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [currentTargets, nodesByPath, previewOrderSnapshot]);
  const captureTask = orderedTasks.find((task) => task.state === 'capturing' && task.content !== undefined);
  const captureTarget = useMemo<CanvasTextPreviewCaptureTarget | undefined>(() => (
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

  const updateTasks = useCallback((
    update: (current: Map<string, CanvasTextPreviewTask>) => Map<string, CanvasTextPreviewTask>
  ) => {
    setTasks((current) => {
      const next = update(current);
      tasksRef.current = next;
      return next;
    });
  }, []);

  const isCurrentTarget = useCallback((epoch: number, target: CanvasTextPreviewTarget): boolean => (
    mountedRef.current
    && epoch === runtimeEpochRef.current
    && target.canvasId === currentCanvasIdRef.current
    && currentTargetKeysRef.current.get(target.projectRelativePath) === canvasTextPreviewTargetKey(target)
  ), []);

  const setCurrentPreviewFailure = useCallback((
    target: CanvasTextPreviewTarget,
    error: CanvasTextPreviewFailure,
    sourceKey?: string
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    if (currentTargetKeysRef.current.get(target.projectRelativePath) !== targetKey) {
      return;
    }
    setPreviewErrors((current) => {
      markNodePathChanged(target.projectRelativePath);
      return {
        ...current,
        [target.projectRelativePath]: { targetKey, sourceKey, error }
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
      fingerprint: target.fingerprint,
      stage: error.stage,
      message: error.message
    });
  }, [markNodePathChanged, recordTextPreviewCounter, updateTasks]);

  const clearCurrentPreviewFailure = useCallback((target: CanvasTextPreviewTarget, sourceKey?: string) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    setPreviewErrors((current) => {
      const existing = current[target.projectRelativePath];
      if (!existing
        || existing.targetKey !== targetKey
        || (sourceKey !== undefined && existing.sourceKey !== undefined && existing.sourceKey !== sourceKey)) {
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
    sourceCheckedTargetKeysRef.current.delete(projectRelativePath);
    setSourceAvailability((current) => {
      const next = withoutRecordPath(current, projectRelativePath);
      sourceAvailabilityRef.current = next;
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
        return updateCanvasTextPreviewTask(current, target, checking);
      }
      return new Map(current).set(projectRelativePath, { ...target, ...checking });
    });
  }, [markNodePathChanged, updateTasks]);

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
      sourceCheckedTargetKeysRef.current.clear();
      uploadingTargetKeysRef.current.clear();
      for (const path of currentTargetKeysRef.current.keys()) {
        previewResourceScheduler.cancel('text', path);
      }
      for (const queue of Object.values(presentationQueuesRef.current)) {
        queue.clear();
      }
      publishingSourceKeysRef.current.clear();
    };
  }, [canvasId, previewResourceScheduler]);

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
    const generation = targetGenerationRef.current + 1;
    targetGenerationRef.current = generation;
    const previous = targetResolutionsRef.current;
    const next = new Map<string, CanvasTextPreviewTargetResolution>();
    for (const node of nodes) {
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
        canvasId,
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
      const resolution: CanvasTextPreviewTargetResolution = {
        input: targetInput,
        pending: resolveCanvasTextPreviewTarget(targetInput).then((target) => {
          resolution.target = target;
          recordTextPreviewCounter('text-preview-target-fingerprint-computed', {
            projectRelativePath: target.projectRelativePath,
            fingerprint: target.fingerprint,
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
          return target;
        })
      };
      next.set(path, resolution);
    }
    targetResolutionsRef.current = next;
    commitCanvasTextPreviewTargets({
      targets: [...next.values()].flatMap((resolution) => resolution.target ? [resolution.target] : []),
      activeInlineTextPath,
      currentTargetKeysRef,
      currentTargetsRef,
      setCurrentTargets,
      setSourceAvailability,
      setPreviewPresentations,
      setPreviewErrors,
      markChangedNodeRecords,
      presentationQueues: presentationQueuesRef.current
    });
    void Promise.all([...next.values()].map((resolution) => resolution.pending)).then((resolved) => {
      if (!mountedRef.current
        || generation !== targetGenerationRef.current
        || targetResolutionsRef.current !== next) {
        return;
      }
      commitCanvasTextPreviewTargets({
        targets: resolved,
        activeInlineTextPath,
        currentTargetKeysRef,
        currentTargetsRef,
        setCurrentTargets,
        setSourceAvailability,
        setPreviewPresentations,
        setPreviewErrors,
        markChangedNodeRecords,
        presentationQueues: presentationQueuesRef.current
      });
    });
  }, [activeInlineTextPath, canvasId, markChangedNodeRecords, nodes, recordTextPreviewCounter, styleKeyState.key, textFileBuffers]);

  useEffect(() => {
    const path = activeInlineTextPath;
    if (!path) {
      return;
    }
    previewResourceScheduler.cancel('text', path);
    forEachPresentationQueue(presentationQueuesRef.current, (_phase, queue) => {
      for (const [sourceKey, work] of queue) {
        if (work.source.projectRelativePath === path) {
          queue.delete(sourceKey);
        }
      }
    });
    setPreviewPresentations((current) => {
      const presentation = current[path];
      if (!presentation?.pending) {
        return current;
      }
      markNodePathChanged(path);
      return presentation.visible
        ? { ...current, [path]: { visible: presentation.visible, pending: undefined } }
        : withoutRecordPath(current, path);
    });
    setPreviewErrors((current) => {
      if (!(path in current)) {
        return current;
      }
      markNodePathChanged(path);
      return withoutRecordPath(current, path);
    });
  }, [activeInlineTextPath, markNodePathChanged, previewResourceScheduler]);

  useEffect(() => {
    const workTargets = Object.values(currentTargets).filter((target) => (
      target.projectRelativePath !== activeInlineTextPath
    ));
    updateTasks((current) => reconcileCanvasTextPreviewTasks({
      previous: current,
      targets: workTargets,
      sourceAvailability
    }));
  }, [activeInlineTextPath, currentTargets, sourceAvailability, updateTasks]);

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
      uploadInFlight: uploadingTargetKeysRef.current.size,
      readingPath: taskInState('reading'),
      readyPath: taskInState('ready'),
      waitingFontPath: taskInState('waiting-font'),
      capturingPath: taskInState('capturing'),
      orderedCapturingPath: orderedTasks.find((task) => task.state === 'capturing')?.projectRelativePath,
      uploadingPath: taskInState('uploading')
    });
  }, [orderedTasks, recordTextPreviewCounter, tasks]);

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
    const checking = orderedTasks.filter((task) => (
      task.state === 'checking'
      && sourceCheckedTargetKeysRef.current.get(task.projectRelativePath) !== canvasTextPreviewTargetKey(task)
    ));
    if (checking.length === 0) {
      return;
    }
    const request: CanvasTextPreviewAvailabilityRequest = {
      epoch: runtimeEpochRef.current,
      targetKeys: new Set(checking.map(canvasTextPreviewTargetKey))
    };
    availabilityInFlightRef.current = request;
    for (const target of checking) {
      sourceCheckedTargetKeysRef.current.set(
        target.projectRelativePath,
        canvasTextPreviewTargetKey(target)
      );
    }
    recordTextPreviewCounter('text-preview-source-check-requested', { count: checking.length });
    void actions.readCanvasTextPreviewSources({
      canvasId,
      sources: checking.map(canvasTextPreviewSourceTargetForApi)
    }).then((result) => {
      if (availabilityInFlightRef.current !== request
        || request.epoch !== runtimeEpochRef.current
        || !mountedRef.current) {
        return;
      }
      availabilityInFlightRef.current = undefined;
      const successful: CanvasTextPreviewTarget[] = [];
      for (const target of checking) {
        if (currentTargetKeysRef.current.get(target.projectRelativePath) !== canvasTextPreviewTargetKey(target)) {
          continue;
        }
        const source = result.sources[target.projectRelativePath];
        if (!source || source.status === 'error') {
          setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
            'source_availability_failed',
            failureFieldsForTarget(target),
            source && 'message' in source
              ? source.message
              : `Canvas text preview source response is missing ${target.projectRelativePath}.`
          ));
          continue;
        }
        successful.push(target);
        recordTextPreviewCounter('text-preview-source-availability-resolved', {
          projectRelativePath: target.projectRelativePath,
          fingerprint: target.fingerprint,
          available: source.status === 'available'
        });
      }
      startTransition(() => {
        setSourceAvailability((current) => canvasTextPreviewSourcesWithAvailability({
          current,
          targets: successful,
          sources: result.sources
        }));
      });
    }, (error: unknown) => {
      if (availabilityInFlightRef.current !== request
        || request.epoch !== runtimeEpochRef.current
        || !mountedRef.current) {
        return;
      }
      availabilityInFlightRef.current = undefined;
      for (const target of checking) {
        setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
          'source_availability_failed',
          failureFieldsForTarget(target),
          error
        ));
      }
    });
  }, [
    actions,
    canvasId,
    interactionResumeVersion,
    orderedTasks,
    recordTextPreviewCounter,
    setCurrentPreviewFailure
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
      const targetKey = canvasTextPreviewTargetKey(task);
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
        if (!current || canvasTextPreviewTargetKey(current) !== targetKey) {
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
          failureFieldsForTarget(task),
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
    const job: CanvasTextPreviewCoverageJob = {
      abortController,
      targetKeys: new Map(uncovered.map((task) => [task.projectRelativePath, canvasTextPreviewTargetKey(task)]))
    };
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
          if (job.targetKeys.get(task.projectRelativePath) === canvasTextPreviewTargetKey(task)) {
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
          failureFieldsForTarget(task),
          error
        ));
      }
    });
  }, [interactionResumeVersion, orderedTasks, recordTextPreviewCounter, setCurrentPreviewFailure, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || fontBuildRef.current || fontCandidate) {
      return;
    }
    const needsFont = orderedTasks.some((task) => task.state === 'waiting-font'
      && task.coverage
      && !canvasTextPreviewCoverageContains(activeFontCoverageRef.current, task.coverage));
    if (!needsFont || epochCoverageRef.current.length === 0) {
      return;
    }
    const abortController = new AbortController();
    const coverage = epochCoverageRef.current.slice();
    const build: CanvasTextPreviewFontBuild = { abortController, coverage };
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
        if (task.state === 'waiting-font') {
          setCurrentPreviewFailure(task, canvasTextPreviewFailureFromUnknown(
            'font_prepare_failed',
            failureFieldsForTarget(task),
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
    if (interactionActiveRef.current || orderedTasks.some((task) => task.state === 'capturing')) {
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
          failureFieldsForTarget(firstRunnable),
          error
        ));
        return;
      }
    }
    if (!preparedFont || !canvasTextPreviewCoverageContains(activeCoverage, firstRunnable.coverage)) {
      return;
    }
    updateTasks((current) => updateCanvasTextPreviewTask(current, firstRunnable, { state: 'capturing' }));
  }, [activePreparedFont, fontCandidate, interactionResumeVersion, orderedTasks, setCurrentPreviewFailure, updateTasks]);

  const presentationWorkMatchesCurrentIdentity = useCallback((work: CanvasTextPreviewPresentationWork): boolean => {
    const path = work.source.projectRelativePath;
    return mountedRef.current
      && work.epoch === runtimeEpochRef.current
      && currentTargetKeysRef.current.get(path) === work.targetKey
      && currentResourceKeysRef.current.get(path) === work.sourceKey;
  }, []);

  const presentationWorkCanPublish = useCallback((work: CanvasTextPreviewPresentationWork): boolean => (
    presentationWorkMatchesCurrentIdentity(work)
    && activeInlineTextPathRef.current !== work.source.projectRelativePath
  ), [presentationWorkMatchesCurrentIdentity]);

  const presentationWorkIsQueued = useCallback((
    phase: CanvasTextPreviewPublicationPhase,
    work: CanvasTextPreviewPresentationWork
  ): boolean => (
    presentationQueuesRef.current[phase].get(work.sourceKey) === work
    && presentationWorkMatchesCurrentIdentity(work)
  ), [presentationWorkMatchesCurrentIdentity]);

  const commitVisiblePresentation = useCallback((work: CanvasTextPreviewPresentationWork) => {
    const path = work.source.projectRelativePath;
    const target = currentTargetsRef.current[path];
    if (!target || !presentationWorkCanPublish(work)) {
      return;
    }
    setPreviewPresentations((current) => {
      const existing = current[path];
      if (!presentationWorkCanPublish(work)
        || !existing?.visible
        || existing.visible.sourceKey !== work.sourceKey
        || existing.visible.committed) {
        return current;
      }
      markNodePathChanged(path);
      return {
        ...current,
        [path]: { ...existing, visible: { ...existing.visible, committed: true } }
      };
    });
    clearCurrentPreviewFailure(target, work.sourceKey);
    recordTextPreviewCounter('text-preview-published', {
      projectRelativePath: path,
      fingerprint: work.source.fingerprint,
      previewWidth: work.source.previewWidth
    });
  }, [clearCurrentPreviewFailure, markNodePathChanged, presentationWorkCanPublish, recordTextPreviewCounter]);

  const publishPresentationWork = useCallback((
    phase: CanvasTextPreviewPublicationPhase,
    work: CanvasTextPreviewPresentationWork
  ) => {
    const queue = presentationQueuesRef.current[phase];
    if (!presentationWorkIsQueued(phase, work)) {
      queue.delete(work.sourceKey);
      return;
    }
    if (!presentationWorkCanPublish(work)) {
      return;
    }
    if (phase === 'commit') {
      commitVisiblePresentation(work);
      return;
    }
    publishingSourceKeysRef.current.add(work.sourceKey);
    startTransition(() => {
      setPreviewPresentations((current) => {
        const path = work.source.projectRelativePath;
        const existing = current[path];
        if (!presentationWorkCanPublish(work)) {
          return current;
        }
        markNodePathChanged(path);
        if (phase === 'promote') {
          if (existing?.pending?.sourceKey !== work.sourceKey) {
            return current;
          }
          return { ...current, [path]: { visible: canvasTextPreviewLayerFromWork(work), pending: undefined } };
        }
        return {
          ...current,
          [path]: {
            visible: existing?.visible?.targetKey === work.targetKey ? existing.visible : undefined,
            pending: canvasTextPreviewLayerFromWork(work)
          }
        };
      });
    });
  }, [commitVisiblePresentation, markNodePathChanged, presentationWorkCanPublish, presentationWorkIsQueued]);

  const enqueuePresentationWork = useCallback((
    phase: CanvasTextPreviewPublicationPhase,
    work: CanvasTextPreviewPresentationWork
  ) => {
    presentationQueuesRef.current[phase].set(work.sourceKey, work);
    const request = {
      kind: 'text',
      nodeId: work.source.projectRelativePath,
      sourceKey: `${phase}\u001f${work.sourceKey}`,
      targetWidth: work.source.previewWidth,
      isCurrent: () => presentationWorkIsQueued(phase, work),
      run: () => publishPresentationWork(phase, work)
    } as const;
    if (phase === 'mount') {
      previewResourceScheduler.enqueue(request);
    } else {
      previewResourceScheduler.enqueuePublication(request);
    }
  }, [presentationWorkIsQueued, previewResourceScheduler, publishPresentationWork]);

  useEffect(() => {
    forEachPresentationQueue(presentationQueuesRef.current, (phase, queue) => {
      for (const [sourceKey, work] of queue) {
        const presentation = previewPresentations[work.source.projectRelativePath];
        const published = phase === 'mount'
          ? presentation?.pending?.sourceKey === sourceKey
          : phase === 'promote'
            ? presentation?.visible?.sourceKey === sourceKey && presentation.pending === undefined
            : presentation?.visible?.sourceKey === sourceKey && presentation.visible.committed;
        if (published) {
          queue.delete(sourceKey);
          publishingSourceKeysRef.current.delete(sourceKey);
        }
      }
    });
  }, [previewPresentations]);

  useEffect(() => {
    const desiredSourceKeys = new Map<string, string>();
    for (const target of orderedCurrentTargets) {
      const path = target.projectRelativePath;
      const presentation = previewPresentations[path];
      if (path === activeInlineTextPath) {
        const retained = presentation?.pending ?? presentation?.visible;
        if (retained) {
          desiredSourceKeys.set(path, retained.sourceKey);
          setCurrentResourceKey(path, retained.sourceKey);
        }
        continue;
      }
      const availability = sourceAvailability[path];
      const node = nodesByPath.get(path);
      if (!node || availability?.fingerprint !== target.fingerprint || !availability.available) {
        setCurrentResourceKey(path, undefined);
        continue;
      }
      const source = canvasTextPreviewForNode({ canvasId, node, target, resourceZoom, devicePixelRatio });
      if (!source) {
        continue;
      }
      const targetKey = canvasTextPreviewTargetKey(target);
      desiredSourceKeys.set(path, source.sourceKey);
      setCurrentResourceKey(path, source.sourceKey);
      const error = previewErrors[path];
      if (presentation?.visible?.sourceKey === source.sourceKey
        || presentation?.pending?.sourceKey === source.sourceKey
        || presentationQueuesRef.current.mount.has(source.sourceKey)
        || presentationQueuesRef.current.promote.has(source.sourceKey)
        || publishingSourceKeysRef.current.has(source.sourceKey)
        || (error?.targetKey === targetKey && error.sourceKey === source.sourceKey)) {
        continue;
      }
      enqueuePresentationWork('mount', {
        epoch: runtimeEpochRef.current,
        targetKey,
        sourceKey: source.sourceKey,
        source,
        committed: false
      });
      clearCurrentPreviewFailure(target, source.sourceKey);
    }
    forEachPresentationQueue(presentationQueuesRef.current, (_phase, queue) => {
      for (const [sourceKey, work] of queue) {
        if (desiredSourceKeys.get(work.source.projectRelativePath) !== sourceKey) {
          queue.delete(sourceKey);
        }
      }
    });
    const reconciledPresentations = canvasTextPreviewPresentationsForDesiredSources({
      current: previewPresentations,
      desiredSourceKeys
    });
    if (reconciledPresentations !== previewPresentations) {
      markChangedNodeRecords(previewPresentations, reconciledPresentations);
      setPreviewPresentations(reconciledPresentations);
    }
  }, [
    activeInlineTextPath,
    canvasId,
    clearCurrentPreviewFailure,
    currentTargets,
    devicePixelRatio,
    enqueuePresentationWork,
    markChangedNodeRecords,
    nodesByPath,
    previewErrors,
    previewPresentations,
    orderedCurrentTargets,
    resourceZoom,
    setCurrentResourceKey,
    sourceAvailability
  ]);

  const finishRasterizedTarget = useCallback((
    target: CanvasTextPreviewCaptureTarget,
    raster: CanvasTextPreviewCaptureResult
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    const epoch = runtimeEpochRef.current;
    if (!isCurrentTarget(epoch, target)) {
      return;
    }
    uploadingTargetKeysRef.current.add(targetKey);
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
      inFlight: uploadingTargetKeysRef.current.size
    });
    void actions.saveCanvasTextPreviewSource({
      ...canvasTextPreviewSourceTargetForApi(target),
      canvasId: target.canvasId,
      sourcePng: raster.sourcePng
    }).then(() => {
      uploadingTargetKeysRef.current.delete(targetKey);
      if (!isCurrentTarget(epoch, target)) {
        return;
      }
      startTransition(() => {
        setSourceAvailability((current) => ({
          ...current,
          [target.projectRelativePath]: { fingerprint: target.fingerprint, available: true }
        }));
      });
      clearCurrentPreviewFailure(target);
      recordTextPreviewCounter('text-preview-source-upload-completed', {
        projectRelativePath: target.projectRelativePath,
        fingerprint: target.fingerprint,
        durationMs: performance.now() - startedAt,
        inFlight: uploadingTargetKeysRef.current.size
      });
    }, (error: unknown) => {
      uploadingTargetKeysRef.current.delete(targetKey);
      if (isCurrentTarget(epoch, target)) {
        setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
          'source_upload_failed',
          failureFieldsForTarget(target),
          error
        ));
      }
    });
  }, [
    actions,
    clearCurrentPreviewFailure,
    isCurrentTarget,
    recordTextPreviewCounter,
    setCurrentPreviewFailure,
    updateTasks
  ]);

  const finishFailedTarget = useCallback((
    target: CanvasTextPreviewCaptureTarget,
    failure: CanvasTextPreviewFailure
  ) => {
    setCurrentPreviewFailure(target, failure);
  }, [setCurrentPreviewFailure]);

  const currentTargetForRenderedNode = useCallback((node: ProjectedCanvasNode): CanvasTextPreviewTarget | undefined => {
    const styleKey = styleKeyRef.current;
    const target = currentTargetsRef.current[node.projectRelativePath];
    const resolution = targetResolutionsRef.current.get(node.projectRelativePath);
    if (!styleKey || !target || resolution?.target !== target) {
      return undefined;
    }
    const renderedInput = canvasTextPreviewTargetInput({
      canvasId: currentCanvasIdRef.current,
      node,
      buffer: textFileBuffersRef.current[node.projectRelativePath],
      styleKey
    });
    return renderedInput && canvasTextPreviewTargetInputsEqual(resolution.input, renderedInput)
      ? target
      : undefined;
  }, []);

  const reportPendingReady = useCallback((node: ProjectedCanvasNode, source: CanvasTextPreviewSource) => {
    const target = currentTargetForRenderedNode(node);
    const pending = previewPresentations[node.projectRelativePath]?.pending;
    if (!target
      || !pending
      || pending.sourceKey !== source.sourceKey
      || pending.targetKey !== canvasTextPreviewTargetKey(target)
      || currentResourceKeysRef.current.get(node.projectRelativePath) !== source.sourceKey) {
      return;
    }
    enqueuePresentationWork('promote', { epoch: runtimeEpochRef.current, ...pending });
    recordTextPreviewCounter('text-preview-pending-ready', {
      projectRelativePath: source.projectRelativePath,
      fingerprint: source.fingerprint,
      previewWidth: source.previewWidth
    });
  }, [currentTargetForRenderedNode, enqueuePresentationWork, previewPresentations, recordTextPreviewCounter]);

  const reportPendingFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown
  ) => {
    const target = currentTargetForRenderedNode(node);
    const pending = previewPresentations[node.projectRelativePath]?.pending;
    if (!target || pending?.sourceKey !== source.sourceKey || pending.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    presentationQueuesRef.current.promote.delete(source.sourceKey);
    setPreviewPresentations((current) => {
      const existing = current[node.projectRelativePath];
      if (existing?.pending?.sourceKey !== source.sourceKey) {
        return current;
      }
      markNodePathChanged(node.projectRelativePath);
      return { ...current, [node.projectRelativePath]: { visible: existing.visible, pending: undefined } };
    });
    setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
      'variant_failed',
      failureFieldsForTarget(target),
      error
    ), source.sourceKey);
  }, [currentTargetForRenderedNode, markNodePathChanged, previewPresentations, setCurrentPreviewFailure]);

  const reportVisibleFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown
  ) => {
    const target = currentTargetForRenderedNode(node);
    const visible = previewPresentations[node.projectRelativePath]?.visible;
    if (!target || visible?.sourceKey !== source.sourceKey || visible.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    presentationQueuesRef.current.commit.delete(source.sourceKey);
    setPreviewPresentations((current) => {
      const existing = current[node.projectRelativePath];
      if (existing?.visible?.sourceKey !== source.sourceKey) {
        return current;
      }
      markNodePathChanged(node.projectRelativePath);
      return { ...current, [node.projectRelativePath]: { visible: undefined, pending: existing.pending } };
    });
    setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
      'variant_failed',
      failureFieldsForTarget(target),
      error
    ), source.sourceKey);
  }, [currentTargetForRenderedNode, markNodePathChanged, previewPresentations, setCurrentPreviewFailure]);

  const reportVisibleCommitted = useCallback((node: ProjectedCanvasNode, source: CanvasTextPreviewSource) => {
    const target = currentTargetForRenderedNode(node);
    const visible = previewPresentations[node.projectRelativePath]?.visible;
    if (target && visible?.sourceKey === source.sourceKey && visible.targetKey === canvasTextPreviewTargetKey(target)) {
      enqueuePresentationWork('commit', { epoch: runtimeEpochRef.current, ...visible });
    }
  }, [currentTargetForRenderedNode, enqueuePresentationWork, previewPresentations]);

  const commandHandlersRef = useRef({
    retryPreview,
    reportPendingReady,
    reportPendingFailure,
    reportVisibleFailure,
    reportVisibleCommitted
  });
  commandHandlersRef.current = {
    retryPreview,
    reportPendingReady,
    reportPendingFailure,
    reportVisibleFailure,
    reportVisibleCommitted
  };

  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasTextPreviewNodeSnapshot => {
    const target = currentTargetForRenderedNode(node);
    const presentationState = previewPresentationsRef.current[node.projectRelativePath];
    let presentation: CanvasTextPreviewPresentation = {};
    let previewError: string | undefined;
    if (target) {
      const targetKey = canvasTextPreviewTargetKey(target);
      presentation = {
        visible: presentationState?.visible?.targetKey === targetKey
          ? presentationState.visible.source
          : undefined,
        pending: presentationState?.pending?.targetKey === targetKey
          ? presentationState.pending.source
          : undefined,
        ...(presentationState?.visible?.targetKey === targetKey && presentationState.visible.committed
          ? { visibleCommittedSourceKey: presentationState.visible.sourceKey }
          : {})
      };
      const error = previewErrorsRef.current[node.projectRelativePath];
      if (error?.targetKey === targetKey
        && (error.sourceKey === undefined
          || currentResourceKeysRef.current.get(node.projectRelativePath) === error.sourceKey)) {
        previewError = error.error.message;
      }
    }
    return { presentation, previewError };
  }, [currentTargetForRenderedNode]);

  const nodeSnapshotStore = useMemo(() => createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: sameCanvasTextPreviewNodeSnapshot
  }), [deriveNodeSnapshot]);

  useLayoutEffect(() => {
    const changedPaths = new Set(changedNodePathsRef.current);
    changedNodePathsRef.current.clear();
    nodeSnapshotStore.flush(changedPaths);
  });

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    retryPreview: (...args) => commandHandlersRef.current.retryPreview(...args),
    reportPendingReady: (...args) => commandHandlersRef.current.reportPendingReady(...args),
    reportPendingFailure: (...args) => commandHandlersRef.current.reportPendingFailure(...args),
    reportVisibleFailure: (...args) => commandHandlersRef.current.reportVisibleFailure(...args),
    reportVisibleCommitted: (...args) => commandHandlersRef.current.reportVisibleCommitted(...args),
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

export function canvasTextPreviewTargetWidthForNode(input: {
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  return canvasRasterPreviewWidth({
    nodeDisplayWidth: input.node.width,
    sourceWidth: input.target.sourcePixelWidth,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
}

export function canvasTextPreviewTargetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

function isStableCanvasTextNode(node: ProjectedCanvasNode): boolean {
  return node.nodeKind === 'file'
    && node.mediaKind === 'text'
    && node.availability.state === 'available'
    && node.textLanguage !== undefined;
}

function canvasTextPreviewTargetInput(input: {
  canvasId: string;
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
    canvasId: input.canvasId,
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
    canvasId: targetInput.canvasId,
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
  return { ...candidate, fingerprint: await canvasTextPreviewFingerprint(candidate) };
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
  return left.canvasId === right.canvasId
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

function commitCanvasTextPreviewTargets(input: {
  targets: CanvasTextPreviewTarget[];
  activeInlineTextPath?: string | undefined;
  currentTargetKeysRef: React.MutableRefObject<Map<string, string>>;
  currentTargetsRef: React.MutableRefObject<Record<string, CanvasTextPreviewTarget>>;
  setCurrentTargets: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewTarget>>>;
  setSourceAvailability: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewSourceAvailability>>>;
  setPreviewPresentations: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewPresentationState>>>;
  setPreviewErrors: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewErrorState>>>;
  markChangedNodeRecords<Value>(
    previous: Readonly<Record<string, Value>>,
    next: Readonly<Record<string, Value>>
  ): void;
  presentationQueues: CanvasTextPreviewPresentationQueues;
}): void {
  const targetKeys = new Map(input.targets.map((target) => [target.projectRelativePath, canvasTextPreviewTargetKey(target)]));
  const byPath = Object.fromEntries(input.targets.map((target) => [target.projectRelativePath, target]));
  if (canvasTextPreviewTargetRecordsEqual(input.currentTargetsRef.current, byPath)) {
    return;
  }
  input.currentTargetKeysRef.current = targetKeys;
  input.currentTargetsRef.current = byPath;
  input.setCurrentTargets(byPath);
  input.setSourceAvailability((current) => canvasTextPreviewCurrentSourceAvailability({
    targets: input.targets,
    sourceAvailability: current
  }));
  input.setPreviewPresentations((current) => {
    const next = canvasTextPreviewCurrentPresentations({
      targets: input.targets,
      presentations: current,
      retainedPath: input.activeInlineTextPath
    });
    input.markChangedNodeRecords(current, next);
    return next;
  });
  input.setPreviewErrors((current) => {
    const next = clearStaleCanvasTextPreviewErrors(current, targetKeys);
    input.markChangedNodeRecords(current, next);
    return next;
  });
  forEachPresentationQueue(input.presentationQueues, (_phase, queue) => {
    for (const [sourceKey, work] of queue) {
      if (targetKeys.get(work.source.projectRelativePath) !== work.targetKey) {
        queue.delete(sourceKey);
      }
    }
  });
}

function orderCanvasTextPreviewTasks(input: {
  tasks: ReadonlyMap<string, CanvasTextPreviewTask>;
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasTextPreviewTask[] {
  const spatial = [...input.tasks.values()].flatMap((task) => {
    const node = input.nodesByPath.get(task.projectRelativePath);
    return node ? [{ task, ...node }] : [];
  });
  return orderCanvasPreviewTasks(spatial, input.visibleRect).map(({ task }) => task);
}

function orderCanvasTextPreviewTargets(input: {
  targets: readonly CanvasTextPreviewTarget[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasTextPreviewTarget[] {
  const spatial = input.targets.flatMap((target) => {
    const node = input.nodesByPath.get(target.projectRelativePath);
    return node ? [{ target, ...node }] : [];
  });
  return orderCanvasPreviewTasks(spatial, input.visibleRect).map(({ target }) => target);
}

function updateCanvasTextPreviewTask(
  current: Map<string, CanvasTextPreviewTask>,
  target: CanvasTextPreviewTarget,
  patch: Partial<CanvasTextPreviewTask>
): Map<string, CanvasTextPreviewTask> {
  const existing = current.get(target.projectRelativePath);
  if (!existing || canvasTextPreviewTargetKey(existing) !== canvasTextPreviewTargetKey(target)) {
    return current;
  }
  const next = new Map(current);
  next.set(target.projectRelativePath, { ...existing, ...patch });
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
  if (buffer.error || buffer.language !== target.language) {
    return false;
  }
  return buffer.dirty
    ? resolution?.target?.fingerprint === target.fingerprint
      && resolution.input.dirtyContent === buffer.content
    : buffer.baseRevision === target.contentDigest;
}

function canvasTextPreviewForNode(input: {
  canvasId: string;
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasTextPreviewSource | undefined {
  if (input.node.availability.state !== 'available' || !input.node.availability.fileUrl) {
    return undefined;
  }
  const previewWidth = canvasTextPreviewTargetWidthForNode(input);
  const sourceKey = `${canvasTextPreviewTargetKey(input.target)}\u001f${previewWidth}`;
  const projectId = canvasRawFileProjectId(input.node.availability.fileUrl);
  const params = new URLSearchParams({
    canvasId: input.canvasId,
    path: input.node.projectRelativePath,
    fingerprint: input.target.fingerprint,
    w: String(previewWidth)
  });
  return {
    projectRelativePath: input.node.projectRelativePath,
    sourceKey,
    src: `/api/projects/${projectId}/canvas-text-preview?${params.toString()}`,
    previewWidth,
    fingerprint: input.target.fingerprint
  };
}

function canvasTextPreviewSourcesWithAvailability(input: {
  current: Record<string, CanvasTextPreviewSourceAvailability>;
  targets: CanvasTextPreviewTarget[];
  sources: Record<string, { fingerprint: string; status: 'available' | 'missing' | 'error' }>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  let next = input.current;
  for (const target of input.targets) {
    const source = input.sources[target.projectRelativePath];
    if (!source || source.status === 'error') {
      continue;
    }
    const availability = { fingerprint: target.fingerprint, available: source.status === 'available' };
    const existing = next[target.projectRelativePath];
    if (existing?.fingerprint === availability.fingerprint && existing.available === availability.available) {
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
  const fingerprints = new Map(input.targets.map((target) => [target.projectRelativePath, target.fingerprint]));
  return Object.fromEntries(Object.entries(input.sourceAvailability).filter(([path, availability]) => (
    fingerprints.get(path) === availability.fingerprint
  )));
}

function canvasTextPreviewCurrentPresentations(input: {
  targets: CanvasTextPreviewTarget[];
  presentations: Record<string, CanvasTextPreviewPresentationState>;
  retainedPath?: string | undefined;
}): Record<string, CanvasTextPreviewPresentationState> {
  const keys = new Map(input.targets.map((target) => [target.projectRelativePath, canvasTextPreviewTargetKey(target)]));
  const next: Record<string, CanvasTextPreviewPresentationState> = {};
  for (const [path, presentation] of Object.entries(input.presentations)) {
    if (path === input.retainedPath) {
      next[path] = presentation;
      continue;
    }
    const targetKey = keys.get(path);
    const visible = presentation.visible?.targetKey === targetKey ? presentation.visible : undefined;
    const pending = presentation.pending?.targetKey === targetKey ? presentation.pending : undefined;
    if (visible || pending) {
      next[path] = { visible, pending };
    }
  }
  return next;
}

function canvasTextPreviewPresentationsForDesiredSources(input: {
  current: Record<string, CanvasTextPreviewPresentationState>;
  desiredSourceKeys: ReadonlyMap<string, string>;
}): Record<string, CanvasTextPreviewPresentationState> {
  let next = input.current;
  for (const [path, presentation] of Object.entries(input.current)) {
    if (!presentation.pending || input.desiredSourceKeys.get(path) === presentation.pending.sourceKey) {
      continue;
    }
    next = next === input.current ? { ...input.current } : next;
    if (presentation.visible) {
      next[path] = { visible: presentation.visible, pending: undefined };
    } else {
      delete next[path];
    }
  }
  return next;
}

function clearStaleCanvasTextPreviewErrors(
  errors: Record<string, CanvasTextPreviewErrorState>,
  targetKeys: ReadonlyMap<string, string>
): Record<string, CanvasTextPreviewErrorState> {
  return Object.fromEntries(Object.entries(errors).filter(([path, error]) => targetKeys.get(path) === error.targetKey));
}

function canvasTextPreviewTargetRecordsEqual(
  left: Record<string, CanvasTextPreviewTarget>,
  right: Record<string, CanvasTextPreviewTarget>
): boolean {
  const paths = Object.keys(left);
  return paths.length === Object.keys(right).length && paths.every((path) => left[path] === right[path]);
}

function canvasTextPreviewSourceTargetForApi(target: CanvasTextPreviewTarget) {
  return { projectRelativePath: target.projectRelativePath, fingerprint: target.fingerprint };
}

function canvasTextPreviewLayerFromWork(work: CanvasTextPreviewPresentationWork): CanvasTextPreviewLayerState {
  return {
    targetKey: work.targetKey,
    sourceKey: work.sourceKey,
    source: work.source,
    committed: false
  };
}

function failureFieldsForTarget(target: CanvasTextPreviewTarget): CanvasTextPreviewFailureFields {
  return {
    canvasId: target.canvasId,
    projectRelativePath: target.projectRelativePath,
    fingerprint: target.fingerprint
  };
}

function forEachPresentationQueue(
  queues: CanvasTextPreviewPresentationQueues,
  visit: (phase: CanvasTextPreviewPublicationPhase, queue: Map<string, CanvasTextPreviewPresentationWork>) => void
): void {
  for (const phase of CANVAS_TEXT_PREVIEW_PUBLICATION_PHASES) {
    visit(phase, queues[phase]);
  }
}

function sameCanvasTextPreviewNodeSnapshot(
  left: CanvasTextPreviewNodeSnapshot,
  right: CanvasTextPreviewNodeSnapshot
): boolean {
  return left.presentation.visible === right.presentation.visible
    && left.presentation.pending === right.presentation.pending
    && left.presentation.visibleCommittedSourceKey === right.presentation.visibleCommittedSourceKey
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
