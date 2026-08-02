import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';
import type { CanvasCameraState } from './runtime/canvasCamera';

export type CanvasPreviewResourceKind = 'image' | 'text' | 'video';
export type CanvasPreviewPriorityTier = 0 | 1;

export interface CanvasPreviewResourceInteractionState {
  cameraState: CanvasCameraState;
  pointerInteractionActive: boolean;
}

export interface CanvasPreviewResourceRequest {
  kind: CanvasPreviewResourceKind;
  nodeId: string;
  sourceKey: string;
  targetWidth: number;
  isCurrent: () => boolean;
  run: () => void;
}

export interface CanvasPreviewResourceScheduler {
  enqueue(request: CanvasPreviewResourceRequest): void;
  enqueuePublication(request: CanvasPreviewResourceRequest): void;
  cancel(kind: CanvasPreviewResourceKind, nodeId: string): void;
  setInteractionState(input: CanvasPreviewResourceInteractionState): void;
  getInteractionState(): CanvasPreviewResourceInteractionState;
  subscribeInteraction(listener: (state: CanvasPreviewResourceInteractionState) => void): () => void;
  dispose(): void;
}

export const CANVAS_PREVIEW_RESOURCE_OPERATIONS_PER_FRAME = 3;

export function canvasPreviewResourceInteractionActive(
  interaction: CanvasPreviewResourceInteractionState
): boolean {
  return interaction.cameraState !== 'idle' || interaction.pointerInteractionActive;
}

export function createCanvasPreviewResourceScheduler(input: {
  priorityForNode: (nodeId: string) => CanvasPreviewPriorityTier;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  now?: (() => number) | undefined;
  requestFrame?: ((callback: FrameRequestCallback) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}): CanvasPreviewResourceScheduler {
  const requestFrame = input.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = input.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  const now = input.now ?? (() => performance.now());
  const queuedStarts = new Map<string, CanvasPreviewResourceRequest>();
  const queuedPublications = new Map<string, CanvasPreviewResourceRequest>();
  let interactionState: CanvasPreviewResourceInteractionState = {
    cameraState: 'idle',
    pointerInteractionActive: false
  };
  const interactionListeners = new Set<(state: CanvasPreviewResourceInteractionState) => void>();
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
            targetWidth: request.targetWidth,
            priorityTier: input.priorityForNode(request.nodeId)
          }
        : undefined
    });
  };

  const interactionActive = (): boolean => canvasPreviewResourceInteractionActive(interactionState);

  const cancelPendingFrame = (): void => {
    if (frameHandle !== undefined) {
      cancelFrame(frameHandle);
      frameHandle = undefined;
    }
  };

  const scheduleFrame = (): void => {
    if (frameHandle !== undefined || (queuedStarts.size === 0 && queuedPublications.size === 0)) {
      return;
    }
    if (interactionActive()) {
      record('preview-resource-paused-moving');
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
    for (const queue of [queuedPublications, queuedStarts]) {
      for (const [key, request] of queue) {
        if (request.isCurrent()) {
          continue;
        }
        queue.delete(key);
        record('preview-resource-skip-stale', request);
      }
    }
    let completed = 0;
    const runTier = (
      queue: Map<string, CanvasPreviewResourceRequest>,
      phase: 'start' | 'publication',
      tier: CanvasPreviewPriorityTier
    ): void => {
      for (const [key, request] of [...queue]) {
        if (completed >= CANVAS_PREVIEW_RESOURCE_OPERATIONS_PER_FRAME) {
          break;
        }
        if (input.priorityForNode(request.nodeId) !== tier) {
          continue;
        }
        queue.delete(key);
        record(phase === 'start' ? 'preview-resource-started' : 'preview-publication-committed', request);
        request.run();
        completed += 1;
      }
    };
    for (const tier of [0, 1] as const) {
      runTier(queuedPublications, 'publication', tier);
      runTier(queuedStarts, 'start', tier);
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
    if (queuedStarts.size === 0 && queuedPublications.size === 0) {
      cancelPendingFrame();
    }
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
      if (
        interactionState.cameraState === inputState.cameraState
        && interactionState.pointerInteractionActive === inputState.pointerInteractionActive
      ) {
        return;
      }
      interactionState = { ...inputState };
      if (interactionActive()) {
        cancelPendingFrame();
      } else {
        scheduleFrame();
      }
      for (const listener of interactionListeners) {
        listener(interactionState);
      }
    },
    getInteractionState: () => interactionState,
    subscribeInteraction(listener) {
      interactionListeners.add(listener);
      return () => interactionListeners.delete(listener);
    },
    dispose() {
      queuedStarts.clear();
      queuedPublications.clear();
      interactionListeners.clear();
      cancelPendingFrame();
    }
  };
}

function previewResourceRequestKey(kind: CanvasPreviewResourceKind, nodeId: string): string {
  return `${kind}\u001f${nodeId}`;
}
