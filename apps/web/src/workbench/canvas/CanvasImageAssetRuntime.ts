import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfFinalState, type CanvasPerfMonitor, type CanvasPerfSessionId } from './CanvasPerfMonitor';
import {
  CANVAS_IMAGE_LOAD_CONCURRENCY,
  createCanvasImageLoadingPlan,
  isCanvasImageLoadResultCurrent,
  selectCanvasImageLoadingCandidates,
  type ActiveCanvasImageLoad,
  type CanvasImageLoadError,
  type CanvasImageLoadingPlanItem,
  type CanvasImageNodeRenderState,
  type CanvasPendingImage
} from './canvasImageLoading';
import type { CanvasLoadedImage } from './canvasImagePreviews';
import { nodeRect } from './canvasVirtualization';
import type { CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect } from './runtime/canvasGeometry';
import { rectsIntersect } from './runtime/canvasGeometry';

export interface CanvasImageAssetViewport {
  visibleRect: CanvasRect;
  mountedNodePaths: ReadonlySet<string>;
  culledNodePaths: ReadonlySet<string>;
  imageResourceZoom: number;
  devicePixelRatio: number;
  imagePreviewsEnabled: boolean;
  cameraState: CanvasCameraState;
}

export interface CanvasImageAssetRuntime {
  setNodes(nodes: ReadonlyMap<string, ProjectedCanvasNode>): void;
  setViewport(viewport: CanvasImageAssetViewport): void;
  getNodeState(projectRelativePath: string): CanvasImageNodeRenderState;
  subscribeNode(projectRelativePath: string, listener: () => void): () => void;
  resolvePending(projectRelativePath: string, loadKey: string): void;
  rejectPending(projectRelativePath: string, loadKey: string): void;
  retry(projectRelativePath: string): void;
  stats(): CanvasImageAssetRuntimeStats;
  dispose(): void;
}

export interface CanvasImageAssetRuntimeStats {
  activeLoadCount: number;
  pendingImageCount: number;
  decodedImageCount: number;
}

export type CanvasImageAssetLoader = (item: CanvasImageLoadingPlanItem) => Promise<CanvasLoadedImage>;

interface CanvasImageAssetRecord {
  visible?: CanvasLoadedImage;
  next?: CanvasPendingImage;
  error?: CanvasImageLoadError;
}

