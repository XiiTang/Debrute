import type { CanvasCameraState } from './runtime/canvasCamera';
import { assertPositiveFiniteNumber } from './runtime/canvasGeometry';

export type CanvasResourceZoomState =
  | { cameraState: 'idle'; resourceZoom: number }
  | { cameraState: 'moving'; resourceZoom: number };

export function initialCanvasResourceZoomState(cameraZoom: number): CanvasResourceZoomState {
  assertResourceZoomInput(cameraZoom);
  return {
    cameraState: 'idle',
    resourceZoom: cameraZoom
  };
}

export function nextCanvasResourceZoomState(
  current: CanvasResourceZoomState,
  input: { cameraState: CanvasCameraState; cameraZoom: number }
): CanvasResourceZoomState {
  assertResourceZoomInput(input.cameraZoom);
  if (input.cameraState === 'idle') {
    return {
      cameraState: 'idle',
      resourceZoom: input.cameraZoom
    };
  }
  if (current.cameraState === 'moving') {
    return current;
  }
  return {
    cameraState: 'moving',
    resourceZoom: current.resourceZoom
  };
}

function assertResourceZoomInput(cameraZoom: number): void {
  assertPositiveFiniteNumber(cameraZoom, 'Canvas resource zoom must be a positive finite number.');
}
