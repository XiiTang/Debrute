import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import type { CanvasTextPreviewPresentation } from './CanvasTextPreviewImageHandoff';
import type { CanvasCameraState } from './runtime/canvasCamera';
import {
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshotForDocument,
  type CanvasTextPreviewStyleKey
} from './CanvasTextPreviewStyleKey';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';

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
  generation: number;
}

interface CanvasTextPreviewErrorState {
  targetKey: string;
  sourceKey?: string | undefined;
  error: Error;
}

interface CanvasTextPreviewVariantFetchWork {
  projectRelativePath: string;
  controller: AbortController;
}

export interface CanvasTextPreviewRuntimeValue {
  registerTextBody(projectRelativePath: string, element: HTMLElement | null): void;
  presentationForNode(input: { node: ProjectedCanvasNode }): CanvasTextPreviewPresentation;
  previewErrorForNode(input: { node: ProjectedCanvasNode }): string | undefined;
  reportPendingReady(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
  reportPendingFailure(node: ProjectedCanvasNode, source: CanvasTextPreviewSource, error: unknown): void;
  reportVisibleFailure(node: ProjectedCanvasNode, source: CanvasTextPreviewSource, error: unknown): void;
  reportVisibleCommitted(node: ProjectedCanvasNode, source: CanvasTextPreviewSource): void;
}

const defaultRuntimeValue: CanvasTextPreviewRuntimeValue = {
  registerTextBody: () => undefined,
  presentationForNode: () => ({}),
  previewErrorForNode: () => undefined,
  reportPendingReady: () => undefined,
  reportPendingFailure: () => undefined,
  reportVisibleFailure: () => undefined,
  reportVisibleCommitted: () => undefined
};

const CanvasTextPreviewRuntimeContext = createContext<CanvasTextPreviewRuntimeValue>(defaultRuntimeValue);

export function useCanvasTextPreviewRuntime(): CanvasTextPreviewRuntimeValue {
  return useContext(CanvasTextPreviewRuntimeContext);
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
  const [sourceWorkVersion, setSourceWorkVersion] = useState(0);
  const [styleKeyState, setStyleKeyState] = useState<{
    key?: CanvasTextPreviewStyleKey | undefined;
    error?: Error | undefined;
  }>({});
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentTargetsRef = useRef<Record<string, CanvasTextPreviewTarget>>({});
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const currentCanvasIdRef = useRef(canvasId);
  const interactionActive = cameraState !== 'idle' || dragState !== undefined;
  const interactionActiveRef = useRef(interactionActive);
  const runtimeGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const bodyRegistrationsRef = useRef(new Map<string, () => void>());
  const uploadingTargetKeysRef = useRef(new Set<string>());
  const fetchingVariantsRef = useRef(new Map<string, CanvasTextPreviewVariantFetchWork>());
  const pendingMountQueueRef = useRef(new Map<string, CanvasTextPreviewPresentationWork>());
  const readyPromotionQueueRef = useRef(new Map<string, CanvasTextPreviewPresentationWork>());
  const deferredVisibleCommitQueueRef = useRef(new Map<string, CanvasTextPreviewPresentationWork>());
  const publishingSourceKeysRef = useRef(new Set<string>());
  const publicationFrameRef = useRef<number | undefined>(undefined);
  const publishNextFrameRef = useRef<() => void>(() => undefined);
  currentCanvasIdRef.current = canvasId;
  currentTargetsRef.current = currentTargets;
  interactionActiveRef.current = interactionActive;
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

  const isCurrentTarget = useCallback((generation: number, target: CanvasTextPreviewTarget): boolean => (
    mountedRef.current
    && generation === runtimeGenerationRef.current
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

  const commitVisiblePresentation = useCallback((work: CanvasTextPreviewPresentationWork) => {
    const path = work.source.projectRelativePath;
    const target = currentTargets[path];
    const visible = previewPresentations[path]?.visible;
    if (!target
      || work.generation !== runtimeGenerationRef.current
      || work.targetKey !== canvasTextPreviewTargetKey(target)
      || visible?.sourceKey !== work.sourceKey
      || visible.committed
      || currentResourceKeysRef.current.get(path) !== work.sourceKey) {
      return;
    }
    setPreviewPresentations((current) => {
      const existing = current[path];
      if (!existing?.visible
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
      projectRelativePath: work.source.projectRelativePath,
      fingerprint: work.source.fingerprint,
      previewWidth: work.source.previewWidth
    });
  }, [clearCurrentPreviewFailure, currentTargets, previewPresentations, recordTextPreviewCounter]);

  const firstCurrentPresentationWork = useCallback((
    queue: Map<string, CanvasTextPreviewPresentationWork>
  ): CanvasTextPreviewPresentationWork | undefined => {
    for (const [sourceKey, work] of queue) {
      const path = work.source.projectRelativePath;
      if (work.generation === runtimeGenerationRef.current
        && currentTargetKeysRef.current.get(path) === work.targetKey
        && currentResourceKeysRef.current.get(path) === work.sourceKey) {
        return work;
      }
      queue.delete(sourceKey);
    }
    return undefined;
  }, []);

  const schedulePublicationFrame = useCallback(() => {
    if (!mountedRef.current
      || interactionActiveRef.current
      || publicationFrameRef.current !== undefined
      || (deferredVisibleCommitQueueRef.current.size === 0
        && readyPromotionQueueRef.current.size === 0
        && pendingMountQueueRef.current.size === 0)) {
      return;
    }
    publicationFrameRef.current = window.requestAnimationFrame(() => publishNextFrameRef.current());
  }, []);

  publishNextFrameRef.current = () => {
    publicationFrameRef.current = undefined;
    if (!mountedRef.current || interactionActiveRef.current) {
      return;
    }
    const visibleCommit = firstCurrentPresentationWork(deferredVisibleCommitQueueRef.current);
    if (visibleCommit) {
      deferredVisibleCommitQueueRef.current.delete(visibleCommit.sourceKey);
      commitVisiblePresentation(visibleCommit);
      schedulePublicationFrame();
      return;
    }
    const promotion = firstCurrentPresentationWork(readyPromotionQueueRef.current);
    if (promotion) {
      readyPromotionQueueRef.current.delete(promotion.sourceKey);
      publishingSourceKeysRef.current.add(promotion.sourceKey);
      setPreviewPresentations((current) => {
        const existing = current[promotion.source.projectRelativePath];
        if (existing?.pending?.sourceKey !== promotion.sourceKey) {
          return current;
        }
        return {
          ...current,
          [promotion.source.projectRelativePath]: {
            visible: canvasTextPreviewLayerFromWork(promotion),
            pending: undefined
          }
        };
      });
      schedulePublicationFrame();
      return;
    }
    const mount = firstCurrentPresentationWork(pendingMountQueueRef.current);
    if (!mount) {
      return;
    }
    pendingMountQueueRef.current.delete(mount.sourceKey);
    publishingSourceKeysRef.current.add(mount.sourceKey);
    setPreviewPresentations((current) => {
      const existing = current[mount.source.projectRelativePath];
      return {
        ...current,
        [mount.source.projectRelativePath]: {
          visible: existing?.visible?.targetKey === mount.targetKey ? existing.visible : undefined,
          pending: canvasTextPreviewLayerFromWork(mount)
        }
      };
    });
    schedulePublicationFrame();
  };

  useEffect(() => {
    mountedRef.current = true;
    runtimeGenerationRef.current += 1;
    const generation = runtimeGenerationRef.current;
    return () => {
      if (runtimeGenerationRef.current === generation) {
        runtimeGenerationRef.current += 1;
      }
      mountedRef.current = false;
      if (publicationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(publicationFrameRef.current);
        publicationFrameRef.current = undefined;
      }
      for (const work of fetchingVariantsRef.current.values()) {
        work.controller.abort();
      }
      fetchingVariantsRef.current.clear();
      pendingMountQueueRef.current.clear();
      readyPromotionQueueRef.current.clear();
      deferredVisibleCommitQueueRef.current.clear();
      publishingSourceKeysRef.current.clear();
      uploadingTargetKeysRef.current.clear();
      for (const cleanup of bodyRegistrationsRef.current.values()) {
        cleanup();
      }
      bodyRegistrationsRef.current.clear();
    };
  }, [canvasId]);

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
    currentResourceKeysRef.current.delete(path);
    for (const [sourceKey, work] of fetchingVariantsRef.current) {
      if (work.projectRelativePath === path) {
        work.controller.abort();
        fetchingVariantsRef.current.delete(sourceKey);
      }
    }
    for (const queue of [
      pendingMountQueueRef.current,
      readyPromotionQueueRef.current,
      deferredVisibleCommitQueueRef.current
    ]) {
      for (const [sourceKey, work] of queue) {
        if (work.source.projectRelativePath === path) {
          queue.delete(sourceKey);
        }
      }
    }
    setPreviewPresentations((current) => withoutRecordPath(current, path));
    setPreviewErrors((current) => withoutRecordPath(current, path));
    setSourceWorkVersion((current) => current + 1);
  }, [activeInlineTextPath]);

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
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(commit);
      observer.observe(element);
      cleanup.push(() => observer.disconnect());
    }
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
      for (const [sourceKey, work] of fetchingVariantsRef.current) {
        if (targetKeys.get(work.projectRelativePath) === undefined
          || currentResourceKeysRef.current.get(work.projectRelativePath) !== sourceKey) {
          work.controller.abort();
          fetchingVariantsRef.current.delete(sourceKey);
        }
      }
      for (const queue of [
        pendingMountQueueRef.current,
        readyPromotionQueueRef.current,
        deferredVisibleCommitQueueRef.current
      ]) {
        for (const [sourceKey, work] of queue) {
          if (targetKeys.get(work.source.projectRelativePath) !== work.targetKey) {
            queue.delete(sourceKey);
          }
        }
      }
      setSourceWorkVersion((current) => current + 1);
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
      setSourceWorkVersion((current) => current + 1);
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
        currentResourceKeysRef.current.delete(path);
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
        || fetchingVariantsRef.current.has(sourceKey)
        || pendingMountQueueRef.current.has(sourceKey)
        || readyPromotionQueueRef.current.has(sourceKey)
        || publishingSourceKeysRef.current.has(sourceKey)
        || (error?.targetKey === targetKey && error.sourceKey === sourceKey)) {
        continue;
      }
      const generation = runtimeGenerationRef.current;
      const controller = new AbortController();
      fetchingVariantsRef.current.set(sourceKey, {
        projectRelativePath: target.projectRelativePath,
        controller
      });
      const startedAt = performance.now();
      void fetchCanvasTextPreviewVariant({
        source,
        fields: failureFieldsForTarget(target),
        signal: controller.signal
      }).then(() => {
        if (!isCurrentTarget(generation, target)
          || currentResourceKeysRef.current.get(target.projectRelativePath) !== sourceKey) {
          return;
        }
        pendingMountQueueRef.current.set(sourceKey, {
          generation,
          targetKey,
          sourceKey,
          source,
          committed: false
        });
        clearCurrentPreviewFailure(target, sourceKey);
        recordTextPreviewCounter('text-preview-variant-fetched', {
          projectRelativePath: target.projectRelativePath,
          fingerprint: target.fingerprint,
          previewWidth: source.previewWidth,
          durationMs: performance.now() - startedAt
        });
        setSourceWorkVersion((current) => current + 1);
        schedulePublicationFrame();
      }, (error: unknown) => {
        if (!controller.signal.aborted && isCurrentTarget(generation, target)) {
          setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
            'variant_failed',
            failureFieldsForTarget(target),
            error
          ), sourceKey);
        }
      }).finally(() => {
        if (fetchingVariantsRef.current.get(sourceKey)?.controller === controller) {
          fetchingVariantsRef.current.delete(sourceKey);
        }
        if (mountedRef.current) {
          setSourceWorkVersion((current) => current + 1);
        }
      });
    }
    for (const [sourceKey, work] of fetchingVariantsRef.current) {
      if (desiredSourceKeys.get(work.projectRelativePath) !== sourceKey) {
        work.controller.abort();
        fetchingVariantsRef.current.delete(sourceKey);
      }
    }
    for (const queue of [
      pendingMountQueueRef.current,
      readyPromotionQueueRef.current,
      deferredVisibleCommitQueueRef.current
    ]) {
      for (const [sourceKey, work] of queue) {
        if (desiredSourceKeys.get(work.source.projectRelativePath) !== sourceKey) {
          queue.delete(sourceKey);
        }
      }
    }
    setPreviewPresentations((current) => canvasTextPreviewPresentationsForDesiredSources({
      current,
      desiredSourceKeys
    }));
  }, [
    canvasId,
    activeInlineTextPath,
    clearCurrentPreviewFailure,
    culledNodePaths,
    currentTargets,
    devicePixelRatio,
    isCurrentTarget,
    nodesByPath,
    previewErrors,
    previewPresentations,
    recordTextPreviewCounter,
    resourceZoom,
    schedulePublicationFrame,
    setCurrentPreviewFailure,
    sourceAvailability,
    sourceWorkVersion
  ]);

  useEffect(() => {
    if (interactionActive) {
      if (publicationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(publicationFrameRef.current);
        publicationFrameRef.current = undefined;
      }
      return;
    }
    schedulePublicationFrame();
  }, [interactionActive, schedulePublicationFrame, sourceWorkVersion]);

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
      || publicationFrameRef.current !== undefined
      || deferredVisibleCommitQueueRef.current.size > 0
      || readyPromotionQueueRef.current.size > 0
      || pendingMountQueueRef.current.size > 0) {
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
    sourceAvailability,
    sourceWorkVersion
  ]);

  const finishRasterizedTarget = useCallback((
    target: CanvasTextPreviewTarget,
    raster: CanvasTextPreviewRasterResult
  ) => {
    const targetKey = canvasTextPreviewTargetKey(target);
    const generation = runtimeGenerationRef.current;
    if (!isCurrentTarget(generation, target)) {
      return;
    }
    uploadingTargetKeysRef.current.add(targetKey);
    setCaptureTarget((current) => current && canvasTextPreviewTargetKey(current) === targetKey
      ? undefined
      : current);
    setSourceWorkVersion((current) => current + 1);
    const startedAt = performance.now();
    void actions.saveCanvasTextPreviewSource({
      ...canvasTextPreviewSourceTargetForApi(target),
      canvasId: target.canvasId,
      sourcePng: raster.sourcePng
    }).then(() => {
      if (!isCurrentTarget(generation, target)) {
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
      if (isCurrentTarget(generation, target)) {
        setCurrentPreviewFailure(target, canvasTextPreviewFailureFromUnknown(
          'source_upload_failed',
          failureFieldsForTarget(target),
          error
        ));
      }
      if (mountedRef.current) {
        setSourceWorkVersion((current) => current + 1);
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
    setSourceWorkVersion((current) => current + 1);
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
    readyPromotionQueueRef.current.set(source.sourceKey, {
      generation: runtimeGenerationRef.current,
      ...pending
    });
    recordTextPreviewCounter('text-preview-pending-ready', {
      projectRelativePath: source.projectRelativePath,
      fingerprint: source.fingerprint,
      previewWidth: source.previewWidth
    });
    schedulePublicationFrame();
  }, [currentTargets, previewPresentations, recordTextPreviewCounter, schedulePublicationFrame]);

  const reportPendingFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown
  ) => {
    const target = currentTargets[node.projectRelativePath];
    const pending = previewPresentations[node.projectRelativePath]?.pending;
    if (!target
      || pending?.sourceKey !== source.sourceKey
      || pending.targetKey !== canvasTextPreviewTargetKey(target)
      || currentResourceKeysRef.current.get(node.projectRelativePath) !== source.sourceKey) {
      return;
    }
    readyPromotionQueueRef.current.delete(source.sourceKey);
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
      'preview_decode_failed',
      failureFieldsForTarget(target),
      error
    ), source.sourceKey);
  }, [currentTargets, previewPresentations, setCurrentPreviewFailure]);

  const reportVisibleFailure = useCallback((
    node: ProjectedCanvasNode,
    source: CanvasTextPreviewSource,
    error: unknown
  ) => {
    const target = currentTargets[node.projectRelativePath];
    const visible = previewPresentations[node.projectRelativePath]?.visible;
    if (!target
      || visible?.sourceKey !== source.sourceKey
      || visible.targetKey !== canvasTextPreviewTargetKey(target)) {
      return;
    }
    deferredVisibleCommitQueueRef.current.delete(source.sourceKey);
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
      'preview_decode_failed',
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
      generation: runtimeGenerationRef.current,
      ...visible
    };
    if (interactionActiveRef.current) {
      deferredVisibleCommitQueueRef.current.set(source.sourceKey, work);
      return;
    }
    commitVisiblePresentation(work);
  }, [commitVisiblePresentation, currentTargets, previewPresentations]);

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    registerTextBody,
    presentationForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const presentation = previewPresentations[node.projectRelativePath];
      if (!target) {
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
    currentTargets,
    previewErrors,
    previewPresentations,
    registerTextBody,
    reportPendingFailure,
    reportPendingReady,
    reportVisibleCommitted,
    reportVisibleFailure
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

export async function fetchCanvasTextPreviewVariant(input: {
  source: CanvasTextPreviewSource;
  fields: CanvasTextPreviewFailureFields;
  signal: AbortSignal;
  request?: typeof fetch | undefined;
}): Promise<void> {
  const request = input.request ?? fetch;
  let response: Response;
  try {
    response = await request(input.source.src, {
      signal: input.signal,
      credentials: 'same-origin'
    });
    if (!response.ok) {
      throw new Error(`Canvas text preview variant request failed with HTTP ${response.status}.`);
    }
    await response.blob();
  } catch (error) {
    throw canvasTextPreviewFailureFromUnknown('variant_failed', input.fields, error);
  }
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
  const sourceUrl = new URL(input.fileUrl, 'http://debrute.local');
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas text preview file URL must include a project id.');
  }
  const params = new URLSearchParams({
    canvasId: input.canvasId,
    path: input.projectRelativePath,
    fingerprint: input.fingerprint,
    w: String(input.width)
  });
  return `/api/projects/${projectMatch[1]}/canvas-text-preview?${params.toString()}`;
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