export function createCanvasImageAssetRuntime(input: {
  loadImage?: CanvasImageAssetLoader;
  concurrency?: number;
  perfMonitor?: Pick<CanvasPerfMonitor, 'startSession' | 'endSession' | 'recordCounter'> | undefined;
} = {}): CanvasImageAssetRuntime {
  const loadImage = input.loadImage;
  const concurrency = input.concurrency ?? CANVAS_IMAGE_LOAD_CONCURRENCY;
  const nodes = new Map<string, ProjectedCanvasNode>();
  const records = new Map<string, CanvasImageAssetRecord>();
  const retryKeys = new Map<string, number>();
  const activeLoads = new Map<string, ActiveCanvasImageLoad>();
  const failedLoadKeys = new Set<string>();
  const subscribers = new Map<string, Set<() => void>>();
  const retryCallbacks = new Map<string, () => void>();
  const nodeStates = new Map<string, CanvasImageNodeRenderState>();
  const loadSessionIds = new Map<string, CanvasPerfSessionId>();

  let viewport: CanvasImageAssetViewport | undefined;
  let viewportSignature: string | undefined;
  let plan = new Map<string, CanvasImageLoadingPlanItem>();
  let disposed = false;
  let decodedImageCount = 0;

  const recordCanvasSessionCounter = (name: CanvasPerfCounterName, detail?: Record<string, unknown>) => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      name,
      detail
    });
  };

  const recordImageLoadCounter = (
    sessionId: CanvasPerfSessionId | undefined,
    name: CanvasPerfCounterName,
    detail?: Record<string, unknown>
  ) => {
    input.perfMonitor?.recordCounter({
      ...(sessionId ? { sessionId } : {}),
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      name,
      detail
    });
  };

  const endImageLoadSession = (
    item: CanvasImageLoadingPlanItem,
    counter: Extract<CanvasPerfCounterName, 'image-load-resolve' | 'image-load-reject' | 'image-load-stale-result'>
  ) => {
    const sessionId = loadSessionIds.get(item.loadKey);
    if (!sessionId) {
      return;
    }
    recordImageLoadCounter(sessionId, counter, {
      projectRelativePath: item.projectRelativePath,
      loadKey: item.loadKey
    });
    input.perfMonitor?.endSession({
      sessionId,
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      finalState: imageLoadFinalState(),
      detail: {
        projectRelativePath: item.projectRelativePath,
        loadKey: item.loadKey,
        result: counter
      }
    });
    loadSessionIds.delete(item.loadKey);
  };

  const retry = (projectRelativePath: string) => {
    const previous = records.get(projectRelativePath);
    const currentPlanItem = plan.get(projectRelativePath);
    if (currentPlanItem) {
      failedLoadKeys.delete(currentPlanItem.loadKey);
    }
    if (previous?.visible) {
      records.set(projectRelativePath, { visible: previous.visible });
    } else {
      records.delete(projectRelativePath);
    }
    retryKeys.set(projectRelativePath, (retryKeys.get(projectRelativePath) ?? 0) + 1);
    viewportSignature = undefined;
    rebuildPlan();
    publishIfChanged(projectRelativePath);
    pump();
  };

  const retryForPath = (projectRelativePath: string): (() => void) => {
    let callback = retryCallbacks.get(projectRelativePath);
    if (!callback) {
      callback = () => retry(projectRelativePath);
      retryCallbacks.set(projectRelativePath, callback);
    }
    return callback;
  };

  const buildState = (projectRelativePath: string): CanvasImageNodeRenderState => {
    const item = plan.get(projectRelativePath);
    if (!item) {
      return { kind: 'placeholder', retry: retryForPath(projectRelativePath) };
    }
    if (!item.eligible) {
      return { kind: 'not-eligible' };
    }
    const record = records.get(projectRelativePath);
    if (!record?.visible && !record?.next && !record?.error) {
      return { kind: 'placeholder', retry: retryForPath(projectRelativePath) };
    }
    return {
      kind: 'image',
      ...(record.visible ? { visible: record.visible } : {}),
      ...(record.next ? { next: record.next } : {}),
      ...(record.error ? { error: record.error } : {}),
      retry: retryForPath(projectRelativePath)
    };
  };

  const publish = (projectRelativePath: string): number => {
    const listeners = subscribers.get(projectRelativePath);
    for (const listener of listeners ?? []) {
      listener();
    }
    return listeners?.size ?? 0;
  };

  function publishIfChanged(projectRelativePath: string): void {
    const previous = nodeStates.get(projectRelativePath);
    const next = buildState(projectRelativePath);
    if (sameCanvasImageNodeRenderState(previous, next)) {
      if (!previous) {
        nodeStates.set(projectRelativePath, next);
      }
      return;
    }
    nodeStates.set(projectRelativePath, next);
    if (publish(projectRelativePath) > 0) {
      recordCanvasSessionCounter('image-node-publish', { projectRelativePath });
    }
  }

  function rebuildPlan(): void {
    recordCanvasSessionCounter('image-plan-rebuild');
    const affectedPaths = new Set([
      ...plan.keys(),
      ...nodes.keys(),
      ...records.keys(),
      ...nodeStates.keys()
    ]);
    const currentViewport = viewport;
    plan = currentViewport
      ? createCanvasImageLoadingPlan({
        nodes: [...nodes.values()].filter((node) => currentViewport.mountedNodePaths.has(node.projectRelativePath)),
        visibleRect: currentViewport.visibleRect,
        imageResourceZoom: currentViewport.imageResourceZoom,
        devicePixelRatio: currentViewport.devicePixelRatio,
        imagePreviewsEnabled: currentViewport.imagePreviewsEnabled,
        existingImages: loadedImagesFromRecords(records),
        retryKeys
      })
      : new Map();
    for (const path of pruneStaleImageWork()) {
      affectedPaths.add(path);
    }
    for (const path of affectedPaths) {
      publishIfChanged(path);
    }
  }

  function clearUnmountedNodeAssetState(projectRelativePath: string): void {
    cancelActiveLoadsForPath(projectRelativePath);
    const currentPlanItem = plan.get(projectRelativePath);
    if (currentPlanItem) {
      failedLoadKeys.delete(currentPlanItem.loadKey);
    }
    const record = records.get(projectRelativePath);
    if (record?.error) {
      failedLoadKeys.delete(record.error.loadKey);
    }
    records.delete(projectRelativePath);
    retryKeys.delete(projectRelativePath);
    retryCallbacks.delete(projectRelativePath);
    nodeStates.delete(projectRelativePath);
  }

  function cancelActiveLoadsForPath(projectRelativePath: string): void {
    for (const [loadKey, active] of [...activeLoads]) {
      if (active.item.projectRelativePath === projectRelativePath) {
        activeLoads.delete(loadKey);
        endImageLoadSession(active.item, 'image-load-stale-result');
      }
    }
  }

  function pruneStaleImageWork(): Set<string> {
    const affectedPaths = new Set<string>();
    const currentLoadKeys = new Set(
      [...plan.values()]
        .filter((item) => item.eligible)
        .map((item) => item.loadKey)
    );

    for (const [loadKey, active] of [...activeLoads]) {
      const current = plan.get(active.item.projectRelativePath);
      if (current?.loadKey !== active.item.loadKey) {
        activeLoads.delete(loadKey);
        endImageLoadSession(active.item, 'image-load-stale-result');
        affectedPaths.add(active.item.projectRelativePath);
      }
    }

    for (const [path, record] of [...records]) {
      const current = plan.get(path);
      const nextRecord: CanvasImageAssetRecord = {
        ...(record.visible ? { visible: record.visible } : {})
      };
      if (record.next && current?.loadKey === record.next.loadKey) {
        nextRecord.next = record.next;
      } else if (record.next) {
        affectedPaths.add(path);
      }
      if (record.error && current?.loadKey === record.error.loadKey) {
        nextRecord.error = record.error;
      } else if (record.error) {
        failedLoadKeys.delete(record.error.loadKey);
        affectedPaths.add(path);
      }

      if (nextRecord.visible || nextRecord.next || nextRecord.error) {
        records.set(path, nextRecord);
      } else {
        records.delete(path);
      }
    }

    for (const loadKey of [...failedLoadKeys]) {
      if (!currentLoadKeys.has(loadKey)) {
        failedLoadKeys.delete(loadKey);
      }
    }

    return affectedPaths;
  }

  function startLoad(item: CanvasImageLoadingPlanItem): void {
    const sessionId = input.perfMonitor?.startSession({
      type: 'image-load',
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      detail: {
        projectRelativePath: item.projectRelativePath,
        loadKey: item.loadKey,
        reason: item.reason,
        priority: item.priority
      }
    });
    if (sessionId) {
      loadSessionIds.set(item.loadKey, sessionId);
    }
    recordImageLoadCounter(sessionId, 'image-load-start', {
      projectRelativePath: item.projectRelativePath,
      loadKey: item.loadKey
    });
    const active: ActiveCanvasImageLoad = { item };
    activeLoads.set(item.loadKey, active);
    const previous = records.get(item.projectRelativePath);
    records.set(item.projectRelativePath, {
      ...(previous?.visible ? { visible: previous.visible } : {}),
      next: { src: item.src, loadKey: item.loadKey }
    });
    publishIfChanged(item.projectRelativePath);

    if (!loadImage) {
      return;
    }

    void loadImage(item)
      .then((loaded) => finishLoaded(active, loaded))
      .catch(() => finishRejected(active));
  }

  function finishLoaded(active: ActiveCanvasImageLoad, loaded: CanvasLoadedImage): void {
    const activeLoad = activeLoads.get(active.item.loadKey);
    if (activeLoad !== active) {
      endImageLoadSession(active.item, 'image-load-stale-result');
      return;
    }
    activeLoads.delete(active.item.loadKey);
    if (!isCanvasImageLoadResultCurrent(active, plan)) {
      endImageLoadSession(active.item, 'image-load-stale-result');
      pump();
      return;
    }
    failedLoadKeys.delete(active.item.loadKey);
    decodedImageCount += 1;
    records.set(active.item.projectRelativePath, { visible: loaded });
    endImageLoadSession(active.item, 'image-load-resolve');
    rebuildPlan();
    pump();
  }

  function finishRejected(active: ActiveCanvasImageLoad): void {
    const activeLoad = activeLoads.get(active.item.loadKey);
    if (activeLoad !== active) {
      endImageLoadSession(active.item, 'image-load-stale-result');
      return;
    }
    activeLoads.delete(active.item.loadKey);
    if (!isCanvasImageLoadResultCurrent(active, plan)) {
      endImageLoadSession(active.item, 'image-load-stale-result');
      pump();
      return;
    }
    failedLoadKeys.add(active.item.loadKey);
    const current = records.get(active.item.projectRelativePath);
    records.set(active.item.projectRelativePath, {
      ...(current?.visible ? { visible: current.visible } : {}),
      error: {
        loadKey: active.item.loadKey,
        message: `Unable to load ${active.item.projectRelativePath}.`
      }
    });
    endImageLoadSession(active.item, 'image-load-reject');
    rebuildPlan();
    pump();
  }

  function finishPendingFromDom(projectRelativePath: string, loadKey: string, status: 'loaded' | 'rejected'): void {
    const active = activeLoads.get(loadKey);
    if (!active || active.item.projectRelativePath !== projectRelativePath) {
      return;
    }
    if (status === 'loaded') {
      finishLoaded(active, { src: active.item.src, loadKey: active.item.loadKey });
    } else {
      finishRejected(active);
    }
  }

  function pump(): void {
    recordCanvasSessionCounter('image-pump');
    const currentViewport = viewport;
    if (disposed || !currentViewport) {
      return;
    }
    const candidates = selectCanvasImageLoadingCandidates({
      plan,
      cameraState: currentViewport.cameraState,
      activeLoadKeys: new Set([...activeLoads.keys(), ...failedLoadKeys])
    }).filter((item) => (
      currentViewport.cameraState !== 'moving'
      || (
        !currentViewport.culledNodePaths.has(item.projectRelativePath)
        && !records.get(item.projectRelativePath)?.visible
      )
    ));
    const openSlots = Math.max(0, concurrency - activeLoads.size);
    for (const item of candidates.slice(0, openSlots)) {
      startLoad(item);
    }
  }

  function imageLoadFinalState(): CanvasPerfFinalState | undefined {
    if (!viewport) {
      return undefined;
    }
    return {
      mountedNodeCount: viewport.mountedNodePaths.size,
      visibleNodeCount: Math.max(0, viewport.mountedNodePaths.size - viewport.culledNodePaths.size),
      culledNodeCount: viewport.culledNodePaths.size,
      activeImageLoadCount: activeLoads.size,
      pendingImageCount: [...records.values()].filter((record) => record.next).length,
      decodedImageCount,
      zoomLevel: viewport.imageResourceZoom,
      cameraState: viewport.cameraState
    };
  }

  return {
    setNodes: (nextNodes) => {
      nodes.clear();
      for (const [path, node] of nextNodes) {
        nodes.set(path, node);
      }
      for (const path of [...records.keys()]) {
        if (!nodes.has(path)) {
          clearUnmountedNodeAssetState(path);
          publish(path);
        }
      }
      viewportSignature = undefined;
      rebuildPlan();
      pump();
    },
    setViewport: (nextViewport) => {
      const nextSignature = canvasImageAssetViewportSignature(nextViewport, nodes);
      if (viewportSignature === nextSignature) {
        viewport = nextViewport;
        recordCanvasSessionCounter('image-viewport-noop');
        recordCanvasSessionCounter('image-plan-reuse');
        return;
      }
      viewportSignature = nextSignature;
      viewport = nextViewport;
      recordCanvasSessionCounter('image-viewport-sync');
      rebuildPlan();
      pump();
    },
    getNodeState: (projectRelativePath) => {
      let state = nodeStates.get(projectRelativePath);
      if (!state) {
        state = buildState(projectRelativePath);
        nodeStates.set(projectRelativePath, state);
      }
      return state;
    },
    subscribeNode: (projectRelativePath, listener) => {
      const listeners = subscribers.get(projectRelativePath);
      if (listeners) {
        listeners.add(listener);
      } else {
        subscribers.set(projectRelativePath, new Set([listener]));
      }
      return () => {
        const current = subscribers.get(projectRelativePath);
        current?.delete(listener);
        if (current?.size === 0) {
          subscribers.delete(projectRelativePath);
        }
      };
    },
    resolvePending: (projectRelativePath, loadKey) => finishPendingFromDom(projectRelativePath, loadKey, 'loaded'),
    rejectPending: (projectRelativePath, loadKey) => finishPendingFromDom(projectRelativePath, loadKey, 'rejected'),
    retry,
    stats: () => ({
      activeLoadCount: activeLoads.size,
      pendingImageCount: [...records.values()].filter((record) => record.next).length,
      decodedImageCount
    }),
    dispose: () => {
      for (const [loadKey, active] of [...activeLoads]) {
        activeLoads.delete(loadKey);
        endImageLoadSession(active.item, 'image-load-stale-result');
      }
      disposed = true;
      nodes.clear();
      records.clear();
      retryKeys.clear();
      failedLoadKeys.clear();
      activeLoads.clear();
      loadSessionIds.clear();
      subscribers.clear();
      retryCallbacks.clear();
      nodeStates.clear();
      plan.clear();
      viewport = undefined;
      viewportSignature = undefined;
      decodedImageCount = 0;
    }
  };
}

