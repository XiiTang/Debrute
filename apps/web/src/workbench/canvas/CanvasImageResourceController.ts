import type { ProjectedCanvasNode } from '@debrute/canvas-core';
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
import type { CanvasCameraState } from './runtime/canvasCamera';
import type { CanvasRect } from './runtime/canvasGeometry';

export interface CanvasImageResourceViewport {
  visibleRect: CanvasRect;
  mountedNodePaths: ReadonlySet<string>;
  culledNodePaths: ReadonlySet<string>;
  imageResourceZoom: number;
  devicePixelRatio: number;
  imagePreviewsEnabled: boolean;
  cameraState: CanvasCameraState;
}

export interface CanvasImageResourceController {
  setNodes(nodes: ReadonlyMap<string, ProjectedCanvasNode>): void;
  setViewport(viewport: CanvasImageResourceViewport): void;
  getNodeState(projectRelativePath: string): CanvasImageNodeRenderState;
  subscribeNode(projectRelativePath: string, listener: () => void): () => void;
  retry(projectRelativePath: string): void;
  dispose(): void;
}

export type CanvasImageLoader = (item: CanvasImageLoadingPlanItem) => Promise<CanvasLoadedImage>;

interface CanvasImageResourceRecord {
  loaded?: CanvasLoadedImage;
  pending?: CanvasPendingImage;
  error?: CanvasImageLoadError;
}

export function createCanvasImageResourceController(input: {
  loadImage?: CanvasImageLoader;
  concurrency?: number;
} = {}): CanvasImageResourceController {
  const loadImage = input.loadImage ?? loadCanvasImageElement;
  const concurrency = input.concurrency ?? CANVAS_IMAGE_LOAD_CONCURRENCY;
  const nodes = new Map<string, ProjectedCanvasNode>();
  const records = new Map<string, CanvasImageResourceRecord>();
  const retryKeys = new Map<string, number>();
  const activeLoads = new Map<string, ActiveCanvasImageLoad>();
  const failedLoadKeys = new Set<string>();
  const subscribers = new Map<string, Set<() => void>>();
  const retryCallbacks = new Map<string, () => void>();
  const nodeStates = new Map<string, CanvasImageNodeRenderState>();

  let viewport: CanvasImageResourceViewport | undefined;
  let plan = new Map<string, CanvasImageLoadingPlanItem>();
  let disposed = false;

  const retry = (projectRelativePath: string) => {
    const previous = records.get(projectRelativePath);
    const currentPlanItem = plan.get(projectRelativePath);
    if (currentPlanItem) {
      failedLoadKeys.delete(currentPlanItem.loadKey);
    }
    if (previous?.loaded) {
      records.set(projectRelativePath, { loaded: previous.loaded });
    } else {
      records.delete(projectRelativePath);
    }
    retryKeys.set(projectRelativePath, (retryKeys.get(projectRelativePath) ?? 0) + 1);
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
    if (!record?.loaded && !record?.pending && !record?.error) {
      return { kind: 'placeholder', retry: retryForPath(projectRelativePath) };
    }
    return {
      kind: 'image',
      ...(record.loaded ? { loaded: record.loaded } : {}),
      ...(record.pending ? { pending: record.pending } : {}),
      ...(record.error ? { error: record.error } : {}),
      retry: retryForPath(projectRelativePath)
    };
  };

  const publish = (projectRelativePath: string) => {
    for (const listener of subscribers.get(projectRelativePath) ?? []) {
      listener();
    }
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
    publish(projectRelativePath);
  }

  function rebuildPlan(): void {
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
    for (const path of affectedPaths) {
      publishIfChanged(path);
    }
  }

  function clearUnmountedNodeResourceState(projectRelativePath: string): void {
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

  function startLoad(item: CanvasImageLoadingPlanItem): void {
    const active: ActiveCanvasImageLoad = { item };
    activeLoads.set(item.loadKey, active);
    const previous = records.get(item.projectRelativePath);
    records.set(item.projectRelativePath, {
      ...(previous?.loaded ? { loaded: previous.loaded } : {}),
      pending: { src: item.src, loadKey: item.loadKey }
    });
    publishIfChanged(item.projectRelativePath);

    void loadImage(item).then((loaded) => {
      if (!isCanvasImageLoadResultCurrent(active, plan)) {
        return;
      }
      failedLoadKeys.delete(item.loadKey);
      records.set(item.projectRelativePath, { loaded });
      rebuildPlan();
    }).catch(() => {
      if (!isCanvasImageLoadResultCurrent(active, plan)) {
        return;
      }
      failedLoadKeys.add(item.loadKey);
      const current = records.get(item.projectRelativePath);
      records.set(item.projectRelativePath, {
        ...(current?.loaded ? { loaded: current.loaded } : {}),
        error: {
          loadKey: item.loadKey,
          message: `Unable to load ${item.projectRelativePath}.`
        }
      });
      rebuildPlan();
    }).finally(() => {
      activeLoads.delete(item.loadKey);
      pump();
    });
  }

  function pump(): void {
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
      || !currentViewport.culledNodePaths.has(item.projectRelativePath)
    ));
    const openSlots = Math.max(0, concurrency - activeLoads.size);
    for (const item of candidates.slice(0, openSlots)) {
      startLoad(item);
    }
  }

  return {
    setNodes: (nextNodes) => {
      nodes.clear();
      for (const [path, node] of nextNodes) {
        nodes.set(path, node);
      }
      for (const path of [...records.keys()]) {
        if (!nodes.has(path)) {
          clearUnmountedNodeResourceState(path);
          publish(path);
        }
      }
      rebuildPlan();
      pump();
    },
    setViewport: (nextViewport) => {
      viewport = nextViewport;
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
    retry,
    dispose: () => {
      disposed = true;
      nodes.clear();
      records.clear();
      retryKeys.clear();
      failedLoadKeys.clear();
      activeLoads.clear();
      subscribers.clear();
      retryCallbacks.clear();
      nodeStates.clear();
      plan.clear();
      viewport = undefined;
    }
  };
}

function loadedImagesFromRecords(records: ReadonlyMap<string, CanvasImageResourceRecord>): Map<string, CanvasLoadedImage> {
  const loadedImages = new Map<string, CanvasLoadedImage>();
  for (const [path, record] of records) {
    if (record.loaded) {
      loadedImages.set(path, record.loaded);
    }
  }
  return loadedImages;
}

async function loadCanvasImageElement(item: CanvasImageLoadingPlanItem): Promise<CanvasLoadedImage> {
  const image = new Image();
  image.decoding = 'async';
  image.draggable = false;
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Unable to load ${item.projectRelativePath}.`));
  });
  image.src = item.src;
  await loaded;
  if (typeof image.decode === 'function') {
    await image.decode();
  }
  return {
    src: item.src,
    loadKey: item.loadKey
  };
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
    && previous.loaded?.loadKey === next.loaded?.loadKey
    && previous.loaded?.src === next.loaded?.src
    && previous.pending?.loadKey === next.pending?.loadKey
    && previous.pending?.src === next.pending?.src
    && previous.error?.loadKey === next.error?.loadKey
    && previous.error?.message === next.error?.message;
}
