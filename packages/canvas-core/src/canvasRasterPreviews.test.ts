import { describe, expect, it } from 'vitest';
import {
  CANVAS_RASTER_PREVIEW_MAX_SCALE,
  CANVAS_RASTER_PREVIEW_MIN_SCALE,
  canvasRasterPreviewSteppedScale,
  canvasRasterPreviewWidth,
  canvasRasterPreviewWidthsForSource
} from './canvasRasterPreviews';

describe('Canvas raster preview sizing', () => {
  it('uses the sqrt(2) scale ladder', () => {
    expect(CANVAS_RASTER_PREVIEW_MIN_SCALE).toBe(1 / 32);
    expect(CANVAS_RASTER_PREVIEW_MAX_SCALE).toBe(1);
    expect(canvasRasterPreviewSteppedScale(0.18)).toBe(0.25);
    expect(canvasRasterPreviewSteppedScale(0.26)).toBeCloseTo(Math.SQRT2 / 4);
    expect(canvasRasterPreviewSteppedScale(0.51)).toBeCloseTo(Math.SQRT2 / 2);
  });

  it('selects a preview width from displayed size, source width, zoom, and DPR', () => {
    expect(canvasRasterPreviewWidth({
      nodeDisplayWidth: 1200,
      sourceWidth: 2400,
      resourceZoom: 0.5,
      devicePixelRatio: 1
    })).toBe(600);
    expect(canvasRasterPreviewWidth({
      nodeDisplayWidth: 1200,
      sourceWidth: 2400,
      resourceZoom: 0.51,
      devicePixelRatio: 2
    })).toBe(1698);
  });

  it('returns the complete finite width set for one source', () => {
    expect(canvasRasterPreviewWidthsForSource({
      sourceWidth: 3200,
      devicePixelRatio: 1
    })).toEqual([100, 142, 200, 283, 400, 566, 800, 1132, 1600, 2263, 3200]);
  });

  it('rejects invalid numeric inputs', () => {
    expect(() => canvasRasterPreviewSteppedScale(0)).toThrow('Canvas raster preview screen scale must be a positive finite number.');
    expect(() => canvasRasterPreviewWidth({
      nodeDisplayWidth: 0,
      sourceWidth: 100,
      resourceZoom: 1,
      devicePixelRatio: 1
    })).toThrow('Canvas raster preview node display width must be a positive finite number.');
  });
});
