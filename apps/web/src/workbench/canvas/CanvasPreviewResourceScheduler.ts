import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import type { CanvasCameraState } from './runtime/canvasCamera';

export type CanvasPreviewResourceKind = 'image' | 'text' | 'text-source' | 'video';

export interface CanvasPreviewResourceRequest {
  kind: CanvasPreviewResourceKind;
  nodeId: string;
  sourceKey: string;
  targetWidth: number;
  isCurrent: () => boolean;
  isCulled: () => boolean;
  run: () => void;
}

export interface CanvasPreviewResourceScheduler {
  enqueue(request: CanvasPreviewResourceRequest): void;
  enqueuePublication(request: CanvasPreviewResourceRequest): void;
  cancel(kind: CanvasPreviewResourceKind, nodeId: string): void;
  setInteractionState(input: { cameraState: CanvasCameraState; dragActive: boolean }): void;
  notifyVisibilityChanged(): void;
  dispose(): void;
}

export const CANVAS_PREVIEW_RESOURCE_OPERATIONS_PER_FRAME = 3;

export function createCanvasPreviewResourceScheduler(input: {
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  now?: (() => number) | undefined;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
} = {}): CanvasPreviewResourceScheduler {
  const requestFrame = input.requestFrame ?? globalThis.window?.requestAnimationFrame?.bind(globalThis.window);
  const cancelFrame = input.cancelFrame ?? globalThis.window?.cancelAnimationFrame?.bind(globalThis.window);
  if (!requestFrame || !cancelFrame) {
    throw new Error('Canvas preview resource scheduling requires animation frame support.');
  }
  const now = input.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const queuedStarts = new Map<string, CanvasPreviewResourceRequest>();
  const queuedPublications = new Map<string, CanvasPreviewResourceRequest>();
  let cameraState: CanvasCameraState = 'idle';
  let dragActive = false;
  let frameHandle: number | undefined;

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

  const publicationNeedsFrame = (request: CanvasPreviewResourceRequest): boolean => (
    !request.isCurrent() || !request.isCulled()
  );

  const cancelPendingFrame = (): void => {
    if (frameHandle === undefined) {
      return;
    }
    cancelFrame(frameHandle);
    frameHandle = undefined;
  };

  const scheduleFrame = (): void => {
    if (frameHandle !== undefined || (queuedStarts.size === 0 && queuedPublications.size === 0)) {
      return;
    }
    if (interactionActive()) {
      record('preview-resource-paused-moving');
      return;
    }
    if (![...queuedPublications.values()].some(publicationNeedsFrame)
      && queuedStarts.size === 0) {
      return;
    }
    frameHandle = requestFrame(() => {
      frameHandle = undefined;
      runQueued();
    });
  };

  const runQueued = (): void => {
    if (interactionActive()) {
      scheduleFrame();
      return;
    }
    let completed = 0;
    const runCurrent = (
      queue: Map<string, CanvasPreviewResourceRequest>,
      phase: 'start' | 'publication'
    ): void => {
      for (const [key, request] of [...queue]) {
        if (completed >= CANVAS_PREVIEW_RESOURCE_OPERATIONS_PER_FRAME) {
          break;
        }
        if (!request.isCurrent()) {
          queue.delete(key);
          record('preview-resource-skip-stale', request);
          continue;
        }
        if (request.isCulled()) {
          if (phase === 'start') {
            queue.delete(key);
          }
          record('preview-resource-skip-culled', request);
          continue;
        }
        queue.delete(key);
        record(phase === 'start' ? 'preview-resource-started' : 'preview-publication-committed', request);
        request.run();
        completed += 1;
      }
    };
    runCurrent(queuedPublications, 'publication');
    if (completed < CANVAS_PREVIEW_RESOURCE_OPERATIONS_PER_FRAME) {
      runCurrent(queuedStarts, 'start');
    }
    scheduleFrame();
  };

  const enqueue = (
    queue: Map<string, CanvasPreviewResourceRequest>,
    request: CanvasPreviewResourceRequest,
    phase: 'start' | 'publication'
  ): void => {
    const key = previewResourceRequestKey(request.kind, request.nodeId);
    const replacing = queue.has(key);
    queue.set(key, request);
    if (phase === 'start') {
      record(replacing ? 'preview-resource-coalesced' : 'preview-resource-queued', request);
    } else {
      record(replacing ? 'preview-publication-coalesced' : 'preview-publication-queued', request);
    }
    scheduleFrame();
  };

  const cancel = (kind: CanvasPreviewResourceKind, nodeId: string): void => {
    const key = previewResourceRequestKey(kind, nodeId);
    queuedStarts.delete(key);
    queuedPublications.delete(key);
  };

  return {
    enqueue(request) {
      enqueue(queuedStarts, request, 'start');
    },
    enqueuePublication(request) {
      enqueue(queuedPublications, request, 'publication');
    },
    cancel,
    setInteractionState(inputState) {
      cameraState = inputState.cameraState;
      dragActive = inputState.dragActive;
      if (interactionActive()) {
        cancelPendingFrame();
        return;
      }
      scheduleFrame();
    },
    notifyVisibilityChanged() {
      scheduleFrame();
    },
    dispose() {
      queuedStarts.clear();
      queuedPublications.clear();
      cancelPendingFrame();
    }
  };
}

function previewResourceRequestKey(kind: CanvasPreviewResourceKind, nodeId: string): string {
  return `${kind}\u001f${nodeId}`;
}
