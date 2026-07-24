import React, { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import {
  CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
  canvasTextPreviewFingerprint,
  type CanvasTextPreviewCandidate,
  type CanvasTextPreviewRasterResult,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture';
import {
  CanvasTextPreviewCaptureLane,
  type CanvasTextPreviewCaptureStageEvent
} from './CanvasTextPreviewCaptureLane';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';
import type {
  CanvasTextPreviewImageFailureKind,
  CanvasTextPreviewPresentation
} from './CanvasTextPreviewImageHandoff';
import type { CanvasCameraState } from './runtime/canvasCamera';
import {
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshotForDocument
} from './CanvasTextPreviewStyleKey';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import { canvasRawFileProjectId } from './canvasRawFileUrls';

export interface CanvasTextPreviewSource {
  projectRelativePath: string;
  sourceKey: string;
  src: string;
  previewWidth: number;
  fingerprint: string;
}

export interface CanvasTextPreviewMeasuredBody {
  width: number;
  height: number;
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

function forEachPresentationQueue(
  queues: CanvasTextPreviewPresentationQueues,
  visit: (
    phase: CanvasTextPreviewPublicationPhase,
    queue: Map<string, CanvasTextPreviewPresentationWork>
  ) => void
): void {
  for (const phase of CANVAS_TEXT_PREVIEW_PUBLICATION_PHASES) {
    visit(phase, queues[phase]);
  }
}

interface CanvasTextPreviewErrorState {
  targetKey: string;
  sourceKey?: string | undefined;
  error: Error;
}

export interface CanvasTextPreviewRuntimeValue {
  registerTextBody(projectRelativePath: string, element: HTMLElement | null): void;
  presentationForNode(input: { node: ProjectedCanvasNode }): CanvasTextPreviewPresentation;
  previewErrorForNode(input: { node: ProjectedCanvasNode }): string | undefined;
  reportPendingReady(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
  reportPendingFailure(
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown,
    kind: CanvasTextPreviewImageFailureKind
  ): void;
  reportVisibleFailure(
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown,
    kind: CanvasTextPreviewImageFailureKind
  ): void;
  reportVisibleCommitted(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
}

const CanvasTextPreviewRuntimeContext = createContext<CanvasTextPreviewRuntimeValue | undefined>(undefined);

export function useCanvasTextPreviewRuntime(): CanvasTextPreviewRuntimeValue {
  const runtime = useContext(CanvasTextPreviewRuntimeContext);
  if (!runtime) {
    throw new Error('CanvasTextPreviewProvider is required.');
  }
  return runtime;
}

export function CanvasTextPreviewProvider({
  canvasId,
  nodes,
  activeInlineTextPath,
  textFileBuffers,
  actions,
  cameraState,
  dragState,
  resourceZoom,
  devicePixelRatio,
  culledNodePaths,
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
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  resourceZoom: number;
  devicePixelRatio: number;
  culledNodePaths: ReadonlySet<string>;
  styleDependencyKey: string;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const [sourceAvailability, setSourceAvailability] = useState<Record<string, CanvasTextPreviewSourceAvailability>>({});
  const [measuredBodies, setMeasuredBodies] = useState<Map<string, CanvasTextPreviewMeasuredBody>>(() => new Map());
  const [captureTarget, setCaptureTarget] = useState<CanvasTextPreviewTarget>();
  const [captureLayerRoot, setCaptureLayerRoot] = useState<HTMLElement>();
  const [previewErrors, setPreviewErrors] = useState<Record<string, CanvasTextPreviewErrorState>>({});
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasTextPreviewTarget>>({});
  const [previewPresentations, setPreviewPresentations] = useState<Record<string, CanvasTextPreviewPresentationState>>({});
  const [availabilityCheckedTargetKeys, setAvailabilityCheckedTargetKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [styleKeyState, setStyleKeyState] = useState<{
    key?: string | undefined;
    error?: Error | undefined;
  }>({});
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentTargetsRef = useRef<Record<string, CanvasTextPreviewTarget>>({});
  const previewPresentationsRef = useRef<Record<string, CanvasTextPreviewPresentationState>>({});
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const currentCanvasIdRef = useRef(canvasId);
  const interactionActive = cameraState !== 'idle' || dragState !== undefined;
  const runtimeEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const bodyRegistrationsRef = useRef(new Map<string, () => void>());
  const uploadingTargetKeysRef = useRef(new Set<string>());
  const presentationQueuesRef = useRef<CanvasTextPreviewPresentationQueues>({
    mount: new Map(),
    promote: new Map(),
    commit: new Map()
  });
  const publishingSourceKeysRef = useRef(new Set<string>());
  const currentCulledNodePathsRef = useRef(culledNodePaths);
  currentCanvasIdRef.current = canvasId;
  currentTargetsRef.current = currentTargets;
  previewPresentationsRef.current = previewPresentations;
  currentCulledNodePathsRef.current = culledNodePaths;
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);

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
    setPreviewErrors((current) => ({
      ...current,
      [target.projectRelativePath]: { targetKey, sourceKey, error }
    }));
    recordTextPreviewCounter('text-preview-failed', {
      projectRelativePath: target.projectRelativePath,
      fingerprint: target.fingerprint,
      stage: error.stage,
      message: error.message
    });
  }, [recordTextPreviewCounter]);

  const clearCurrentPreviewFailure = useCallback((target: CanvasTextPreviewTarget, sourceKey?: string) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    setPreviewErrors((current) => {
      const existing = current[target.projectRelativePath];
      if (!existing
        || existing.targetKey !== targetKey
        || (sourceKey !== undefined && existing.sourceKey !== undefined && existing.sourceKey !== sourceKey)) {
        return current;
      }
      const next = { ...current };
      delete next[target.projectRelativePath];
      return next;
    });
  }, []);

  const presentationWorkMatchesCurrentIdentity = useCallback((work: CanvasTextPreviewPresentationWork): boolean => {
    const path = work.source.projectRelativePath;
    return mountedRef.current
      && work.epoch === runtimeEpochRef.current
      && currentTargetKeysRef.current.get(path) === work.targetKey
      && currentResourceKeysRef.current.get(path) === work.sourceKey;
  }, []);

  const presentationWorkCanPublish = useCallback((work: CanvasTextPreviewPresentationWork): boolean => (
    presentationWorkMatchesCurrentIdentity(work)
    && !currentCulledNodePathsRef.current.has(work.source.projectRelativePath)
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
      return {
        ...current,
        [path]: {
          ...existing,
          visible: { ...existing.visible, committed: true }
        }
      };
    });
    clearCurrentPreviewFailure(target, work.sourceKey);
    recordTextPreviewCounter('text-preview-published', {
      projectRelativePath: path,
      fingerprint: work.source.fingerprint,
      previewWidth: work.source.previewWidth
    });
  }, [clearCurrentPreviewFailure, presentationWorkCanPublish, recordTextPreviewCounter]);

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
    startTransition(() => {
      if (phase === 'commit') {
        commitVisiblePresentation(work);
        return;
      }
      publishingSourceKeysRef.current.add(work.sourceKey);
      setPreviewPresentations((current) => {
        const path = work.source.projectRelativePath;
        const existing = current[path];
        if (!presentationWorkCanPublish(work)) {
          return current;
        }
        if (phase === 'promote') {
          if (existing?.pending?.sourceKey !== work.sourceKey) {
            return current;
          }
          return {
            ...current,
            [path]: {
              visible: canvasTextPreviewLayerFromWork(work),
              pending: undefined
            }
          };
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
  }, [commitVisiblePresentation, presentationWorkCanPublish, presentationWorkIsQueued]);

  const enqueuePresentationWork = useCallback((
    phase: CanvasTextPreviewPublicationPhase,
    work: CanvasTextPreviewPresentationWork
  ) => {
    const queue = presentationQueuesRef.current[phase];
    queue.set(work.sourceKey, work);
    const request = {
      kind: 'text',
      nodeId: work.source.projectRelativePath,
      sourceKey: `${phase}\u001f${work.sourceKey}`,
      targetWidth: work.source.previewWidth,
      isCurrent: () => presentationWorkIsQueued(phase, work),
      isCulled: () => currentCulledNodePathsRef.current.has(work.source.projectRelativePath),
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
      for (const work of queue.values()) {
        if (presentationWorkMatchesCurrentIdentity(work)
          && !currentCulledNodePathsRef.current.has(work.source.projectRelativePath)) {
          enqueuePresentationWork(phase, work);
        }
      }
    });
  }, [culledNodePaths, enqueuePresentationWork, presentationWorkMatchesCurrentIdentity]);

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
        }
      }
    });
  }, [previewPresentations]);

  useEffect(() => {
    mountedRef.current = true;
    runtimeEpochRef.current += 1;
    const epoch = runtimeEpochRef.current;
    return () => {
      if (runtimeEpochRef.current === epoch) {
        runtimeEpochRef.current += 1;
      }
      mountedRef.current = false;
      for (const projectRelativePath of currentTargetKeysRef.current.keys()) {
        previewResourceScheduler.cancel('text', projectRelativePath);
      }
      for (const queue of Object.values(presentationQueuesRef.current)) {
        queue.clear();
      }
      publishingSourceKeysRef.current.clear();
      uploadingTargetKeysRef.current.clear();
      for (const cleanup of bodyRegistrationsRef.current.values()) {
        cleanup();
      }
      bodyRegistrationsRef.current.clear();
    };
  }, [canvasId, previewResourceScheduler]);

  useEffect(() => {
    setCaptureLayerRoot(document.body);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => canvasTextPreviewStyleSnapshotForDocument())
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
  }, [styleDependencyKey]);

  if (styleKeyState.error) {
    throw styleKeyState.error;
  }

  useEffect(() => {
    const path = activeInlineTextPath;
    if (!path) {
      return;
    }
    const targetKey = currentTargetKeysRef.current.get(path);
    if (targetKey) {
      for (const sourceKey of publishingSourceKeysRef.current) {
        if (sourceKey.startsWith(`${targetKey}\u001f`)) {
          publishingSourceKeysRef.current.delete(sourceKey);
        }
      }
    }
    previewResourceScheduler.cancel('text', path);
    const retainedPresentation = previewPresentationsRef.current[path];
    if (retainedPresentation?.visible) {
      currentResourceKeysRef.current.set(path, retainedPresentation.visible.sourceKey);
    } else {
      currentResourceKeysRef.current.delete(path);
    }
    for (const queue of Object.values(presentationQueuesRef.current)) {
      for (const [sourceKey, work] of queue) {
        if (work.source.projectRelativePath === path) {
          queue.delete(sourceKey);
        }
      }
    }
    setPreviewPresentations((current) => {
      const presentation = current[path];
      if (!presentation?.visible) {
        return withoutRecordPath(current, path);
      }
      if (!presentation.pending) {
        return current;
      }
      return {
        ...current,
        [path]: { visible: presentation.visible, pending: undefined }
      };
    });
    setPreviewErrors((current) => withoutRecordPath(current, path));
  }, [activeInlineTextPath, previewResourceScheduler]);

  const commitTextBodyMeasurement = useCallback((projectRelativePath: string, element: HTMLElement) => {
    const measurement = canvasTextPreviewBodyMeasurement(element);
    if (measurement.width <= 0 || measurement.height <= 0) {
      return;
    }
    setMeasuredBodies((current) => {
      const existing = current.get(projectRelativePath);
      if (existing && existing.width === measurement.width && existing.height === measurement.height) {
        return current;
      }
      const next = new Map(current);
      next.set(projectRelativePath, measurement);
      return next;
    });
  }, []);

  const registerTextBody = useCallback((projectRelativePath: string, element: HTMLElement | null) => {
    bodyRegistrationsRef.current.get(projectRelativePath)?.();
    bodyRegistrationsRef.current.delete(projectRelativePath);
    if (!element) {
      return;
    }
    const commit = () => commitTextBodyMeasurement(projectRelativePath, element);
    const cleanup: Array<() => void> = [];
    const observer = new ResizeObserver(commit);
    observer.observe(element);
    cleanup.push(() => observer.disconnect());
    const frame = window.requestAnimationFrame(commit);
    cleanup.push(() => window.cancelAnimationFrame(frame));
    commit();
    bodyRegistrationsRef.current.set(projectRelativePath, () => {
      for (const item of cleanup) {
        item();
      }
    });
  }, [commitTextBodyMeasurement]);

  useEffect(() => {
    if (!styleKeyState.key) {
      return undefined;
    }
    let cancelled = false;
    const candidates = canvasTextPreviewTargetsForNodes({
      canvasId,
      nodes,
      textFileBuffers,
      measuredBodies,
      styleKey: styleKeyState.key
    }).filter((candidate) => candidate.projectRelativePath !== activeInlineTextPath);
    void Promise.all(candidates.map(async (candidate): Promise<CanvasTextPreviewTarget> => ({
      ...candidate,
      fingerprint: await canvasTextPreviewFingerprint(candidate)
    }))).then((resolvedTargets) => {
      if (cancelled) {
        return;
      }
      const retainedActiveTarget = activeInlineTextPath
        ? currentTargetsRef.current[activeInlineTextPath]
        : undefined;
      const targets = retainedActiveTarget
        ? [...resolvedTargets, retainedActiveTarget]
        : resolvedTargets;
      const targetKeys = new Map(targets.map((target) => [
        target.projectRelativePath,
        canvasTextPreviewTargetKey(target)
      ]));
      currentTargetKeysRef.current = targetKeys;
      const targetsByPath = canvasTextPreviewTargetsByPath(targets);
      currentTargetsRef.current = targetsByPath;
      setCurrentTargets(targetsByPath);
      setCaptureTarget((current) => current
        && targetKeys.get(current.projectRelativePath) === canvasTextPreviewTargetKey(current)
        ? current
        : undefined);
      setAvailabilityCheckedTargetKeys((current) => new Set([...current].filter((key) => (
        [...targetKeys.values()].includes(key)
      ))));
      setSourceAvailability((current) => canvasTextPreviewCurrentSourceAvailability({
        targets,
        sourceAvailability: current
      }));
      setPreviewPresentations((current) => canvasTextPreviewCurrentPresentations({ targets, presentations: current }));
      setPreviewErrors((current) => clearStaleCanvasTextPreviewErrors(current, targetKeys));
      for (const queue of Object.values(presentationQueuesRef.current)) {
        for (const [sourceKey, work] of queue) {
          if (targetKeys.get(work.source.projectRelativePath) !== work.targetKey) {
            queue.delete(sourceKey);
          }
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    canvasId,
    activeInlineTextPath,
    measuredBodies,
    nodes,
    styleKeyState.key,
    textFileBuffers
  ]);

  useEffect(() => {
    const targets = Object.values(currentTargets).filter((target) => (
      target.projectRelativePath !== activeInlineTextPath
      && !culledNodePaths.has(target.projectRelativePath)
      && !availabilityCheckedTargetKeys.has(canvasTextPreviewTargetKey(target))
    ));
    if (targets.length === 0) {
      return undefined;
    }
    let cancelled = false;
    recordTextPreviewCounter('text-preview-source-check-requested', { count: targets.length });
    void actions.readCanvasTextPreviewSources({
      canvasId,
      sources: targets.map(canvasTextPreviewSourceTargetForApi)
    }).then((result) => {
      if (cancelled) {
        return;
      }
      const currentResults = targets.filter((target) => (
        currentTargetKeysRef.current.get(target.projectRelativePath) === canvasTextPreviewTargetKey(target)
      ));
      const successfulResults: CanvasTextPreviewTarget[] = [];
      for (const target of currentResults) {
        const source = result.sources[target.projectRelativePath]!;
        if (source.status === 'error') {
          setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
            'source_availability_failed',
            failureFieldsForTarget(target),
            source.message
          ));
          continue;
        }
        successfulResults.push(target);
        recordTextPreviewCounter('text-preview-source-availability-resolved', {
          projectRelativePath: target.projectRelativePath,
          fingerprint: target.fingerprint,
          available: source.status === 'available'
        });
      }
      setSourceAvailability((current) => canvasTextPreviewSourcesWithAvailability({
        current,
        targets: successfulResults,
        sources: result.sources
      }));
      setAvailabilityCheckedTargetKeys((current) => new Set([
        ...current,
        ...currentResults.map(canvasTextPreviewTargetKey)
      ]));
    }, (error: unknown) => {
      if (cancelled) {
        return;
      }
      for (const target of targets) {
        if (currentTargetKeysRef.current.get(target.projectRelativePath) === canvasTextPreviewTargetKey(target)) {
          setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
            'source_availability_failed',
            failureFieldsForTarget(target),
            error
          ));
        }
      }
      setAvailabilityCheckedTargetKeys((current) => new Set([
        ...current,
        ...targets.map(canvasTextPreviewTargetKey)
      ]));
    });
    return () => {
      cancelled = true;
    };
  }, [
    actions,
    availabilityCheckedTargetKeys,
    activeInlineTextPath,
    canvasId,
    culledNodePaths,
    currentTargets,
    recordTextPreviewCounter,
    setCurrentPreviewFailure
  ]);

  useEffect(() => {
    for (const presentation of Object.values(previewPresentations)) {
      if (presentation.visible) {
        publishingSourceKeysRef.current.delete(presentation.visible.sourceKey);
      }
      if (presentation.pending) {
        publishingSourceKeysRef.current.delete(presentation.pending.sourceKey);
      }
    }
  }, [previewPresentations]);

  useEffect(() => {
    const desiredSourceKeys = new Map<string, string>();
    for (const target of Object.values(currentTargets)) {
      const path = target.projectRelativePath;
      const presentation = previewPresentations[path];
      if (path === activeInlineTextPath) {
        if (presentation?.visible) {
          desiredSourceKeys.set(path, presentation.visible.sourceKey);
          currentResourceKeysRef.current.set(path, presentation.visible.sourceKey);
        } else {
          currentResourceKeysRef.current.delete(path);
        }
        continue;
      }
      if (culledNodePaths.has(path)) {
        const retainedLayer = presentation?.pending ?? presentation?.visible;
        if (retainedLayer) {
          desiredSourceKeys.set(path, retainedLayer.sourceKey);
          currentResourceKeysRef.current.set(path, retainedLayer.sourceKey);
        }
        continue;
      }
      const availability = sourceAvailability[target.projectRelativePath];
      const node = nodesByPath.get(target.projectRelativePath);
      if (!node
        || !availability
        || availability.fingerprint !== target.fingerprint
        || !availability.available) {
        currentResourceKeysRef.current.delete(target.projectRelativePath);
        continue;
      }
      const source = canvasTextPreviewForNode({
        canvasId,
        node,
        target,
        resourceZoom,
        devicePixelRatio
      });
      if (!source) {
        continue;
      }
      const targetKey = canvasTextPreviewTargetKey(target);
      const sourceKey = source.sourceKey;
      desiredSourceKeys.set(target.projectRelativePath, sourceKey);
      currentResourceKeysRef.current.set(target.projectRelativePath, sourceKey);
      const error = previewErrors[target.projectRelativePath];
      if (presentation?.visible?.sourceKey === sourceKey
        || presentation?.pending?.sourceKey === sourceKey
        || presentationQueuesRef.current.mount.has(sourceKey)
        || presentationQueuesRef.current.promote.has(sourceKey)
        || publishingSourceKeysRef.current.has(sourceKey)
        || (error?.targetKey === targetKey && error.sourceKey === sourceKey)) {
        continue;
      }
      const epoch = runtimeEpochRef.current;
      enqueuePresentationWork('mount', {
        epoch,
        targetKey,
        sourceKey,
        source,
        committed: false
      });
      clearCurrentPreviewFailure(target, sourceKey);
    }
    for (const queue of Object.values(presentationQueuesRef.current)) {
      for (const [sourceKey, work] of queue) {
        if (desiredSourceKeys.get(work.source.projectRelativePath) !== sourceKey) {
          queue.delete(sourceKey);
        }
      }
    }
    const desiredSourceKeySet = new Set(desiredSourceKeys.values());
    for (const sourceKey of publishingSourceKeysRef.current) {
      if (!desiredSourceKeySet.has(sourceKey)) {
        publishingSourceKeysRef.current.delete(sourceKey);
      }
    }
    if (canvasTextPreviewPresentationsForDesiredSources({
      current: previewPresentations,
      desiredSourceKeys
    }) !== previewPresentations) {
      setPreviewPresentations((current) => canvasTextPreviewPresentationsForDesiredSources({
        current,
        desiredSourceKeys
      }));
    }
  }, [
    canvasId,
    activeInlineTextPath,
    clearCurrentPreviewFailure,
    culledNodePaths,
    currentTargets,
    devicePixelRatio,
    nodesByPath,
    previewErrors,
    previewPresentations,
    resourceZoom,
    enqueuePresentationWork,
    setCurrentPreviewFailure,
    sourceAvailability
  ]);

  useEffect(() => {
    for (const target of Object.values(currentTargets)) {
      const availability = sourceAvailability[target.projectRelativePath];
      if (availability?.fingerprint === target.fingerprint && availability.available) {
        uploadingTargetKeysRef.current.delete(canvasTextPreviewTargetKey(target));
      }
    }
  }, [currentTargets, sourceAvailability]);

  useEffect(() => {
    if (interactionActive
      || captureTarget
      || Object.values(presentationQueuesRef.current).some((queue) => (
        [...queue.values()].some((work) => presentationWorkCanPublish(work))
      ))) {
      return;
    }
    const failedTargetKeys = new Set(Object.values(previewErrors).map((error) => error.targetKey));
    const next = canvasTextPreviewNextCaptureTarget({
      targets: Object.values(currentTargets).filter((target) => (
        target.projectRelativePath !== activeInlineTextPath
        && !culledNodePaths.has(target.projectRelativePath)
      )),
      sourceAvailability,
      uploadingTargetKeys: uploadingTargetKeysRef.current,
      failedTargetKeys
    });
    if (next) {
      setCaptureTarget(next);
    }
  }, [
    captureTarget,
    activeInlineTextPath,
    currentTargets,
    culledNodePaths,
    interactionActive,
    previewErrors,
    presentationWorkCanPublish,
    sourceAvailability
  ]);

  const finishRasterizedTarget = useCallback((
    target: CanvasTextPreviewTarget,
    raster: CanvasTextPreviewRasterResult
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    const epoch = runtimeEpochRef.current;
    if (!isCurrentTarget(epoch, target)) {
      return;
    }
    uploadingTargetKeysRef.current.add(targetKey);
    setCaptureTarget((current) => current && canvasTextPreviewTargetKey(current) === targetKey
      ? undefined
      : current);
    const startedAt = performance.now();
    void actions.saveCanvasTextPreviewSource({
      ...canvasTextPreviewSourceTargetForApi(target),
      canvasId: target.canvasId,
      sourcePng: raster.sourcePng
    }).then(() => {
      if (!isCurrentTarget(epoch, target)) {
        uploadingTargetKeysRef.current.delete(targetKey);
        return;
      }
      setSourceAvailability((current) => ({
        ...current,
        [target.projectRelativePath]: { fingerprint: target.fingerprint, available: true }
      }));
      clearCurrentPreviewFailure(target);
      recordTextPreviewCounter('text-preview-source-upload-completed', {
        projectRelativePath: target.projectRelativePath,
        fingerprint: target.fingerprint,
        durationMs: performance.now() - startedAt
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
    setCurrentPreviewFailure
  ]);

  const finishFailedTarget = useCallback((target: CanvasTextPreviewTarget, failure: CanvasTextPreviewFailure) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    if (!mountedRef.current
      || currentTargetKeysRef.current.get(target.projectRelativePath) !== targetKey) {
      return;
    }
    setCaptureTarget((current) => !current || canvasTextPreviewTargetKey(current) === targetKey
      ? undefined
      : current);
    setCurrentPreviewFailure(target, failure);
  }, [setCurrentPreviewFailure]);

  const recordCaptureStage = useCallback((event: CanvasTextPreviewCaptureStageEvent) => {
    const counter: CanvasPerfCounterName = event.stage === 'capture-ready'
      ? 'text-preview-capture-ready'
      : event.stage === 'snapshot-built'
        ? 'text-preview-snapshot-built'
        : 'text-preview-raster-completed';
    recordTextPreviewCounter(counter, {
      projectRelativePath: event.target.projectRelativePath,
      fingerprint: event.target.fingerprint,
      durationMs: event.durationMs,
      ...(event.snapshotWidth === undefined ? {} : { snapshotWidth: event.snapshotWidth }),
      ...(event.snapshotHeight === undefined ? {} : { snapshotHeight: event.snapshotHeight }),
      ...(event.snapshotBytes === undefined ? {} : { snapshotBytes: event.snapshotBytes })
    });
  }, [recordTextPreviewCounter]);

  const reportPendingReady = useCallback((node: ProjectedCanvasNode, source: CanvasTextPreviewSource) => {
    const target = currentTargets[node.projectRelativePath];
    const pending = previewPresentations[node.projectRelativePath]?.pending;
    if (!target
      || !pending
      || pending.sourceKey !== source.sourceKey
      || pending.targetKey !== canvasTextPreviewTargetKey(target)
      || currentResourceKeysRef.current.get(node.projectRelativePath) !== source.sourceKey) {
      return;
    }
    enqueuePresentationWork('promote', {
      epoch: runtimeEpochRef.current,
      ...pending
    });
    recordTextPreviewCounter('text-preview-pending-ready', {
      projectRelativePath: source.projectRelativePath,
      fingerprint: source.fingerprint,
      previewWidth: source.previewWidth
    });
  }, [currentTargets, enqueuePresentationWork, previewPresentations, recordTextPreviewCounter]);

  const reportPendingFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown,
    kind: CanvasTextPreviewImageFailureKind
  ) => {
    const target = currentTargets[node.projectRelativePath];
    const pending = previewPresentations[node.projectRelativePath]?.pending;
    if (!target
      || pending?.sourceKey !== source.sourceKey
      || pending.targetKey !== canvasTextPreviewTargetKey(target)
      || currentResourceKeysRef.current.get(node.projectRelativePath) !== source.sourceKey) {
      return;
    }
    presentationQueuesRef.current.promote.delete(source.sourceKey);
    setPreviewPresentations((current) => {
      const existing = current[node.projectRelativePath];
      if (existing?.pending?.sourceKey !== source.sourceKey) {
        return current;
      }
      return {
        ...current,
        [node.projectRelativePath]: { visible: existing.visible, pending: undefined }
      };
    });
    setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
      kind === 'load' ? 'variant_failed' : 'preview_decode_failed',
      failureFieldsForTarget(target),
      error
    ), source.sourceKey);
  }, [currentTargets, previewPresentations, setCurrentPreviewFailure]);

  const reportVisibleFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown,
    kind: CanvasTextPreviewImageFailureKind
  ) => {
    const target = currentTargets[node.projectRelativePath];
    const visible = previewPresentations[node.projectRelativePath]?.visible;
    if (!target
      || visible?.sourceKey !== source.sourceKey
      || visible.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    presentationQueuesRef.current.commit.delete(source.sourceKey);
    setPreviewPresentations((current) => {
      const existing = current[node.projectRelativePath];
      if (existing?.visible?.sourceKey !== source.sourceKey) {
        return current;
      }
      return {
        ...current,
        [node.projectRelativePath]: { visible: undefined, pending: existing.pending }
      };
    });
    setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
      kind === 'load' ? 'variant_failed' : 'preview_decode_failed',
      failureFieldsForTarget(target),
      error
    ), source.sourceKey);
  }, [currentTargets, previewPresentations, setCurrentPreviewFailure]);

  const reportVisibleCommitted = useCallback((node: ProjectedCanvasNode, source: CanvasTextPreviewSource) => {
    const target = currentTargets[node.projectRelativePath];
    const visible = previewPresentations[node.projectRelativePath]?.visible;
    if (!target
      || visible?.sourceKey !== source.sourceKey
      || visible.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    const work: CanvasTextPreviewPresentationWork = {
      epoch: runtimeEpochRef.current,
      ...visible
    };
    enqueuePresentationWork('commit', work);
  }, [currentTargets, enqueuePresentationWork, previewPresentations]);

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    registerTextBody,
    presentationForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const presentation = previewPresentations[node.projectRelativePath];
      if (!target || !canvasTextPreviewTargetMatchesCurrentInputs({
        canvasId,
        target,
        node,
        buffer: textFileBuffers[node.projectRelativePath],
        measuredBody: measuredBodies.get(node.projectRelativePath),
        styleKey: styleKeyState.key
      })) {
        return {};
      }
      const targetKey = canvasTextPreviewTargetKey(target);
      return {
        visible: presentation?.visible?.targetKey === targetKey ? presentation.visible.source : undefined,
        pending: presentation?.pending?.targetKey === targetKey ? presentation.pending.source : undefined,
        ...(presentation?.visible?.targetKey === targetKey && presentation.visible.committed
          ? { visibleCommittedSourceKey: presentation.visible.sourceKey }
          : {})
      };
    },
    previewErrorForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const error = previewErrors[node.projectRelativePath];
      if (!target || error?.targetKey !== canvasTextPreviewTargetKey(target)) {
        return undefined;
      }
      if (error.sourceKey !== undefined
        && currentResourceKeysRef.current.get(node.projectRelativePath) !== error.sourceKey) {
        return undefined;
      }
      return error.error.message;
    },
    reportPendingReady,
    reportPendingFailure,
    reportVisibleFailure,
    reportVisibleCommitted
  }), [
    canvasId,
    currentTargets,
    measuredBodies,
    previewErrors,
    previewPresentations,
    registerTextBody,
    reportPendingFailure,
    reportPendingReady,
    reportVisibleCommitted,
    reportVisibleFailure,
    styleKeyState.key,
    textFileBuffers
  ]);

  const captureLayer = (
    <CanvasTextPreviewCaptureLane
      target={captureTarget}
      interactionActive={interactionActive}
      onStage={recordCaptureStage}
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

export function canvasTextPreviewTargetsForNodes(input: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  textFileBuffers: Record<string, TextFileBuffer>;
  measuredBodies: Map<string, CanvasTextPreviewMeasuredBody>;
  styleKey: string;
}): CanvasTextPreviewCandidate[] {
  const targets: CanvasTextPreviewCandidate[] = [];
  for (const node of [...input.nodes].sort(compareCanvasTextPreviewNodeOrder)) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'text'
      || node.availability.state !== 'available') {
      continue;
    }
    const buffer = input.textFileBuffers[node.projectRelativePath];
    const measured = input.measuredBodies.get(node.projectRelativePath);
    if (!buffer || buffer.error || !measured || measured.width <= 0 || measured.height <= 0) {
      continue;
    }
    targets.push({
      canvasId: input.canvasId,
      projectRelativePath: node.projectRelativePath,
      content: buffer.content,
      language: buffer.language,
      wordWrap: buffer.wordWrap,
      contentCssWidth: measured.width,
      contentCssHeight: measured.height,
      scrollTop: node.textViewport?.scrollTop ?? 0,
      scrollLeft: node.textViewport?.scrollLeft ?? 0,
      styleKey: input.styleKey
    });
  }
  return targets;
}

