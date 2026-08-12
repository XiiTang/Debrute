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
import type {
  CanvasFeedbackDocument,
  CanvasFeedbackVideoResource,
  CanvasVideoMetadata,
  CanvasVideoPreviewSourceView
} from '@debrute/app-protocol';
import {
  canvasPreviewContinuityKey,
  type CanvasPreviewTargetKey
} from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene';
import type { CanvasSceneActions } from './CanvasSceneActions';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle';
import type { CanvasSourceResolutionRuntime } from './CanvasSourceResolutionRuntime';
import { createCanvasPathSnapshotStore } from './CanvasPathSnapshotStore';
import { canvasVideoPreviewUrl } from './canvasVideoPreviews';
import {
  sameCanvasRasterPreviewRequest,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation';
import { canvasRawFileBindingId } from './canvasRawFileUrls';
import {
  compareCanvasPreviewPaths,
  orderCanvasPreviewItemsByNode
} from './CanvasPreviewScheduling';
import {
  canvasVideoPreviewReadWindow,
  canvasVideoPreviewTargetIdentity,
  canvasVideoPreviewTargetKey,
  reconcileCanvasVideoPreviewTasks,
  removeCanvasVideoPreviewTask,
  retryCanvasVideoPreviewTask,
  updateCanvasVideoPreviewTask,
  type CanvasVideoPreviewFailure,
  type CanvasVideoPreviewTarget,
  type CanvasVideoPreviewTask
} from './CanvasVideoPreviewTaskRegistry';
import { useCanvasPreviewInteractionGate } from './useCanvasPreviewInteractionGate';
import type { CanvasRect } from './runtime/canvasGeometry';

const MAX_CAPTURE_DIMENSION = 4096;
const VIDEO_CAPTURE_TIMEOUT_MS = 30_000;
const VIDEO_PREVIEW_SOURCE_JPEG_QUALITY = 0.95;

class CanvasVideoFrameFailure extends Error {
  readonly stage: 'decode' | 'capture';

  constructor(stage: 'decode' | 'capture', message: string) {
    super(message);
    this.name = 'CanvasVideoFrameFailure';
    this.stage = stage;
  }
}

interface CanvasVideoPreviewSource {
  readonly targetKey: CanvasPreviewTargetKey;
  readonly sourceWidth: number;
  readonly metadata: CanvasVideoMetadata;
}

interface CanvasVideoPreviewReadRequestState {
  readonly abortController: AbortController;
  readonly targets: readonly CanvasVideoPreviewTarget[];
}

interface CanvasVideoPreviewCaptureRequestState {
  readonly abortController: AbortController;
  readonly target: CanvasVideoPreviewTarget;
}

export interface CanvasVideoMetadataUpdate {
  readonly projectRelativePath: string;
  readonly sourceRevision: string;
  readonly metadata: CanvasVideoMetadata;
}

export interface CanvasVideoPreviewRuntimeValue {
  retryPreview(projectRelativePath: string): void;
  acceptNode(node: ProjectedCanvasNode): void;
  getNodeSnapshot(node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export interface CanvasVideoPreviewNodeSnapshot {
  readonly request: CanvasRasterPreviewRequest;
  readonly previewError: string | undefined;
  readonly metadata: CanvasVideoMetadata | undefined;
}

const CanvasVideoPreviewRuntimeContext = createContext<CanvasVideoPreviewRuntimeValue | undefined>(undefined);
const EMPTY_FEEDBACK_VIDEO_RESOURCES: readonly CanvasFeedbackVideoResource[] = [];

export function useCanvasVideoPreviewRuntime(): CanvasVideoPreviewRuntimeValue {
  const runtime = useContext(CanvasVideoPreviewRuntimeContext);
  if (!runtime) throw new Error('CanvasVideoPreviewProvider is required.');
  return runtime;
}

export function useCanvasVideoPreviewNode(node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot {
  const runtime = useCanvasVideoPreviewRuntime();
  useLayoutEffect(() => runtime.acceptNode(node), [node, runtime]);
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeNode(node, listener),
    [node, runtime]
  );
  const getSnapshot = useCallback(() => runtime.getNodeSnapshot(node), [node, runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function CanvasVideoPreviewProvider({
  nodes,
  feedbackVideoResources = EMPTY_FEEDBACK_VIDEO_RESOURCES,
  sourceResolutionRuntime,
  activeVideoPaths,
  feedbackEntries,
  actions,
  previewOrder,
  previewResourceScheduler,
  onMetadata,
  children
}: {
  nodes: ProjectedCanvasNode[];
  feedbackVideoResources?: readonly CanvasFeedbackVideoResource[] | undefined;
  sourceResolutionRuntime: Pick<
    CanvasSourceResolutionRuntime,
    'getNode' | 'getResolvedSource' | 'getSourceVersion' | 'subscribeSources'
  >;
  activeVideoPaths: ReadonlySet<string>;
  feedbackEntries?: CanvasFeedbackDocument['entries'] | undefined;
  actions: CanvasSceneActions;
  previewOrder: CanvasPreviewOrderSource;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  onMetadata?: ((update: CanvasVideoMetadataUpdate) => void) | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  const sourceVersion = useSyncExternalStore(
    sourceResolutionRuntime.subscribeSources,
    sourceResolutionRuntime.getSourceVersion,
    sourceResolutionRuntime.getSourceVersion
  );
  const resolvedFeedbackVideoResources = useMemo(() => (
    feedbackVideoResources.flatMap((resource) => {
      if (resource.nodeKind !== 'file' || resource.mediaKind !== 'video') return [];
      const resolved = sourceResolutionRuntime.getResolvedSource(resource.projectRelativePath);
      return [{
        ...resource,
        ...(resolved ? { availability: resolved.availability } : {})
      }];
    })
  ), [feedbackVideoResources, sourceResolutionRuntime, sourceVersion]);
  const [tasks, setTasks] = useState<Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>>(() => new Map());
  const [sources, setSources] = useState<Map<CanvasPreviewTargetKey, CanvasVideoPreviewSource>>(() => new Map());
  const [failures, setFailures] = useState<Map<CanvasPreviewTargetKey, CanvasVideoPreviewFailure>>(() => new Map());
  const tasksRef = useRef(tasks);
  const sourcesRef = useRef(sources);
  const failuresRef = useRef(failures);
  const currentTargetsRef = useRef(new Map<CanvasPreviewTargetKey, CanvasVideoPreviewTarget>());
  const primaryTargetsRef = useRef(new Map<string, CanvasVideoPreviewTarget>());
  const changedPathsRef = useRef(new Set<string>());
  const readRequestRef = useRef<CanvasVideoPreviewReadRequestState | undefined>(undefined);
  const captureRequestRef = useRef<CanvasVideoPreviewCaptureRequestState | undefined>(undefined);
  const mountedRef = useRef(true);
  const activeVideoPathsRef = useRef(activeVideoPaths);
  const visibleVideoPathsRef = useRef<ReadonlySet<string>>(new Set());
  tasksRef.current = tasks;
  sourcesRef.current = sources;
  failuresRef.current = failures;
  activeVideoPathsRef.current = activeVideoPaths;

  const updateTasks = useCallback((update: (
    current: Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>
  ) => Map<CanvasPreviewTargetKey, CanvasVideoPreviewTask>) => {
    setTasks((current) => {
      const next = update(current);
      tasksRef.current = next;
      return next;
    });
  }, []);
  const hasPendingPreviewWork = useCallback(() => tasksRef.current.size > 0, []);
  const { interactionActiveRef, resumeVersion } = useCanvasPreviewInteractionGate({
    scheduler: previewResourceScheduler,
    hasPendingWork: hasPendingPreviewWork
  });
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const nodesByPath = useMemo(
    () => new Map(nodes.map((node) => [node.projectRelativePath, node])),
    [nodes]
  );
  const orderedTasks = useMemo(() => orderCanvasVideoPreviewTasks({
    tasks: [...tasks.values()],
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [nodesByPath, previewOrderSnapshot, tasks]);

  useEffect(() => {
    const resolvedNodes = nodes.map((node) => sourceResolutionRuntime.getNode(node.projectRelativePath) ?? node);
    const visibleVideoPaths = new Set(resolvedNodes.map((node) => node.projectRelativePath));
    const newlyVisibleVideoPaths = new Set(
      [...visibleVideoPaths].filter((path) => !visibleVideoPathsRef.current.has(path))
    );
    visibleVideoPathsRef.current = visibleVideoPaths;
    const targets = canvasVideoPreviewTargetsForNodes(
      resolvedNodes,
      feedbackEntries,
      resolvedFeedbackVideoResources
    );
    const targetMap = new Map(targets.map((target) => [canvasVideoPreviewTargetKey(target), target]));
    const primaryTargets = new Map(canvasVideoPreviewTargetsForNodes(resolvedNodes).map((target) => [
      target.projectRelativePath,
      target
    ]));
    const workTargets = targets.filter((target) => !activeVideoPaths.has(target.projectRelativePath));
    const retainedSources = new Map(
      [...sourcesRef.current].filter(([key]) => targetMap.has(key))
    );
    const retainedFailures = new Map(
      [...failuresRef.current].filter(([key]) => {
        const target = targetMap.get(key);
        return target !== undefined
          && !newlyVisibleVideoPaths.has(target.projectRelativePath);
      })
    );
    for (const [path, previous] of primaryTargetsRef.current) {
      const next = primaryTargets.get(path);
      if (!next || canvasVideoPreviewTargetKey(next) !== canvasVideoPreviewTargetKey(previous)) {
        changedPathsRef.current.add(path);
      }
    }
    for (const path of primaryTargets.keys()) {
      if (!primaryTargetsRef.current.has(path)) changedPathsRef.current.add(path);
    }
    currentTargetsRef.current = targetMap;
    primaryTargetsRef.current = primaryTargets;
    sourcesRef.current = retainedSources;
    failuresRef.current = retainedFailures;
    setSources(retainedSources);
    setFailures(retainedFailures);
    updateTasks((current) => {
      let retrying = current;
      for (const task of current.values()) {
        if (newlyVisibleVideoPaths.has(task.projectRelativePath)) {
          retrying = retryCanvasVideoPreviewTask(retrying, task);
        }
      }
      return reconcileCanvasVideoPreviewTasks({
        previous: retrying,
        targets: workTargets,
        readyTargetKeys: new Set(retainedSources.keys())
      });
    });
    const capture = captureRequestRef.current;
    if (capture && (
      !targetMap.has(canvasVideoPreviewTargetKey(capture.target))
      || activeVideoPaths.has(capture.target.projectRelativePath)
    )) {
      capture.abortController.abort();
      captureRequestRef.current = undefined;
    }
  }, [
    activeVideoPaths,
    feedbackEntries,
    nodes,
    resolvedFeedbackVideoResources,
    sourceResolutionRuntime,
    updateTasks
  ]);

  useEffect(() => {
    if (interactionActiveRef.current || readRequestRef.current) return;
    const selected = canvasVideoPreviewReadWindow(orderedTasks.filter(isCurrentTarget));
    if (selected.length === 0) return;
    const request: CanvasVideoPreviewReadRequestState = {
      abortController: new AbortController(),
      targets: selected
    };
    readRequestRef.current = request;
    updateTasks((current) => selected.reduce(
      (next, target) => updateCanvasVideoPreviewTask(next, target, { state: 'reading' }),
      current
    ));
    void actions.readCanvasVideoPreviewSources({
      targets: selected.map(canvasVideoPreviewTargetForApi)
    }, request.abortController.signal).then((result) => {
      if (!mountedRef.current || readRequestRef.current !== request) return;
      readRequestRef.current = undefined;
      for (const target of selected) {
        if (!isCurrentTarget(target)) continue;
        const source = result.sources.find((candidate) => sameApiTarget(candidate, target));
        applyReadResult(target, source);
      }
      wakeTasks();
    }, (error: unknown) => {
      if (!mountedRef.current || readRequestRef.current !== request) return;
      readRequestRef.current = undefined;
      if (isAbortError(error)) {
        updateTasks((current) => selected.reduce((next, target) => (
          isCurrentTarget(target)
            ? updateCanvasVideoPreviewTask(next, target, { state: 'needs-read' })
            : next
        ), current));
      } else {
        for (const target of selected) failTarget(target, 'read', messageFromUnknown(error));
      }
      wakeTasks();
    });

    function applyReadResult(
      target: CanvasVideoPreviewTarget,
      source: CanvasVideoPreviewSourceView | undefined
    ): void {
      if (!source) {
        failTarget(target, 'read', `Canvas video preview response is missing ${target.projectRelativePath}.`);
        return;
      }
      if (source.status === 'error') {
        failTarget(target, 'read', source.message);
        return;
      }
      if (source.metadata) publishMetadata(target, source.metadata);
      clearFailure(target);
      if (source.status === 'missing') {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'needs-capture' }));
        return;
      }
      publishSource(target, source.sourceWidth, source.metadata);
    }

    function wakeTasks(): void {
      updateTasks((current) => current.size > 0 ? new Map(current) : current);
    }
  }, [actions, interactionActiveRef, orderedTasks, resumeVersion, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || captureRequestRef.current) return;
    const target = orderedTasks.find((task) => task.state === 'needs-capture' && isCurrentTarget(task));
    if (!target) return;
    const request: CanvasVideoPreviewCaptureRequestState = {
      abortController: new AbortController(),
      target
    };
    captureRequestRef.current = request;
    updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'capturing' }));
    void captureCanvasVideoFrame(target, request.abortController.signal).then(async (capture) => {
      if (!mountedRef.current || captureRequestRef.current !== request || !isCurrentTarget(target)) return;
      publishMetadata(target, capture.metadata);
      updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'saving' }));
      return actions.saveCanvasVideoPreviewSource({
        ...canvasVideoPreviewTargetForApi(target),
        metadata: capture.metadata,
        sourceImage: capture.sourceImage
      }, request.abortController.signal).then((result) => {
        if (!mountedRef.current || captureRequestRef.current !== request || !isCurrentTarget(target)) return;
        publishSource(target, result.source.sourceWidth, result.source.metadata);
      });
    }).then(() => {
      if (!mountedRef.current || captureRequestRef.current !== request) return;
      captureRequestRef.current = undefined;
      wakeTasks();
    }, (error: unknown) => {
      if (!mountedRef.current || captureRequestRef.current !== request) return;
      captureRequestRef.current = undefined;
      if (isAbortError(error)) {
        if (isCurrentTarget(target)) {
          updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'needs-capture' }));
        }
      } else {
        const task = tasksRef.current.get(canvasVideoPreviewTargetKey(target));
        const stage = task?.state === 'saving'
          ? 'save'
          : error instanceof CanvasVideoFrameFailure ? error.stage : 'decode';
        failTarget(target, stage, messageFromUnknown(error));
      }
      wakeTasks();
    });

    function wakeTasks(): void {
      updateTasks((current) => current.size > 0 ? new Map(current) : current);
    }
  }, [actions, interactionActiveRef, orderedTasks, resumeVersion, updateTasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readRequestRef.current?.abortController.abort();
      captureRequestRef.current?.abortController.abort();
      for (const path of primaryTargetsRef.current.keys()) {
        previewResourceScheduler.cancel('video', path);
      }
    };
  }, [previewResourceScheduler]);

  function isCurrentTarget(target: CanvasVideoPreviewTarget): boolean {
    return currentTargetsRef.current.has(canvasVideoPreviewTargetKey(target))
      && !activeVideoPathsRef.current.has(target.projectRelativePath);
  }

  function publishMetadata(target: CanvasVideoPreviewTarget, metadata: CanvasVideoMetadata): void {
    onMetadata?.({
      projectRelativePath: target.projectRelativePath,
      sourceRevision: target.sourceRevision,
      metadata
    });
  }

  function publishSource(
    target: CanvasVideoPreviewTarget,
    sourceWidth: number,
    metadata: CanvasVideoMetadata
  ): void {
    const key = canvasVideoPreviewTargetKey(target);
    setSources((current) => {
      const next = new Map(current);
      next.set(key, { targetKey: key, sourceWidth, metadata });
      sourcesRef.current = next;
      return next;
    });
    clearFailure(target);
    changedPathsRef.current.add(target.projectRelativePath);
    updateTasks((current) => removeCanvasVideoPreviewTask(current, target));
  }

  function failTarget(
    target: CanvasVideoPreviewTarget,
    stage: CanvasVideoPreviewFailure['stage'],
    message: string
  ): void {
    if (!isCurrentTarget(target)) return;
    const failure = { stage, message };
    updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'failed', failure }));
    setFailures((current) => {
      const next = new Map(current);
      next.set(canvasVideoPreviewTargetKey(target), failure);
      failuresRef.current = next;
      return next;
    });
    changedPathsRef.current.add(target.projectRelativePath);
  }

  function clearFailure(target: CanvasVideoPreviewTarget): void {
    const key = canvasVideoPreviewTargetKey(target);
    if (!failuresRef.current.has(key)) return;
    setFailures((current) => {
      const next = new Map(current);
      next.delete(key);
      failuresRef.current = next;
      return next;
    });
    changedPathsRef.current.add(target.projectRelativePath);
  }

  const retryPreview = useCallback<CanvasVideoPreviewRuntimeValue['retryPreview']>((path) => {
    const target = primaryTargetsRef.current.get(path);
    if (!target) return;
    updateTasks((current) => {
      const retried = retryCanvasVideoPreviewTask(current, target);
      return retried !== current
        ? retried
        : new Map(current).set(canvasVideoPreviewTargetKey(target), { ...target, state: 'needs-read' });
    });
    clearFailure(target);
  }, [updateTasks]);

  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot => {
    const target = primaryTargetsRef.current.get(node.projectRelativePath);
    if (!target) return { request: {}, previewError: undefined, metadata: undefined };
    const key = canvasVideoPreviewTargetKey(target);
    const source = sourcesRef.current.get(key);
    return {
      request: canvasVideoRasterPreviewRequest({ target, source }),
      previewError: failuresRef.current.get(key)?.message,
      metadata: source?.metadata
    };
  }, []);
  const nodeSnapshotStore = useMemo(() => createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: (left: CanvasVideoPreviewNodeSnapshot, right: CanvasVideoPreviewNodeSnapshot) => (
      sameCanvasRasterPreviewRequest(left.request, right.request)
      && left.previewError === right.previewError
      && sameVideoMetadata(left.metadata, right.metadata)
    )
  }), [deriveNodeSnapshot]);

  const acceptNode = useCallback((node: ProjectedCanvasNode) => {
    const target = canvasVideoPreviewTargetsForNodes([node])[0];
    if (!target) return;
    const key = canvasVideoPreviewTargetKey(target);
    primaryTargetsRef.current.set(target.projectRelativePath, target);
    currentTargetsRef.current.set(key, target);
    if (!sourcesRef.current.has(key) && !activeVideoPathsRef.current.has(target.projectRelativePath)) {
      updateTasks((current) => current.has(key)
        ? current
        : new Map(current).set(key, { ...target, state: 'needs-read' }));
    }
    nodeSnapshotStore.flush(new Set([target.projectRelativePath]));
  }, [nodeSnapshotStore, updateTasks]);

  const commandHandlersRef = useRef({ retryPreview, acceptNode });
  commandHandlersRef.current = { retryPreview, acceptNode };
  useLayoutEffect(() => {
    const paths = new Set(changedPathsRef.current);
    changedPathsRef.current.clear();
    nodeSnapshotStore.flush(paths);
  });
  const value = useMemo<CanvasVideoPreviewRuntimeValue>(() => ({
    retryPreview: (...args) => commandHandlersRef.current.retryPreview(...args),
    acceptNode: (...args) => commandHandlersRef.current.acceptNode(...args),
    getNodeSnapshot: nodeSnapshotStore.getSnapshot,
    subscribeNode: nodeSnapshotStore.subscribe
  }), [nodeSnapshotStore]);

  return (
    <CanvasVideoPreviewRuntimeContext.Provider value={value}>
      {children}
    </CanvasVideoPreviewRuntimeContext.Provider>
  );
}

