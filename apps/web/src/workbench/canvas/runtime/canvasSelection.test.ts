import { describe, expect, it } from 'vitest';
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  normalizeCanvasSelection,
  pruneCanvasSelection,
  sameCanvasSelection,
  selectedNodeProjectRelativePaths,
  toggleCanvasNodeSelection,
  unionCanvasNodeSelection
} from './canvasSelection';

describe('Canvas Node Selection', () => {
  it('represents one and many nodes with one canonical nodes selection', () => {
    expect(canvasNodeSelection([])).toBeUndefined();
    expect(canvasNodeSelection(['flow/z.png'])).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/z.png']
    });
    expect(canvasNodeSelection(['flow/z.png', 'flow/a.png', 'flow/z.png'])).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/z.png']
    });
    expect(normalizeCanvasSelection({
      kind: 'nodes',
      projectRelativePaths: ['flow/z.png', 'flow/a.png', 'flow/z.png']
    })).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/z.png']
    });
  });

  it('toggles nodes without mixing a diagnostic into node selection', () => {
    const diagnostic = { kind: 'diagnostic' as const, id: 'diagnostic-1' };

    expect(toggleCanvasNodeSelection(diagnostic, 'flow/a.png')).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });
    expect(toggleCanvasNodeSelection(canvasNodeSelection(['flow/a.png']), 'flow/b.png')).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png']
    });
    expect(toggleCanvasNodeSelection(canvasNodeSelection(['flow/a.png']), 'flow/a.png')).toBeUndefined();
  });

  it('unions with node selections and replaces diagnostics', () => {
    expect(unionCanvasNodeSelection(
      canvasNodeSelection(['flow/b.png']),
      ['flow/c.png', 'flow/a.png']
    )).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png', 'flow/b.png', 'flow/c.png']
    });
    expect(unionCanvasNodeSelection(
      { kind: 'diagnostic', id: 'diagnostic-1' },
      ['flow/a.png']
    )).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/a.png']
    });
  });

  it('prunes missing nodes while preserving diagnostics that are reconciled elsewhere', () => {
    expect(pruneCanvasSelection(
      canvasNodeSelection(['flow/a.png', 'flow/b.png']),
      new Set(['flow/b.png', 'flow/c.png'])
    )).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['flow/b.png']
    });
    expect(pruneCanvasSelection(
      { kind: 'diagnostic', id: 'diagnostic-1' },
      new Set()
    )).toEqual({ kind: 'diagnostic', id: 'diagnostic-1' });
  });

  it('reads membership and compares canonical selections', () => {
    const selection = canvasNodeSelection(['flow/a.png', 'flow/b.png']);
    expect(selectedNodeProjectRelativePaths(selection)).toEqual(['flow/a.png', 'flow/b.png']);
    expect(isCanvasNodeSelected(selection, 'flow/a.png')).toBe(true);
    expect(isCanvasNodeSelected(selection, 'flow/c.png')).toBe(false);
    expect(sameCanvasSelection(selection, canvasNodeSelection(['flow/b.png', 'flow/a.png']))).toBe(true);
    expect(sameCanvasSelection(selection, { kind: 'diagnostic', id: 'diagnostic-1' })).toBe(false);
  });
});
