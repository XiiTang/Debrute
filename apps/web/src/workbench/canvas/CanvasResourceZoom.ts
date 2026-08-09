import type { CanvasCameraState } from './runtime/canvasCamera.js';
import { assertPositiveFiniteNumber } from './runtime/canvasGeometry.js';

export function initialCanvasResourceZoom(cameraZoom: number): number {
  assertResourceZoomInput(cameraZoom);
  return cameraZoom;
}

export const CANVAS_PREVIEW_QUALITY_SETTLE_MS = 500;

export interface CanvasResourceZoomSettlement {
  observeCamera(cameraZoom: number): void;
  dispose(): void;
}

export function createCanvasResourceZoomSettlement(input: {
  initialZoom: number;
  getCameraSnapshot: () => {
    cameraState: CanvasCameraState;
    camera: { z: number };
  };
  onSettledZoom: (zoom: number) => void;
}): CanvasResourceZoomSettlement {
  let resourceZoom = initialCanvasResourceZoom(input.initialZoom);
  let pendingZoom = resourceZoom;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearSettleTimer = () => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  return {
    observeCamera(cameraZoom) {
      if (disposed) {
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
        input.onSettledZoom(resourceZoom);
      }, CANVAS_PREVIEW_QUALITY_SETTLE_MS);
    },
    dispose() {
      disposed = true;
      clearSettleTimer();
    }
  };
}

function assertResourceZoomInput(cameraZoom: number): void {
  assertPositiveFiniteNumber(cameraZoom, 'Canvas resource zoom must be a positive finite number.');
}