export function canvasVideoRasterPreviewRequest(input: {
  target: CanvasVideoPreviewTarget;
  source: { sourceWidth: number } | undefined;
}): CanvasRasterPreviewRequest {
  if (!input.source) return {};
  const targetIdentity = canvasVideoPreviewTargetIdentity(input.target);
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'video',
      bindingId: input.target.bindingId,
      projectRelativePath: input.target.projectRelativePath,
      continuityIdentity: targetIdentity
    }),
    variantTarget: {
      mediaKind: 'video',
      bindingId: input.target.bindingId,
      projectRelativePath: input.target.projectRelativePath,
      targetIdentity,
      sourceWidth: input.source.sourceWidth,
      srcForWidth: (width) => canvasVideoPreviewUrl({ target: input.target, width })
    }
  };
}

export function canvasVideoPreviewTargetsForNodes(
  nodes: readonly ProjectedCanvasNode[],
  feedbackEntries?: CanvasFeedbackDocument['entries'] | undefined,
  feedbackVideoResources: readonly CanvasFeedbackVideoResource[] = []
): CanvasVideoPreviewTarget[] {
  const targets = new Map<CanvasPreviewTargetKey, CanvasVideoPreviewTarget>();
  const visiblePaths = new Set(nodes.map((node) => node.projectRelativePath));
  for (const node of nodes) addTargets(node, true);
  for (const resource of feedbackVideoResources) {
    if (!visiblePaths.has(resource.projectRelativePath)) addTargets(resource, false);
  }
  return [...targets.values()];

  function addTargets(
    node: ProjectedCanvasNode | CanvasFeedbackVideoResource,
    includePlayback: boolean
  ): void {
    if (node.nodeKind !== 'file' || node.mediaKind !== 'video' || node.availability.state !== 'available') return;
    const base = {
      bindingId: canvasRawFileBindingId(node.availability.fileUrl),
      projectRelativePath: node.projectRelativePath,
      sourceRevision: node.availability.revision,
      sourceUrl: node.availability.fileUrl
    };
    const add = (frameTimeMs: number) => {
      const target = { ...base, frameTimeMs };
      targets.set(canvasVideoPreviewTargetKey(target), target);
    };
    if (includePlayback) {
      add('videoPlayback' in node ? node.videoPlayback?.currentTimeMs ?? 0 : 0);
    }
    for (const item of feedbackEntries?.[node.projectRelativePath]?.items ?? []) {
      if (item.scope === 'moment') add(Math.round(item.moment.currentTimeSeconds * 1000));
    }
  }
}

