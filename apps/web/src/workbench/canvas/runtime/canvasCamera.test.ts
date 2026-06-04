import { describe, expect, it } from 'vitest';
import {
  assertCanvasCamera,
  cameraCenteredOnCanvasPoint,
  cameraForGestureZoom,
  cameraForWheelDelta,
  cameraPanBy,
  canvasCameraTransform,
  DEFAULT_CANVAS_CAMERA
} from './canvasCamera';

describe('canvas camera runtime', () => {
  it('uses a clean camera default', () => {
    expect(DEFAULT_CANVAS_CAMERA).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('rejects invalid camera values', () => {
    expect(() => assertCanvasCamera({ x: 0, y: 0, z: 0 })).toThrow('Canvas camera z must be a positive finite number.');
    expect(() => assertCanvasCamera({ x: Number.NaN, y: 0, z: 1 })).toThrow('Canvas camera coordinates must be finite numbers.');
  });

  it('serializes the stage transform from camera values', () => {
    expect(canvasCameraTransform({ x: 12, y: -8, z: 1.5 })).toBe('translate(12px, -8px) scale(1.5)');
  });

  it('pans camera by screen delta without changing zoom', () => {
    expect(cameraPanBy({ x: 10, y: 20, z: 2 }, { x: -12, y: 8 })).toEqual({ x: -2, y: 28, z: 2 });
  });

  it('zooms around a screen point for Ctrl/Cmd wheel input', () => {
    const camera = cameraForWheelDelta({
      camera: { x: 10, y: 20, z: 2 },
      surfaceRect: { left: 100, top: 50 },
      screenPoint: { x: 300, y: 250 },
      delta: { x: 0, y: 0, z: 0.1 }
    });

    expect(camera.z).toBeCloseTo(2.2);
    expect(camera.x).toBeCloseTo(-9);
    expect(camera.y).toBeCloseTo(2);
  });

  it('combines gesture scale and gesture-center movement in one camera update', () => {
    const camera = cameraForGestureZoom({
      camera: { x: 10, y: 20, z: 2 },
      surfaceRect: { left: 100, top: 50 },
      origin: { x: 300, y: 250 },
      scale: 1.25,
      delta: { x: 12, y: -6 }
    });

    expect(camera.z).toBeCloseTo(2.5);
    expect(camera.x).toBeCloseTo(-25.5);
    expect(camera.y).toBeCloseTo(-31);
  });

  it('centers a canvas point while preserving zoom', () => {
    expect(cameraCenteredOnCanvasPoint({
      center: { x: 400, y: 300 },
      surfaceSize: { width: 1000, height: 600 },
      camera: { z: 0.5 }
    })).toEqual({ x: 300, y: 150, z: 0.5 });
  });
});
