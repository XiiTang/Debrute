import type { CanvasCamera } from './canvasCamera';
import { assertCanvasCamera } from './canvasCamera';
import type { CanvasPoint, CanvasRect, CanvasSize } from './canvasGeometry';

interface SurfaceRect {
  left: number;
  top: number;
}

export function screenToCanvasPoint(input: {
  camera: CanvasCamera;
  surfaceRect: SurfaceRect;
  screenPoint: CanvasPoint;
}): CanvasPoint {
  assertCanvasCamera(input.camera);
  return {
    x: (input.screenPoint.x - input.surfaceRect.left - input.camera.x) / input.camera.z,
    y: (input.screenPoint.y - input.surfaceRect.top - input.camera.y) / input.camera.z
  };
}

export function canvasToScreenPoint(input: {
  camera: CanvasCamera;
  surfaceRect: SurfaceRect;
  canvasPoint: CanvasPoint;
}): CanvasPoint {
  assertCanvasCamera(input.camera);
  return {
    x: input.surfaceRect.left + input.camera.x + input.canvasPoint.x * input.camera.z,
    y: input.surfaceRect.top + input.camera.y + input.canvasPoint.y * input.camera.z
  };
}

export function canvasRectToScreenRect(input: {
  camera: CanvasCamera;
  surfaceRect: SurfaceRect;
  canvasRect: CanvasRect;
}): CanvasRect {
  const point = canvasToScreenPoint({
    camera: input.camera,
    surfaceRect: input.surfaceRect,
    canvasPoint: {
      x: input.canvasRect.x,
      y: input.canvasRect.y
    }
  });
  return {
    x: point.x,
    y: point.y,
    width: input.canvasRect.width * input.camera.z,
    height: input.canvasRect.height * input.camera.z
  };
}

export function visibleCanvasRectForCamera(input: {
  camera: CanvasCamera;
  surfaceSize: Partial<CanvasSize> | undefined;
}): CanvasRect {
  assertCanvasCamera(input.camera);
  const size = normalizedSurfaceSize(input.surfaceSize);
  return {
    x: -input.camera.x / input.camera.z,
    y: -input.camera.y / input.camera.z,
    width: size.width / input.camera.z,
    height: size.height / input.camera.z
  };
}

export function normalizedSurfaceSize(size: Partial<CanvasSize> | undefined): CanvasSize {
  return {
    width: positiveFinite(size?.width) ? size.width : 1280,
    height: positiveFinite(size?.height) ? size.height : 720
  };
}

function positiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
