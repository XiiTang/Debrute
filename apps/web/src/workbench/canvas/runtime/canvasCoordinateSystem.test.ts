import { describe, expect, it } from 'vitest';
import {
  canvasRectToScreenRect,
  canvasToScreenPoint,
  screenToCanvasPoint,
  visibleCanvasRectForCamera
} from './canvasCoordinateSystem';

describe('canvas coordinate system', () => {
  it('converts screen points through camera and surface bounds', () => {
    expect(screenToCanvasPoint({
      camera: { x: 40, y: 20, z: 2 },
      surfaceRect: { left: 100, top: 50 },
      screenPoint: { x: 300, y: 250 }
    })).toEqual({ x: 80, y: 90 });
  });

  it('converts canvas points to screen coordinates', () => {
    expect(canvasToScreenPoint({
      camera: { x: 40, y: 20, z: 2 },
      surfaceRect: { left: 100, top: 50 },
      canvasPoint: { x: 80, y: 90 }
    })).toEqual({ x: 300, y: 250 });
  });

  it('projects canvas rectangles to screen rectangles', () => {
    expect(canvasRectToScreenRect({
      camera: { x: 30, y: 40, z: 2 },
      surfaceRect: { left: 10, top: 20 },
      canvasRect: { x: 100, y: 80, width: 200, height: 90 }
    })).toEqual({ x: 240, y: 220, width: 400, height: 180 });
  });

  it('derives visible canvas rect from camera and surface size', () => {
    expect(visibleCanvasRectForCamera({
      camera: { x: -200, y: -100, z: 2 },
      surfaceSize: { width: 1000, height: 600 }
    })).toEqual({ x: 100, y: 50, width: 500, height: 300 });
  });
});
