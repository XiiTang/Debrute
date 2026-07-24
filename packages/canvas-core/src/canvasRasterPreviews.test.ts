import { describe, expect, it } from 'vitest';
import { canvasRasterPreviewWidth } from './canvasRasterPreviews';

describe('Canvas raster preview sizing', () => {
  it('uses source width rather than a fixed cross-media maximum', () => {
    expect(canvasRasterPreviewWidth({
      nodeDisplayWidth: 8256,
      sourceWidth: 8256,
      resourceZoom: 1,
      devicePixelRatio: 2
    })).toBe(8256);
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

  it('rejects invalid numeric inputs', () => {
    expect(() => canvasRasterPreviewWidth({
      nodeDisplayWidth: 0,
      sourceWidth: 100,
      resourceZoom: 1,
      devicePixelRatio: 1
    })).toThrow('Canvas raster preview node display width must be a positive finite number.');
  });
});