function loadedImagesFromRecords(records: ReadonlyMap<string, CanvasImageAssetRecord>): Map<string, CanvasLoadedImage> {
  const loadedImages = new Map<string, CanvasLoadedImage>();
  for (const [path, record] of records) {
    if (record.visible) {
      loadedImages.set(path, record.visible);
    }
  }
  return loadedImages;
}

function sameCanvasImageNodeRenderState(
  previous: CanvasImageNodeRenderState | undefined,
  next: CanvasImageNodeRenderState
): boolean {
  if (!previous || previous.kind !== next.kind) {
    return false;
  }
  if (previous.kind === 'not-eligible' || next.kind === 'not-eligible') {
    return true;
  }
  if (previous.kind === 'placeholder' || next.kind === 'placeholder') {
    return previous.kind === next.kind && previous.retry === next.retry;
  }
  return previous.retry === next.retry
    && previous.visible?.loadKey === next.visible?.loadKey
    && previous.visible?.src === next.visible?.src
    && previous.next?.loadKey === next.next?.loadKey
    && previous.next?.src === next.next?.src
    && previous.error?.loadKey === next.error?.loadKey
    && previous.error?.message === next.error?.message;
}

export function canvasImageAssetViewportSignature(
  viewport: CanvasImageAssetViewport,
  nodes: ReadonlyMap<string, ProjectedCanvasNode>
): string {
  return [
    viewport.cameraState,
    viewport.cameraState === 'moving'
      ? movingViewportImageCandidateSignature(viewport, nodes)
      : `${rectSignature(viewport.visibleRect)}:${mountedImagePathSignature(viewport.mountedNodePaths, nodes)}`,
    String(viewport.imageResourceZoom),
    String(viewport.devicePixelRatio),
    String(viewport.imagePreviewsEnabled)
  ].join('\u001e');
}

