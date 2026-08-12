import { describe, expect, it } from 'vitest';
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  normalizeCanvasSelection,
  pruneCanvasSelection,
  sameCanvasSelection,
  selectedNodeProjectRelativePaths,
  soleSelectedNodeProjectRelativePath,
  toggleCanvasNodeSelection,
  unionCanvasNodeSelection
} from './canvasSelection';

describe('Canvas Node Selection', () => {
  it('represents one and many nodes with one canonical nodes selection', () => {
    expect(canvasNodeSelection([])).toBeUndefined();
    expect(canvasNodeSelection(['flow/z.png'])).toEqual({
      projectRelativePaths: ['flow/z.png']
    });
    expect(canvasNodeSelection(['flow/z.png', 'flow/a.png', 'flow/z.png'])).toEqual({
      projectRelativePaths: ['flow/a.png', 'flow/z.png']
    });
    expect(normalizeCanvasSelection({
      projectRelativePaths: ['flow/z.png', 'flow/a.png', 'flow/z.png']
    })).toEqual({
      projectRelativePaths: ['flow/a.png', 'flow/z.png']
    });
  });

  it('toggles nodes in the current node selection', () => {
    expect(toggleCanvasNodeSelection(canvasNodeSelection(['flow/a.png']), 'flow/b.png')).toEqual({
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });
    expect(toggleCanvasNodeSelection(canvasNodeSelection(['flow/a.png']), 'flow/a.png')).toBeUndefined();
  });

  it('unions node selections', () => {
    expect(unionCanvasNodeSelection(
      canvasNodeSelection(['flow/b.png']),
      ['flow/c.png', 'flow/a.png']
    )).toEqual({
      projectRelativePaths: ['flow/a.png', 'flow/b.png', 'flow/c.png']
    });
  });

  it('prunes missing nodes', () => {
    expect(pruneCanvasSelection(
      canvasNodeSelection(['flow/a.png', 'flow/b.png']),
      new Set(['flow/b.png', 'flow/c.png'])
    )).toEqual({
      projectRelativePaths: ['flow/b.png']
    });
  });

  it('reads membership and compares canonical selections', () => {
    const selection = canvasNodeSelection(['flow/a.png', 'flow/b.png']);
    expect(selectedNodeProjectRelativePaths(selection)).toEqual(['flow/a.png', 'flow/b.png']);
    expect(isCanvasNodeSelected(selection, 'flow/a.png')).toBe(true);
    expect(isCanvasNodeSelected(selection, 'flow/c.png')).toBe(false);
    expect(sameCanvasSelection(selection, canvasNodeSelection(['flow/b.png', 'flow/a.png']))).toBe(true);
  });

  it('returns a sole node path only for a one-node selection', () => {
    expect(soleSelectedNodeProjectRelativePath(undefined)).toBeUndefined();
    expect(soleSelectedNodeProjectRelativePath(canvasNodeSelection(['flow/a.md']))).toBe('flow/a.md');
    expect(soleSelectedNodeProjectRelativePath(canvasNodeSelection([
      'flow/a.md',
      'flow/b.md'
    ]))).toBeUndefined();
  });
});
