import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import type { CanvasCameraState } from './runtime/canvasCamera';

export type CanvasPreviewResourceKind = 'image' | 'text' | 'video';

export interface CanvasPreviewResourceRequest {
  kind: CanvasPreviewResourceKind;
  nodeId: string;
  sourceKey: string;
  targetWidth: number;
  isCurrent: () => boolean;
  isCulled: () => boolean;
  run: () => void;
}

interface QueuedCanvasPreviewResourceRequest {
  request: CanvasPreviewResourceRequest;
  enqueuedAt: number;
}

export interface CanvasPreviewResourceScheduler {
  enqueue(request: CanvasPreviewResourceRequest): void;
  cancel(kind: CanvasPreviewResourceKind, nodeId: string): void;
  setInteractionState(input: { cameraState: CanvasCameraState; dragActive: boolean }): void;
  dispose(): void;
}

export const CANVAS_PREVIEW_RESOURCE_SETTLE_MS = 500;
const CANVAS_PREVIEW_RESOURCE_STARTS_PER_FRAME = 3;

export function createCanvasPreviewResourceScheduler(input: {
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  now?: (() => number) | undefined;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
  setTimeout?: ((callback: () => void, delay: number) => number) | undefined;
  clearTimeout?: ((handle: number) => void) | undefined;
  settleMs?: number | undefined;
} = {}): CanvasPreviewResourceScheduler {
  const requestFrame = input.requestFrame ?? globalThis.window?.requestAnimationFrame?.bind(globalThis.window);
  const cancelFrame = input.cancelFrame ?? globalThis.window?.cancelAnimationFrame?.bind(globalThis.window);
  const setTimer = input.setTimeout ?? globalThis.window?.setTimeout?.bind(globalThis.window);
  const clearTimer = input.clearTimeout ?? globalThis.window?.clearTimeout?.bind(globalThis.window);
  if (!requestFrame || !cancelFrame || !setTimer || !clearTimer) {
    throw new Error('Canvas preview resource scheduling requires animation frame and timer support.');
  }
  const now = input.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const settleMs = input.settleMs ?? CANVAS_PREVIEW_RESOURCE_SETTLE_MS;
  const queued = new Map<string, QueuedCanvasPreviewResourceRequest>();
  let cameraState: CanvasCameraState = 'idle';
  let dragActive = false;
  let frameHandle: number | undefined;
  let settleTimer: number | undefined;
  let lastInteractionAt: number | undefined;

  const record = (name: CanvasPerfCounterName, request?: CanvasPreviewResourceRequest): void => {
    input.perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: now(),
      source: 'CanvasPreviewResourceScheduler',
      name,
      detail: request
        ? {
            kind: request.kind,
            nodeId: request.nodeId,
            sourceKey: request.sourceKey,
            targetWidth: request.targetWidth
          }
        : undefined
    });
  };

  const interactionActive = (): boolean => cameraState !== 'idle' || dragActive;

  const eligibleAt = (item: QueuedCanvasPreviewResourceRequest): number => (
    lastInteractionAt === undefined
      ? item.enqueuedAt + settleMs
      : Math.max(lastInteractionAt, item.enqueuedAt) + settleMs
  );

  const canStart = (item: QueuedCanvasPreviewResourceRequest): boolean => (
    !interactionActive() && now() >= eligibleAt(item)
  );

  const cancelSettleTimer = (): void => {
    if (settleTimer === undefined) {
      return;
    }
    clearTimer(settleTimer);
    settleTimer = undefined;
  };

  const cancelPendingFrame = (): void => {
    if (frameHandle === undefined) {
      return;
    }
    cancelFrame(frameHandle);
    frameHandle = undefined;
  };

  const scheduleSettleTimer = (): void => {
    if (interactionActive() || settleTimer !== undefined || queued.size === 0) {
      return;
    }
    const nextEligibleAt = Math.min(...[...queued.values()].map(eligibleAt));
    const delay = Math.max(0, nextEligibleAt - now());
    settleTimer = setTimer(() => {
      settleTimer = undefined;
      scheduleFrame();
    }, delay);
  };

  const scheduleFrame = (): void => {
    if (frameHandle !== undefined || queued.size === 0) {
      return;
    }
    if (interactionActive()) {
      record('preview-resource-paused-moving');
      scheduleSettleTimer();
      return;
    }
    if (![...queued.values()].some(canStart)) {
      scheduleSettleTimer();
      return;
    }
    frameHandle = requestFrame(() => {
      frameHandle = undefined;
      startQueued();
    });
  };

  const startQueued = (): void => {
    if (interactionActive() || ![...queued.values()].some(canStart)) {
      scheduleFrame();
      return;
    }
    let started = 0;
    for (const [key, item] of queued) {
      if (started >= CANVAS_PREVIEW_RESOURCE_STARTS_PER_FRAME) {
        break;
      }
      if (!canStart(item)) {
        continue;
      }
      const { request } = item;
      queued.delete(key);
      if (!request.isCurrent()) {
        record('preview-resource-skip-stale', request);
        continue;
      }
      if (request.isCulled()) {
        record('preview-resource-skip-culled', request);
        continue;
      }
      record('preview-resource-started', request);
      request.run();
      started += 1;
    }
    scheduleFrame();
  };

  return {
    enqueue(request) {
      const key = previewResourceRequestKey(request.kind, request.nodeId);
      const replacing = queued.has(key);
      queued.set(key, { request, enqueuedAt: now() });
      record(replacing ? 'preview-resource-coalesced' : 'preview-resource-queued', request);
      scheduleFrame();
    },
    cancel(kind, nodeId) {
      queued.delete(previewResourceRequestKey(kind, nodeId));
      if (queued.size === 0) {
        cancelSettleTimer();
      }
    },
    setInteractionState(inputState) {
      cameraState = inputState.cameraState;
      dragActive = inputState.dragActive;
      if (interactionActive()) {
        lastInteractionAt = now();
        cancelPendingFrame();
        cancelSettleTimer();
        return;
      }
      scheduleFrame();
    },
    dispose() {
      queued.clear();
      cancelPendingFrame();
      cancelSettleTimer();
    }
  };
}

function previewResourceRequestKey(kind: CanvasPreviewResourceKind, nodeId: string): string {
  return `${kind}\u001f${nodeId}`;
}