export async function captureCanvasVideoFrame(
  target: CanvasVideoPreviewTarget,
  signal: AbortSignal
): Promise<{ metadata: CanvasVideoMetadata; sourceImage: Blob }> {
  const captureController = new AbortController();
  const forwardAbort = () => captureController.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();
  const timeout = window.setTimeout(() => {
    captureController.abort(new CanvasVideoFrameFailure(
      'decode',
      `Browser video capture timed out after ${VIDEO_CAPTURE_TIMEOUT_MS / 1000} seconds: ${target.projectRelativePath}`
    ));
  }, VIDEO_CAPTURE_TIMEOUT_MS);
  const captureSignal = captureController.signal;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = target.sourceUrl;
  const cleanup = () => {
    video.removeAttribute('src');
    video.load();
  };
  try {
    const initialFrame = waitForPresentedVideoFrame(video, captureSignal);
    void initialFrame.catch(() => undefined);
    await waitForVideoEvent(video, 'loadedmetadata', captureSignal);
    const metadata = browserVideoMetadata(video);
    const targetTime = target.frameTimeMs / 1000;
    if (metadata.durationSeconds !== undefined && targetTime > metadata.durationSeconds) {
      throw new Error(`Canvas video preview time exceeds the decoded duration: ${target.projectRelativePath}`);
    }
    await waitForVideoEvent(video, 'loadeddata', captureSignal);
    await initialFrame;
    if (target.frameTimeMs !== 0) {
      const targetFrame = waitForPresentedVideoFrame(video, captureSignal);
      video.currentTime = targetTime;
      await Promise.all([
        waitForVideoEvent(video, 'seeked', captureSignal),
        targetFrame
      ]);
    }
    const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(metadata.width, metadata.height));
    const width = Math.max(1, Math.round(metadata.width * scale));
    const height = Math.max(1, Math.round(metadata.height * scale));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas video preview capture context is unavailable.');
      context.drawImage(video, 0, 0, width, height);
      const sourceImage = await canvasToJpeg(canvas, captureSignal);
      return { metadata, sourceImage };
    } catch (error) {
      if (isAbortError(error) || error instanceof CanvasVideoFrameFailure) throw error;
      throw new CanvasVideoFrameFailure('capture', messageFromUnknown(error));
    }
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', forwardAbort);
    cleanup();
  }
}