function rectSignature(rect: CanvasRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

function movingViewportImageCandidateSignature(
  viewport: CanvasImageAssetViewport,
  nodes: ReadonlyMap<string, ProjectedCanvasNode>
): string {
  return [...viewport.mountedNodePaths]
    .filter((path) => !viewport.culledNodePaths.has(path))
    .filter((path) => {
      const node = nodes.get(path);
      return isAvailableVisibleImageNode(node) && rectsIntersect(viewport.visibleRect, nodeRect(node));
    })
    .map((path) => path)
    .join('\u001f');
}

function mountedImagePathSignature(paths: ReadonlySet<string>, nodes: ReadonlyMap<string, ProjectedCanvasNode>): string {
  return [...paths]
    .filter((path) => isImageNode(nodes.get(path)))
    .join('\u001f');
}

function isImageNode(node: ProjectedCanvasNode | undefined): node is ProjectedCanvasNode {
  return node?.nodeKind === 'file' && node.mediaKind === 'image';
}

function isAvailableVisibleImageNode(node: ProjectedCanvasNode | undefined): node is ProjectedCanvasNode {
  return node?.nodeKind === 'file'
    && node.mediaKind === 'image'
    && node.visible !== false
    && node.availability.state === 'available'
    && Boolean(node.availability.fileUrl);
}

function canvasImagePerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
