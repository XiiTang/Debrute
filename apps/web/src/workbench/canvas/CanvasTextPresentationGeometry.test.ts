import { describe, expect, it } from 'vitest';
import { canvasTextPresentationGeometry } from './CanvasTextPresentationGeometry.js';

describe('CanvasTextPresentationGeometry', { tags: ['canvas-text'] }, () => {
  it('derives one camera-independent editor and capture geometry from the node', () => {
    expect(canvasTextPresentationGeometry({ width: 4200, height: 2800 })).toEqual({
      presentationScale: 10,
      frameCssWidth: 420,
      frameCssHeight: 280,
      contentCssWidth: 420,
      contentCssHeight: 248,
      titlebarCssHeight: 32
    });
  });

  it('rounds once at the shared geometry boundary', () => {
    expect(canvasTextPresentationGeometry({ width: 4204.9, height: 2805.1 })).toMatchObject({
      frameCssWidth: 420,
      frameCssHeight: 281,
      contentCssWidth: 420,
      contentCssHeight: 249
    });
  });

  it('keeps a positive content viewport for very small valid nodes', () => {
    expect(canvasTextPresentationGeometry({ width: 1, height: 1 })).toMatchObject({
      frameCssWidth: 1,
      frameCssHeight: 33,
      contentCssWidth: 1,
      contentCssHeight: 1
    });
  });
});
