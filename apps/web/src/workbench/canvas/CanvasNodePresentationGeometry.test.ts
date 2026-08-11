import { describe, expect, it } from 'vitest';
import {
  canvasTextPresentationGeometry,
  canvasVideoContentSizeForNode,
  canvasVideoNodeSizeForContent
} from './CanvasNodePresentationGeometry';

describe('CanvasNodePresentationGeometry', { tags: ['canvas-text'] }, () => {
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

describe('Canvas video presentation geometry', { tags: ['canvas-video'] }, () => {
  it('adds and removes the fixed title bar outside video Content Region geometry', () => {
    expect(canvasVideoNodeSizeForContent({ width: 1_920, height: 1_080 })).toEqual({
      width: 1_920,
      height: 1_400
    });
    expect(canvasVideoContentSizeForNode({ width: 1_920, height: 1_400 })).toEqual({
      width: 1_920,
      height: 1_080
    });
  });
});
