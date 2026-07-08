import { describe, expect, it } from 'vitest';
import {
  CANVAS_TEXT_SURFACE_METRICS,
  canvasTextSurfaceCssVariables
} from './CanvasTextSurface';

describe('CanvasTextSurface', () => {
  it('emits all editor text metrics from one source', () => {
    expect(canvasTextSurfaceCssVariables()).toEqual({
      '--canvas-text-editor-font-family': CANVAS_TEXT_SURFACE_METRICS.fontFamily,
      '--canvas-text-editor-font-size': '12px',
      '--canvas-text-editor-line-height': '16.8px',
      '--canvas-text-editor-line-padding-inline': '8px',
      '--canvas-text-editor-gutter-padding-left': '5px',
      '--canvas-text-editor-gutter-padding-right': '3px',
      '--canvas-text-editor-tab-size': '4'
    });
  });

  it('keeps editor line height in the shared CSS variables', () => {
    expect(CANVAS_TEXT_SURFACE_METRICS.lineHeightPx).toBe(16.8);
    expect(canvasTextSurfaceCssVariables()['--canvas-text-editor-line-height']).toBe('16.8px');
  });
});
