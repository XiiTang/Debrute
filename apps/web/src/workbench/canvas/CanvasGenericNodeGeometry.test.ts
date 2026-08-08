import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_GENERIC_NODE_AUTOMATIC_MAX_WIDTH,
  CANVAS_GENERIC_NODE_AUTOMATIC_MIN_WIDTH,
  CANVAS_GENERIC_NODE_PRESENTATION_HEIGHT,
  canvasGenericNodeSceneSizes
} from './CanvasGenericNodeGeometry.js';

describe('CanvasGenericNodeGeometry', () => {
  it('batches unique full-row measurements and applies ceil before one continuous clamp', () => {
    const measure = vi.fn((labels: readonly string[]) => new Map(labels.map((label) => [
      label,
      label === 'short' ? 80.2 : label === 'intrinsic' ? 177.01 : 480.4
    ])));

    const sizes = canvasGenericNodeSceneSizes(
      ['short', 'intrinsic', 'long', 'intrinsic'],
      measure
    );

    expect(measure).toHaveBeenCalledOnce();
    expect(measure).toHaveBeenCalledWith(['short', 'intrinsic', 'long']);
    expect(sizes.get('short')).toEqual({ width: 1_200, height: 480 });
    expect(sizes.get('intrinsic')).toEqual({ width: 1_780, height: 480 });
    expect(sizes.get('long')).toEqual({ width: 3_600, height: 480 });
  });

  it('publishes the sole automatic bounds and presentation height', () => {
    expect(CANVAS_GENERIC_NODE_AUTOMATIC_MIN_WIDTH).toBe(120);
    expect(CANVAS_GENERIC_NODE_AUTOMATIC_MAX_WIDTH).toBe(360);
    expect(CANVAS_GENERIC_NODE_PRESENTATION_HEIGHT).toBe(48);
  });

  it('fails instead of substituting a second sizing formula', () => {
    expect(() => canvasGenericNodeSceneSizes(['missing'], () => new Map())).toThrow(
      'Canvas generic identity-row measurement is missing'
    );
  });
});
