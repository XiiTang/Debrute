import { describe, expect, it } from 'vitest';
import type { CanvasRuntimePointerInteraction } from './CanvasEditorRuntime';
import { canvasSoleSelectedPresentationPath } from './useCanvasRuntimeSnapshot';

describe('Canvas presentation selection', () => {
  it('publishes only a settled sole selection while marquee membership is changing', () => {
    const activeMarquee = (
      initialPaths: readonly string[]
    ): CanvasRuntimePointerInteraction => ({
      kind: 'selection-marquee',
      pointerId: 1,
      phase: 'active',
      startScreen: { x: 0, y: 0 },
      currentScreen: { x: 10, y: 10 },
      start: { x: 0, y: 0 },
      current: { x: 10, y: 10 },
      rect: { x: 0, y: 0, width: 10, height: 10 },
      initialSelection: {
        projectRelativePaths: initialPaths
      },
      initialContentInteractionProjectRelativePath: undefined,
      additive: false,
      topEdgeInset: 0
    });

    expect(canvasSoleSelectedPresentationPath({
      selection: {
        projectRelativePaths: ['a.md', 'b.md']
      },
      pointerInteraction: undefined
    })).toBeUndefined();
    expect(canvasSoleSelectedPresentationPath({
      selection: {
        projectRelativePaths: ['a.md', 'b.md']
      },
      pointerInteraction: activeMarquee(['a.md'])
    })).toBe('a.md');
    expect(canvasSoleSelectedPresentationPath({
      selection: {
        projectRelativePaths: ['a.md']
      },
      pointerInteraction: activeMarquee(['a.md', 'b.md'])
    })).toBeUndefined();
  });
});
