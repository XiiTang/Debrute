import { describe, expect, it } from 'vitest';
import { reorderCanvasIds } from './canvasCardBarState';

describe('canvasCardBarState', () => {
  it('reorders ids by drag source and drop target', () => {
    expect(reorderCanvasIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });
});