function browserVideoMetadata(video: HTMLVideoElement): CanvasVideoMetadata {
  if (!Number.isInteger(video.videoWidth) || video.videoWidth <= 0
    || !Number.isInteger(video.videoHeight) || video.videoHeight <= 0) {
    throw new Error('Browser video metadata did not include positive decoded dimensions.');
  }
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    ...(Number.isFinite(video.duration) && video.duration >= 0
      ? { durationSeconds: video.duration }
      : {})
  };
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const alreadyReady = eventName === 'loadedmetadata'
      ? video.readyState >= HTMLMediaElement.HAVE_METADATA
      : eventName === 'loadeddata' && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (alreadyReady) {
      resolve();
      return;
    }
    const finish = (error?: Error) => {
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error(`Browser could not decode Canvas video: ${video.currentSrc || video.src}`));
    const onAbort = () => finish(abortReason(signal));
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (eventName === 'loadedmetadata') video.load();
  });
}

function waitForPresentedVideoFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (!('requestVideoFrameCallback' in video)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    video.requestVideoFrameCallback(() => {
      finish();
    });
    if (signal.aborted) onAbort();
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (blob?: Blob, error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (!blob) reject(new Error('Browser could not encode the Canvas video preview JPEG.'));
      else if (blob.type !== 'image/jpeg') {
        reject(new Error(`Browser encoded the Canvas video preview as ${blob.type || 'an unknown format'} instead of JPEG.`));
      } else resolve(blob);
    };
    const onAbort = () => finish(undefined, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    canvas.toBlob((blob) => {
      if (signal.aborted) {
        finish(undefined, abortReason(signal));
      } else if (blob) {
        finish(blob);
      } else {
        finish();
      }
    }, 'image/jpeg', VIDEO_PREVIEW_SOURCE_JPEG_QUALITY);
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Canvas video preview capture aborted.', 'AbortError');
}

function orderCanvasVideoPreviewTasks(input: {
  tasks: readonly CanvasVideoPreviewTask[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasVideoPreviewTask[] {
  const visible = orderCanvasPreviewItemsByNode({
    items: input.tasks,
    nodesByPath: input.nodesByPath,
    visibleRect: input.visibleRect
  });
  const hidden = input.tasks
    .filter((task) => !input.nodesByPath.has(task.projectRelativePath))
    .sort((left, right) => (
      compareCanvasPreviewPaths(left.projectRelativePath, right.projectRelativePath)
      || left.frameTimeMs - right.frameTimeMs
    ));
  return [...visible, ...hidden];
}

function canvasVideoPreviewTargetForApi(target: CanvasVideoPreviewTarget) {
  return {
    projectRelativePath: target.projectRelativePath,
    sourceRevision: target.sourceRevision,
    frameTimeMs: target.frameTimeMs
  };
}

function sameApiTarget(source: CanvasVideoPreviewSourceView, target: CanvasVideoPreviewTarget): boolean {
  return source.projectRelativePath === target.projectRelativePath
    && source.sourceRevision === target.sourceRevision
    && source.frameTimeMs === target.frameTimeMs;
}

function sameVideoMetadata(left: CanvasVideoMetadata | undefined, right: CanvasVideoMetadata | undefined): boolean {
  return left?.width === right?.width
    && left?.height === right?.height
    && left?.durationSeconds === right?.durationSeconds;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
