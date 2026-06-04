import type { NormalizedCanvasWheelDelta } from '../../services/canvasInteraction';
import { assertFiniteNumber, assertPositiveFiniteNumber, clamp, type CanvasPoint, type CanvasSize } from './canvasGeometry';

export interface CanvasCamera {
  x: number;
  y: number;
  z: number;
}

export type CanvasCameraState = 'idle' | 'moving';

export const DEFAULT_CANVAS_CAMERA: CanvasCamera = { x: 0, y: 0, z: 1 };
export const MIN_CANVAS_CAMERA_Z = 0.03;
export const MAX_CANVAS_CAMERA_Z = 10;
export const CANVAS_CAMERA_IDLE_MS = 64;

interface SurfaceRect {
  left: number;
  top: number;
}

export function assertCanvasCamera(camera: CanvasCamera): void {
  assertFiniteNumber(camera.x, 'Canvas camera coordinates must be finite numbers.');
  assertFiniteNumber(camera.y, 'Canvas camera coordinates must be finite numbers.');
  assertPositiveFiniteNumber(camera.z, 'Canvas camera z must be a positive finite number.');
}

export function canvasCameraTransform(camera: CanvasCamera): string {
  assertCanvasCamera(camera);
  return `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;
}

export function canvasChromeScale(camera: CanvasCamera): number {
  assertCanvasCamera(camera);
  return 1 / camera.z;
}

export function cameraPanBy(camera: CanvasCamera, screenDelta: CanvasPoint): CanvasCamera {
  assertCanvasCamera(camera);
  return {
    x: camera.x + screenDelta.x,
    y: camera.y + screenDelta.y,
    z: camera.z
  };
}

export function cameraForWheelDelta(input: {
  camera: CanvasCamera;
  surfaceRect: SurfaceRect;
  screenPoint: CanvasPoint;
  delta: NormalizedCanvasWheelDelta;
  panSpeed?: number;
  zoomSpeed?: number;
}): CanvasCamera {
  assertCanvasCamera(input.camera);
  const panSpeed = input.panSpeed ?? 1;
  const zoomSpeed = input.zoomSpeed ?? 1;
  if (input.delta.z === 0) {
    return cameraPanBy(input.camera, {
      x: input.delta.x * panSpeed,
      y: input.delta.y * panSpeed
    });
  }
  const localPoint = screenPointToSurfacePoint(input.screenPoint, input.surfaceRect);
  const anchor = {
    x: (localPoint.x - input.camera.x) / input.camera.z,
    y: (localPoint.y - input.camera.y) / input.camera.z
  };
  const z = clamp(
    input.camera.z + input.delta.z * zoomSpeed * input.camera.z,
    MIN_CANVAS_CAMERA_Z,
    MAX_CANVAS_CAMERA_Z
  );
  return {
    x: localPoint.x - anchor.x * z,
    y: localPoint.y - anchor.y * z,
    z
  };
}

export function cameraForGestureZoom(input: {
  camera: CanvasCamera;
  surfaceRect: SurfaceRect;
  origin: CanvasPoint;
  scale: number;
  delta: CanvasPoint;
}): CanvasCamera {
  assertCanvasCamera(input.camera);
  assertPositiveFiniteNumber(input.scale, 'Canvas gesture scale must be a positive finite number.');
  const localOrigin = screenPointToSurfacePoint(input.origin, input.surfaceRect);
  const anchor = {
    x: (localOrigin.x - input.camera.x) / input.camera.z,
    y: (localOrigin.y - input.camera.y) / input.camera.z
  };
  const z = clamp(input.camera.z * input.scale, MIN_CANVAS_CAMERA_Z, MAX_CANVAS_CAMERA_Z);
  return {
    x: localOrigin.x + input.delta.x - anchor.x * z,
    y: localOrigin.y + input.delta.y - anchor.y * z,
    z
  };
}

export function cameraCenteredOnCanvasPoint(input: {
  center: CanvasPoint;
  surfaceSize: CanvasSize;
  camera: Pick<CanvasCamera, 'z'>;
}): CanvasCamera {
  assertPositiveFiniteNumber(input.camera.z, 'Canvas camera z must be a positive finite number.');
  return {
    x: input.surfaceSize.width / 2 - input.center.x * input.camera.z,
    y: input.surfaceSize.height / 2 - input.center.y * input.camera.z,
    z: input.camera.z
  };
}

export function canvasCameraReset(): CanvasCamera {
  return { ...DEFAULT_CANVAS_CAMERA };
}

function screenPointToSurfacePoint(point: CanvasPoint, surfaceRect: SurfaceRect): CanvasPoint {
  return {
    x: point.x - surfaceRect.left,
    y: point.y - surfaceRect.top
  };
}
