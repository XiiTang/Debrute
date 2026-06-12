import { describe, expect, it } from 'vitest';
import {
  chooseInitialActiveCanvasId,
  reorderCanvasIds
} from './canvasCardBarState';

describe('canvasCardBarState', () => {
  it('uses stored active canvas when it still exists', () => {
    expect(chooseInitialActiveCanvasId({
      storedActiveCanvasId: 'canvas-2',
      canvasOrder: ['canvas-1', 'canvas-2']
    })).toBe('canvas-2');
  });

  it('falls back to the first registry canvas when stored active canvas is missing', () => {
    expect(chooseInitialActiveCanvasId({
      storedActiveCanvasId: 'missing',
      canvasOrder: ['canvas-1', 'canvas-2']
    })).toBe('canvas-1');
  });

  it('reorders ids by drag source and drop target', () => {
    expect(reorderCanvasIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });
});
