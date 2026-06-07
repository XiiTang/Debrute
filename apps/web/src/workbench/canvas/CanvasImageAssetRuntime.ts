import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import { CANVAS_PERF_INTERACTION_SESSION_TYPES, type CanvasPerfCounterName, type CanvasPerfFinalState, type CanvasPerfMonitor, type CanvasPerfSessionId } from './CanvasPerfMonitor';
import {
  CANVAS_IMAGE_LOAD_CONCURRENCY,
  CANVAS_IMAGE_NEAR_OVERSCAN_SCREEN_PX,
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
import { expandCanvasRect, rectCenter, rectsIntersect } from './runtime/canvasGeometry';

export interface CanvasImageAssetViewport {
  visibleRect: CanvasRect;
  mountedNodePaths: ReadonlySet<string>;
  culledNodePaths: ReadonlySet<string>;
  imageResourceZoom: number;
  devicePixelRatio: number;
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
  visiblePreviewWidths: Record<string, number>;
  nextPreviewWidths: Record<string, number>;
  imageWorkIntentCounts: Record<string, number>;
  imageCancellationReasons: Record<string, number>;
  imageEvictionReasons: Record<string, number>;
}

export type CanvasImageAssetLoader = (item: CanvasImageLoadingPlanItem) => Promise<CanvasLoadedImage>;

export interface CanvasImageAssetRuntimeBudget {
  maxPendingImages: number;
  maxHighResolutionPendingImages: number;
  highResolutionPreviewWidth: number;
  movingPrefetchLimit: number;
}

export const CANVAS_IMAGE_VISIBLE_RETAIN_OVERSCAN_SCREEN_PX = 1536;
export const CANVAS_IMAGE_ASSET_DEFAULT_BUDGET: CanvasImageAssetRuntimeBudget = {
  maxPendingImages: 3,
  maxHighResolutionPendingImages: 2,
  highResolutionPreviewWidth: 1024,
  movingPrefetchLimit: 1
};

interface CanvasImageAssetRecord {
  visible?: CanvasLoadedImage;
  next?: CanvasPendingImage;
  error?: CanvasImageLoadError;
}

export function createCanvasImageAssetRuntime(input: {
  loadImage?: CanvasImageAssetLoader;
  concurrency?: number;
  budget?: Partial<CanvasImageAssetRuntimeBudget> | undefined;
  perfMonitor?: Pick<CanvasPerfMonitor, 'startSession' | 'endSession' | 'recordCounter'> | undefined;
} = {}): CanvasImageAssetRuntime {
  const loadImage = input.loadImage;
  const concurrency = input.concurrency ?? CANVAS_IMAGE_LOAD_CONCURRENCY;
  const budget: CanvasImageAssetRuntimeBudget = {
    ...CANVAS_IMAGE_ASSET_DEFAULT_BUDGET,
    ...input.budget
  };
  const nodes = new Map<string, ProjectedCanvasNode>();
  const records = new Map<string, CanvasImageAssetRecord>();
  const retryKeys = new Map<string, number>();
  const activeLoads = new Map<string, ActiveCanvasImageLoad>();
  const failedLoadKeys = new Set<string>();
  const subscribers = new Map<string, Set<() => void>>();
  const retryCallbacks = new Map<string, () => void>();
  const nodeStates = new Map<string, CanvasImageNodeRenderState>();
  const loadSessionIds = new Map<string, CanvasPerfSessionId>();
  const imageCancellationReasons = new Map<string, number>();
  const imageEvictionReasons = new Map<string, number>();

  let viewport: CanvasImageAssetViewport | undefined;
  let viewportSignature: string | undefined;
  let movingViewportSignature: string | undefined;
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
      loadKey: item.loadKey,
      intent: item.intent,
      previewWidth: item.previewWidth
    });
    input.perfMonitor?.endSession({
      sessionId,
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      finalState: imageLoadFinalState(),
      detail: {
        projectRelativePath: item.projectRelativePath,
        loadKey: item.loadKey,
        intent: item.intent,
        previewWidth: item.previewWidth,
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
    movingViewportSignature = undefined;
    syncPlanFromCurrentViewport({
      source: 'retry',
      affectedPaths: [projectRelativePath],
      force: true
    });
    publishIfChanged(projectRelativePath);
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
        existingImages: loadedImagesFromRecords(records),
        retryKeys
      })
      : new Map();
    for (const path of pruneStaleImageWork()) {
      affectedPaths.add(path);
    }
    if (currentViewport) {
      for (const path of pruneImageResourceState(currentViewport)) {
        affectedPaths.add(path);
      }
    }
    for (const path of affectedPaths) {
      publishIfChanged(path);
    }
    refreshViewportSignaturesFromCurrentState();
  }

  function syncPlanFromCurrentViewport(input: {
    source: 'viewport' | 'nodes' | 'retry';
    affectedPaths?: Iterable<string>;
    force?: boolean;
  }): void {
    const affectedPaths = new Set(input.affectedPaths ?? []);
    const currentViewport = viewport;
    if (!currentViewport) {
      if (plan.size > 0) {
        plan = new Map();
      }
      viewportSignature = undefined;
      movingViewportSignature = undefined;
      for (const path of affectedPaths) {
        publishIfChanged(path);
      }
      return;
    }

    const nextSignatures = canvasImageAssetViewportSignatures(currentViewport, nodes, {
      loadedImagePaths: loadedImagePathsFromRecords(records)
    });
    const currentSignature = currentViewport.cameraState === 'moving'
      ? movingViewportSignature
      : viewportSignature;
    const nextSignature = currentViewport.cameraState === 'moving'
      ? nextSignatures.moving
      : nextSignatures.current;
    const forcePlanSync = input.force === true;
    if (!forcePlanSync && currentSignature === nextSignature) {
      viewportSignature = nextSignatures.current;
      movingViewportSignature = nextSignatures.moving;
      if (input.source === 'viewport') {
        recordCanvasSessionCounter('image-viewport-noop');
      }
      recordCanvasSessionCounter('image-plan-reuse');
      const pruned = pruneImageResourceState(currentViewport);
      for (const path of pruned) {
        affectedPaths.add(path);
      }
      for (const path of affectedPaths) {
        publishIfChanged(path);
      }
      if (pruned.size > 0) {
        pump();
      }
      return;
    }

    viewportSignature = nextSignatures.current;
    movingViewportSignature = nextSignatures.moving;
    if (input.source === 'viewport') {
      recordCanvasSessionCounter('image-viewport-sync');
    }
    rebuildPlan();
    pump();
  }

  function refreshViewportSignaturesFromCurrentState(): void {
    const currentViewport = viewport;
    if (!currentViewport) {
      viewportSignature = undefined;
      movingViewportSignature = undefined;
      return;
    }
    const nextSignatures = canvasImageAssetViewportSignatures(currentViewport, nodes, {
      loadedImagePaths: loadedImagePathsFromRecords(records)
    });
    viewportSignature = nextSignatures.current;
    movingViewportSignature = nextSignatures.moving;
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

  function pruneImageResourceState(currentViewport: CanvasImageAssetViewport): Set<string> {
    const affectedPaths = new Set<string>();

    for (const [loadKey, active] of [...activeLoads]) {
      const record = records.get(active.item.projectRelativePath);
      if (record?.next?.loadKey === loadKey && isPendingImageWorkAllowed(active.item, currentViewport, record)) {
        continue;
      }
      activeLoads.delete(loadKey);
      endImageLoadSession(active.item, 'image-load-stale-result');
      affectedPaths.add(active.item.projectRelativePath);
    }

    for (const [path, record] of [...records]) {
      const current = plan.get(path);
      const nextRecord: CanvasImageAssetRecord = {
        ...(record.visible ? { visible: record.visible } : {})
      };
      const nextBlockedReason = record.next && current?.loadKey === record.next.loadKey
        ? pendingImageWorkBlockedReason(current, currentViewport, record)
        : 'stale-plan';
      if (record.next && nextBlockedReason === undefined) {
        nextRecord.next = record.next;
      } else if (record.next) {
        incrementReasonCount(imageCancellationReasons, nextBlockedReason ?? 'cancelled');
        recordCanvasSessionCounter('image-next-cancel', {
          projectRelativePath: path,
          loadKey: record.next.loadKey,
          intent: current?.intent,
          previewWidth: record.next.previewWidth,
          reason: nextBlockedReason ?? 'cancelled'
        });
        affectedPaths.add(path);
      }
      if (record.error && current?.loadKey === record.error.loadKey && isErrorStateAllowed(current, currentViewport)) {
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

    for (const path of enforcePendingImageBudget()) {
      affectedPaths.add(path);
    }
    for (const path of evictFarVisibleImages(currentViewport)) {
      affectedPaths.add(path);
    }

    return affectedPaths;
  }

  function isPendingImageWorkAllowed(
    item: CanvasImageLoadingPlanItem | undefined,
    currentViewport: CanvasImageAssetViewport,
    record: CanvasImageAssetRecord | undefined
  ): boolean {
    return pendingImageWorkBlockedReason(item, currentViewport, record) === undefined;
  }

  function pendingImageWorkBlockedReason(
    item: CanvasImageLoadingPlanItem | undefined,
    currentViewport: CanvasImageAssetViewport,
    record: CanvasImageAssetRecord | undefined
  ): string | undefined {
    if (!item?.eligible) {
      return 'ineligible';
    }
    if (item.intent === 'display-critical') {
      if (currentViewport.culledNodePaths.has(item.projectRelativePath)) {
        return 'culled-display-critical';
      }
      return record?.visible ? 'visible-loaded' : undefined;
    }
    if (item.intent === 'prefetch-near') {
      return record?.visible ? 'visible-loaded' : undefined;
    }
    if (item.intent === 'upgrade-idle') {
      if (currentViewport.cameraState !== 'idle') {
        return 'moving-upgrade';
      }
      return record?.visible ? undefined : 'missing-visible-upgrade';
    }
    return item.intent;
  }

  function isErrorStateAllowed(
    item: CanvasImageLoadingPlanItem | undefined,
    _currentViewport: CanvasImageAssetViewport
  ): boolean {
    return item?.eligible === true
      && item.intent !== 'deferred';
  }

  function enforcePendingImageBudget(): Set<string> {
    const affectedPaths = new Set<string>();
    const pending = [...records.entries()]
      .flatMap(([path, record]) => {
        if (!record.next) {
          return [];
        }
        const item = plan.get(path);
        if (!item || item.loadKey !== record.next.loadKey) {
          return [];
        }
        return [{ path, record, item }];
      })
      .sort((left, right) => (
        imageIntentBudgetOrder(left.item.intent) - imageIntentBudgetOrder(right.item.intent)
        || left.item.distanceToVisibleCenter - right.item.distanceToVisibleCenter
        || left.path.localeCompare(right.path)
      ));

    let pendingCount = 0;
    let highResolutionPendingCount = 0;
    for (const pendingItem of pending) {
      const isHighResolution = pendingItem.record.next!.previewWidth >= budget.highResolutionPreviewWidth;
      const overTotalBudget = pendingCount >= budget.maxPendingImages;
      const overHighResolutionBudget = isHighResolution
        && highResolutionPendingCount >= budget.maxHighResolutionPendingImages;
      if (overTotalBudget || overHighResolutionBudget) {
        removeNextImage(pendingItem.path, pendingItem.record, overTotalBudget ? 'total' : 'high-resolution');
        affectedPaths.add(pendingItem.path);
        continue;
      }
      pendingCount += 1;
      if (isHighResolution) {
        highResolutionPendingCount += 1;
      }
    }

    for (const [loadKey, active] of [...activeLoads]) {
      const record = records.get(active.item.projectRelativePath);
      if (record?.next?.loadKey === loadKey) {
        continue;
      }
      activeLoads.delete(loadKey);
      endImageLoadSession(active.item, 'image-load-stale-result');
      affectedPaths.add(active.item.projectRelativePath);
    }

    return affectedPaths;
  }

  function removeNextImage(
    path: string,
    record: CanvasImageAssetRecord,
    reason: 'total' | 'high-resolution'
  ): void {
    if (!record.next) {
      return;
    }
    const next = record.next;
    const active = activeLoads.get(next.loadKey);
    if (active) {
      activeLoads.delete(next.loadKey);
      endImageLoadSession(active.item, 'image-load-stale-result');
    }
    recordCanvasSessionCounter('image-budget-block', {
      projectRelativePath: path,
      loadKey: next.loadKey,
      previewWidth: next.previewWidth,
      reason
    });
    incrementReasonCount(imageCancellationReasons, `budget-${reason}`);
    const nextRecord: CanvasImageAssetRecord = {
      ...(record.visible ? { visible: record.visible } : {}),
      ...(record.error ? { error: record.error } : {})
    };
    if (nextRecord.visible || nextRecord.error) {
      records.set(path, nextRecord);
    } else {
      records.delete(path);
    }
  }

  function evictFarVisibleImages(currentViewport: CanvasImageAssetViewport): Set<string> {
    const affectedPaths = new Set<string>();
    const retainRect = expandCanvasRect(
      currentViewport.visibleRect,
      CANVAS_IMAGE_VISIBLE_RETAIN_OVERSCAN_SCREEN_PX / currentViewport.imageResourceZoom
    );
    for (const [path, record] of [...records]) {
      const visible = record.visible;
      if (!visible || visible.previewWidth < budget.highResolutionPreviewWidth) {
        continue;
      }
      const node = nodes.get(path);
      if (!isAvailableVisibleImageNode(node) || rectsIntersect(retainRect, nodeRect(node))) {
        continue;
      }
      recordCanvasSessionCounter('image-visible-evict', {
        projectRelativePath: path,
        loadKey: visible.loadKey,
        previewWidth: visible.previewWidth,
        reason: 'far-high-resolution'
      });
      incrementReasonCount(imageEvictionReasons, 'far-high-resolution');
      const nextRecord: CanvasImageAssetRecord = {
        ...(record.next ? { next: record.next } : {}),
        ...(record.error ? { error: record.error } : {})
      };
      if (nextRecord.next || nextRecord.error) {
        records.set(path, nextRecord);
      } else {
        records.delete(path);
      }
      affectedPaths.add(path);
    }
    return affectedPaths;
  }

  function imageIntentBudgetOrder(intent: CanvasImageLoadingPlanItem['intent']): number {
    switch (intent) {
      case 'display-critical':
        return 0;
      case 'prefetch-near':
        return 1;
      case 'upgrade-idle':
        return 2;
      case 'deferred':
        return 3;
      case 'not-previewable':
      case 'unavailable':
        return 4;
    }
    const exhaustive: never = intent;
    return exhaustive;
  }

  function startLoad(item: CanvasImageLoadingPlanItem): void {
    const sessionId = input.perfMonitor?.startSession({
      type: 'image-load',
      timestamp: canvasImagePerfTimestamp(),
      source: 'CanvasImageAssetRuntime',
      detail: {
        projectRelativePath: item.projectRelativePath,
        loadKey: item.loadKey,
        intent: item.intent,
        previewWidth: item.previewWidth
      }
    });
    if (sessionId) {
      loadSessionIds.set(item.loadKey, sessionId);
    }
    recordImageLoadCounter(sessionId, 'image-load-start', {
      projectRelativePath: item.projectRelativePath,
      loadKey: item.loadKey,
      intent: item.intent,
      previewWidth: item.previewWidth
    });
    const active: ActiveCanvasImageLoad = { item };
    activeLoads.set(item.loadKey, active);
    const previous = records.get(item.projectRelativePath);
    records.set(item.projectRelativePath, {
      ...(previous?.visible ? { visible: previous.visible } : {}),
      next: { src: item.src, loadKey: item.loadKey, previewWidth: item.previewWidth }
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
      finishLoaded(active, {
        src: active.item.src,
        loadKey: active.item.loadKey,
        previewWidth: active.item.previewWidth
      });
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
      activeLoadKeys: new Set([...activeLoads.keys(), ...failedLoadKeys]),
      movingPrefetchLimit: budget.movingPrefetchLimit
    }).filter((item) => isPendingImageWorkAllowed(item, currentViewport, records.get(item.projectRelativePath)));
    const openSlots = Math.max(
      0,
      Math.min(
        concurrency - activeLoads.size,
        budget.maxPendingImages - pendingImageCount(records)
      )
    );
    let startedCount = 0;
    for (const item of candidates) {
      if (startedCount >= openSlots || activeLoads.size >= concurrency || pendingImageCount(records) >= budget.maxPendingImages) {
        break;
      }
      if (!canStartWithinPendingBudget(item, records)) {
        recordCanvasSessionCounter('image-budget-block', {
          projectRelativePath: item.projectRelativePath,
          loadKey: item.loadKey,
          intent: item.intent,
          previewWidth: item.previewWidth,
          reason: 'high-resolution'
        });
        continue;
      }
      startLoad(item);
      startedCount += 1;
    }
  }

  function canStartWithinPendingBudget(
    item: CanvasImageLoadingPlanItem,
    currentRecords: ReadonlyMap<string, CanvasImageAssetRecord>
  ): boolean {
    if (pendingImageCount(currentRecords) >= budget.maxPendingImages) {
      return false;
    }
    if (item.previewWidth < budget.highResolutionPreviewWidth) {
      return true;
    }
    return highResolutionPendingImageCount(currentRecords, budget.highResolutionPreviewWidth)
      < budget.maxHighResolutionPendingImages;
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
      pendingImageCount: pendingImageCount(records),
      decodedImageCount,
      zoomLevel: viewport.imageResourceZoom,
      cameraState: viewport.cameraState
    };
  }

  return {
    setNodes: (nextNodes) => {
      const affectedPaths = new Set<string>();
      nodes.clear();
      for (const [path, node] of nextNodes) {
        nodes.set(path, node);
        affectedPaths.add(path);
      }
      for (const path of [...records.keys()]) {
        if (!nodes.has(path)) {
          clearUnmountedNodeAssetState(path);
          affectedPaths.add(path);
          publish(path);
        }
      }
      syncPlanFromCurrentViewport({
        source: 'nodes',
        affectedPaths
      });
    },
    setViewport: (nextViewport) => {
      viewport = nextViewport;
      syncPlanFromCurrentViewport({ source: 'viewport' });
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
      pendingImageCount: pendingImageCount(records),
      decodedImageCount,
      visiblePreviewWidths: imagePreviewWidthCounts(records, 'visible'),
      nextPreviewWidths: imagePreviewWidthCounts(records, 'next'),
      imageWorkIntentCounts: imageWorkIntentCounts(plan),
      imageCancellationReasons: reasonCounts(imageCancellationReasons),
      imageEvictionReasons: reasonCounts(imageEvictionReasons)
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
      imageCancellationReasons.clear();
      imageEvictionReasons.clear();
      subscribers.clear();
      retryCallbacks.clear();
      nodeStates.clear();
      plan.clear();
      viewport = undefined;
      viewportSignature = undefined;
      movingViewportSignature = undefined;
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

function loadedImagePathsFromRecords(records: ReadonlyMap<string, CanvasImageAssetRecord>): Set<string> {
  const paths = new Set<string>();
  for (const [path, record] of records) {
    if (record.visible) {
      paths.add(path);
    }
  }
  return paths;
}

function pendingImageCount(records: ReadonlyMap<string, CanvasImageAssetRecord>): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.next) {
      count += 1;
    }
  }
  return count;
}

function highResolutionPendingImageCount(
  records: ReadonlyMap<string, CanvasImageAssetRecord>,
  highResolutionPreviewWidth: number
): number {
  let count = 0;
  for (const record of records.values()) {
    if (record.next && record.next.previewWidth >= highResolutionPreviewWidth) {
      count += 1;
    }
  }
  return count;
}

function imagePreviewWidthCounts(
  records: ReadonlyMap<string, CanvasImageAssetRecord>,
  field: 'visible' | 'next'
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records.values()) {
    const image = record[field];
    if (!image) {
      continue;
    }
    const key = String(image.previewWidth);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function imageWorkIntentCounts(plan: ReadonlyMap<string, CanvasImageLoadingPlanItem>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of plan.values()) {
    counts[item.intent] = (counts[item.intent] ?? 0) + 1;
  }
  return counts;
}

function incrementReasonCount(counts: Map<string, number>, reason: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function reasonCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
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
    && previous.visible?.previewWidth === next.visible?.previewWidth
    && previous.next?.loadKey === next.next?.loadKey
    && previous.next?.src === next.next?.src
    && previous.next?.previewWidth === next.next?.previewWidth
    && previous.error?.loadKey === next.error?.loadKey
    && previous.error?.message === next.error?.message;
}

export function canvasImageAssetViewportSignature(
  viewport: CanvasImageAssetViewport,
  nodes: ReadonlyMap<string, ProjectedCanvasNode>,
  input: { loadedImagePaths?: ReadonlySet<string> } = {}
): string {
  if (viewport.cameraState === 'moving') {
    return [
      viewport.cameraState,
      movingViewportImageCandidateSignature(viewport, nodes, input.loadedImagePaths ?? new Set())
    ].join('\u001e');
  }

  return [
    viewport.cameraState,
    `${rectSignature(viewport.visibleRect)}:${mountedImageSourceSignature(viewport.mountedNodePaths, nodes)}`,
    String(viewport.imageResourceZoom),
    String(viewport.devicePixelRatio)
  ].join('\u001e');
}

function canvasImageAssetViewportSignatures(
  viewport: CanvasImageAssetViewport,
  nodes: ReadonlyMap<string, ProjectedCanvasNode>,
  input: { loadedImagePaths: ReadonlySet<string> }
): { current: string; moving: string } {
  return {
    current: canvasImageAssetViewportSignature(viewport, nodes, input),
    moving: canvasImageAssetViewportSignature({
      ...viewport,
      cameraState: 'moving'
    }, nodes, input)
  };
}

function rectSignature(rect: CanvasRect): string {
  return `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
}

function movingViewportImageCandidateSignature(
  viewport: CanvasImageAssetViewport,
  nodes: ReadonlyMap<string, ProjectedCanvasNode>,
  loadedImagePaths: ReadonlySet<string>
): string {
  const nearRect = expandCanvasRect(
    viewport.visibleRect,
    CANVAS_IMAGE_NEAR_OVERSCAN_SCREEN_PX / viewport.imageResourceZoom
  );
  const visibleCenter = rectCenter(viewport.visibleRect);
  return [...viewport.mountedNodePaths]
    .filter((path) => !loadedImagePaths.has(path))
    .flatMap((path) => {
      const node = nodes.get(path);
      if (!isAvailableVisibleImageNode(node) || !rectsIntersect(nearRect, nodeRect(node))) {
        return [];
      }
      const bounds = nodeRect(node);
      const intent: 'display-critical' | 'prefetch-near' = rectsIntersect(viewport.visibleRect, bounds)
        ? 'display-critical'
        : 'prefetch-near';
      return [{
        intent,
        distanceToVisibleCenter: pointDistance(visibleCenter, rectCenter(bounds)),
        sourceSignature: imageNodeSourceSignature(node)
      }];
    })
    .sort((left, right) => (
      movingImageIntentOrder(left.intent) - movingImageIntentOrder(right.intent)
      || left.distanceToVisibleCenter - right.distanceToVisibleCenter
      || (left.sourceSignature ?? '').localeCompare(right.sourceSignature ?? '')
    ))
    .map((entry) => `${entry.intent}\u001c${entry.sourceSignature ?? ''}`)
    .join('\u001f');
}

function movingImageIntentOrder(intent: 'display-critical' | 'prefetch-near'): number {
  return intent === 'display-critical' ? 0 : 1;
}

function mountedImageSourceSignature(paths: ReadonlySet<string>, nodes: ReadonlyMap<string, ProjectedCanvasNode>): string {
  return [...paths]
    .map((path) => imageNodeSourceSignature(nodes.get(path)))
    .filter((entry): entry is string => entry !== undefined)
    .join('\u001f');
}

function isImageNode(node: ProjectedCanvasNode | undefined): node is ProjectedCanvasNode {
  return node?.nodeKind === 'file' && node.mediaKind === 'image';
}

function imageNodeSourceSignature(node: ProjectedCanvasNode | undefined): string | undefined {
  if (!isImageNode(node)) {
    return undefined;
  }
  if (node.availability.state !== 'available') {
    return [
      node.projectRelativePath,
      String(node.visible !== false),
      node.availability.state,
      node.availability.message,
      rectSignature(nodeRect(node))
    ].join('\u001d');
  }
  return [
    node.projectRelativePath,
    String(node.visible !== false),
    node.availability.state,
    node.availability.fileUrl,
    node.availability.revision,
    String(node.availability.canvasImagePreviewable === true),
    String(node.availability.canvasImagePreviewSourceWidth ?? ''),
    rectSignature(nodeRect(node))
  ].join('\u001d');
}

function isAvailableVisibleImageNode(
  node: ProjectedCanvasNode | undefined
): node is ProjectedCanvasNode & { availability: Extract<ProjectedCanvasNode['availability'], { state: 'available' }> } {
  return node?.nodeKind === 'file'
    && node.mediaKind === 'image'
    && node.visible !== false
    && node.availability.state === 'available'
    && Boolean(node.availability.fileUrl);
}

function pointDistance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function canvasImagePerfTimestamp(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
