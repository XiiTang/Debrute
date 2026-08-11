import type { CanvasCameraState } from './runtime/canvasCamera';
import { assertPositiveFiniteNumber } from './runtime/canvasGeometry';

export function initialCanvasResourceZoom(cameraZoom: number): number {
  assertResourceZoomInput(cameraZoom);
  return cameraZoom;
}

export const CANVAS_PREVIEW_QUALITY_SETTLE_MS = 160;

export interface CanvasResourceZoomSource {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

export interface CanvasResourceZoomSettlement extends CanvasResourceZoomSource {
  attach(): () => void;
  observeCamera(cameraZoom: number): void;
}

export function createCanvasResourceZoomSettlement(input: {
  initialZoom: number;
  getCameraSnapshot: () => {
    cameraState: CanvasCameraState;
    camera: { z: number };
  };
}): CanvasResourceZoomSettlement {
  let resourceZoom = initialCanvasResourceZoom(input.initialZoom);
  let pendingZoom = resourceZoom;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let activeAttachment: object | undefined;
  const listeners = new Set<() => void>();

  const clearSettleTimer = () => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  return {
    getSnapshot: () => resourceZoom,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach() {
      if (activeAttachment) {
        throw new Error('Canvas Resource Zoom Settlement is already attached.');
      }
      const attachment = {};
      activeAttachment = attachment;
      return () => {
        if (activeAttachment !== attachment) {
          return;
        }
        activeAttachment = undefined;
        clearSettleTimer();
      };
    },
    observeCamera(cameraZoom) {
      if (!activeAttachment) {
        return;
      }
      assertResourceZoomInput(cameraZoom);
      clearSettleTimer();
      pendingZoom = cameraZoom;
      if (pendingZoom === resourceZoom) {
        return;
      }
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        const snapshot = input.getCameraSnapshot();
        if (
          snapshot.cameraState !== 'idle'
          || snapshot.camera.z !== pendingZoom
          || pendingZoom === resourceZoom
        ) {
          return;
        }
        resourceZoom = pendingZoom;
        for (const listener of listeners) {
          listener();
        }
      }, CANVAS_PREVIEW_QUALITY_SETTLE_MS);
    }
  };
}

function assertResourceZoomInput(cameraZoom: number): void {
  assertPositiveFiniteNumber(cameraZoom, 'Canvas resource zoom must be a positive finite number.');
}