export function canvasTextPreviewBodyMeasurement(element: HTMLElement): CanvasTextPreviewMeasuredBody {
  return { width: element.clientWidth, height: element.clientHeight };
}

export function canvasTextPreviewNextCaptureTarget(input: {
  targets: CanvasTextPreviewTarget[];
  sourceAvailability: Record<string, CanvasTextPreviewSourceAvailability>;
  uploadingTargetKeys: ReadonlySet<string>;
  failedTargetKeys: ReadonlySet<string>;
}): CanvasTextPreviewTarget | undefined {
  for (const target of input.targets) {
    const availability = input.sourceAvailability[target.projectRelativePath];
    const key = canvasTextPreviewTargetKey(target);
    if (availability?.fingerprint === target.fingerprint
      && !availability.available
      && !input.uploadingTargetKeys.has(key)
      && !input.failedTargetKeys.has(key)) {
      return target;
    }
  }
  return undefined;
}

export function canvasTextPreviewCurrentSourceAvailability(input: {
  targets: CanvasTextPreviewTarget[];
  sourceAvailability: Record<string, CanvasTextPreviewSourceAvailability>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  const targetKeys = new Map(input.targets.map((target) => [target.projectRelativePath, target.fingerprint]));
  return Object.fromEntries(Object.entries(input.sourceAvailability).filter(([path, availability]) => (
    targetKeys.get(path) === availability.fingerprint
  )));
}

export function canvasTextPreviewTargetWidthForNode(input: {
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  return canvasRasterPreviewWidth({
    nodeDisplayWidth: input.node.width,
    sourceWidth: input.target.contentCssWidth * CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
}

function compareCanvasTextPreviewNodeOrder(left: ProjectedCanvasNode, right: ProjectedCanvasNode): number {
  return left.y - right.y
    || left.x - right.x
    || left.projectRelativePath.localeCompare(right.projectRelativePath);
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
  const sourceKey = canvasTextPreviewResourceSourceKey(canvasTextPreviewTargetKey(input.target), previewWidth);
  return {
    projectRelativePath: input.node.projectRelativePath,
    sourceKey,
    src: canvasTextPreviewUrl({
      fileUrl: input.node.availability.fileUrl,
      canvasId: input.canvasId,
      projectRelativePath: input.node.projectRelativePath,
      fingerprint: input.target.fingerprint,
      width: previewWidth
    }),
    previewWidth,
    fingerprint: input.target.fingerprint
  };
}

function canvasTextPreviewUrl(input: {
  fileUrl: string;
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
  width: number;
}): string {
  const projectId = canvasRawFileProjectId(input.fileUrl);
  const params = new URLSearchParams({
    canvasId: input.canvasId,
    path: input.projectRelativePath,
    fingerprint: input.fingerprint,
    w: String(input.width)
  });
  return `/api/projects/${projectId}/canvas-text-preview?${params.toString()}`;
}

function canvasTextPreviewSourcesWithAvailability(input: {
  current: Record<string, CanvasTextPreviewSourceAvailability>;
  targets: CanvasTextPreviewTarget[];
  sources: Record<string, {
    fingerprint: string;
    status: 'available' | 'missing' | 'error';
  }>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  let next = input.current;
  for (const target of input.targets) {
    const source = input.sources[target.projectRelativePath]!;
    const availability = {
      fingerprint: target.fingerprint,
      available: source.status === 'available'
    };
    const existing = next[target.projectRelativePath];
    if (existing?.fingerprint === availability.fingerprint && existing.available === availability.available) {
      continue;
    }
    next = next === input.current ? { ...input.current } : next;
    next[target.projectRelativePath] = availability;
  }
  return next;
}

function canvasTextPreviewCurrentPresentations(input: {
  targets: CanvasTextPreviewTarget[];
  presentations: Record<string, CanvasTextPreviewPresentationState>;
}): Record<string, CanvasTextPreviewPresentationState> {
  const targetKeys = new Map(input.targets.map((target) => [
    target.projectRelativePath,
    canvasTextPreviewTargetKey(target)
  ]));
  let changed = false;
  const next: Record<string, CanvasTextPreviewPresentationState> = {};
  for (const [path, presentation] of Object.entries(input.presentations)) {
    const targetKey = targetKeys.get(path);
    const visible = presentation.visible?.targetKey === targetKey ? presentation.visible : undefined;
    const pending = presentation.pending?.targetKey === targetKey ? presentation.pending : undefined;
    if (!visible && !pending) {
      changed = true;
      continue;
    }
    if (visible !== presentation.visible || pending !== presentation.pending) {
      changed = true;
      next[path] = { visible, pending };
    } else {
      next[path] = presentation;
    }
  }
  return changed ? next : input.presentations;
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
    if (next === input.current) {
      next = { ...input.current };
    }
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
  return Object.fromEntries(Object.entries(errors).filter(([path, error]) => (
    targetKeys.get(path) === error.targetKey
  )));
}

function canvasTextPreviewTargetsByPath(targets: CanvasTextPreviewTarget[]): Record<string, CanvasTextPreviewTarget> {
  return Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
}

function canvasTextPreviewSourceTargetForApi(target: CanvasTextPreviewTarget) {
  return { projectRelativePath: target.projectRelativePath, fingerprint: target.fingerprint };
}

function canvasTextPreviewTargetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

function canvasTextPreviewTargetMatchesCurrentInputs(input: {
  canvasId: string;
  target: CanvasTextPreviewTarget;
  node: ProjectedCanvasNode;
  buffer: TextFileBuffer | undefined;
  measuredBody: CanvasTextPreviewMeasuredBody | undefined;
  styleKey: string | undefined;
}): boolean {
  const { target, node, buffer, measuredBody, styleKey } = input;
  if (node.nodeKind !== 'file'
    || node.mediaKind !== 'text'
    || node.availability.state !== 'available'
    || !buffer
    || buffer.error
    || !measuredBody
    || !styleKey) {
    return false;
  }
  return target.canvasId === input.canvasId
    && target.projectRelativePath === node.projectRelativePath
    && target.content === buffer.content
    && target.language === buffer.language
    && target.wordWrap === buffer.wordWrap
    && target.contentCssWidth === measuredBody.width
    && target.contentCssHeight === measuredBody.height
    && target.scrollTop === (node.textViewport?.scrollTop ?? 0)
    && target.scrollLeft === (node.textViewport?.scrollLeft ?? 0)
    && target.styleKey === styleKey;
}

function canvasTextPreviewResourceSourceKey(targetKey: string, targetWidth: number): string {
  return `${targetKey}\u001f${targetWidth}`;
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
