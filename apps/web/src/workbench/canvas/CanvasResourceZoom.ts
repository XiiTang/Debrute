import type { CanvasCameraState } from './runtime/canvasCamera.js';
import { assertPositiveFiniteNumber } from './runtime/canvasGeometry.js';

export function initialCanvasResourceZoom(cameraZoom: number): number {
  assertResourceZoomInput(cameraZoom);
  return cameraZoom;
}

export function nextCanvasResourceZoom(
  currentResourceZoom: number,
  input: { cameraState: CanvasCameraState; cameraZoom: number }
): number {
  assertResourceZoomInput(input.cameraZoom);
  if (input.cameraState === 'moving') {
    return currentResourceZoom;
  }
  return input.cameraZoom;
}

function assertResourceZoomInput(cameraZoom: number): void {
  assertPositiveFiniteNumber(cameraZoom, 'Canvas resource zoom must be a positive finite number.');
}
