import { describe, expect, it } from 'vitest';
import {
  closeTextEditorWindowState,
  commitTextEditorWindowRect,
  constrainOpenTextEditorWindowsToViewport,
  openTextEditorWindowState,
  resolveTextEditorWindowGestureRect,
  textBufferStatus
} from './textEditorWindows';

const viewport = { x: 0, y: 0, width: 1280, height: 720 };
const statusLabels = {
  loading: 'Loading',
  error: 'Error',
  externalChange: 'External change',
  saving: 'Saving'
};

describe('text editor window state', () => {
  it('opens existing windows and creates new windows with stable defaults', () => {
    expect(openTextEditorWindowState({}, 'notes/brief.md', viewport)).toEqual({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 420,
        y: 100,
        width: 820,
        height: 620
      }
    });

    expect(openTextEditorWindowState({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: false,
        x: 900,
        y: 650,
        width: 600,
        height: 500
      }
    }, 'notes/brief.md', viewport)).toEqual({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 680,
        y: 220,
        width: 600,
        height: 500
      }
    });
  });

  it('closes and commits moved windows without inventing missing entries', () => {
    const windows = {
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 12,
        y: 20,
        width: 600,
        height: 500
      }
    };

    expect(closeTextEditorWindowState(windows, 'missing.md')).toBe(windows);
    expect(closeTextEditorWindowState(windows, 'notes/brief.md')['notes/brief.md']!.open).toBe(false);
    const preview = resolveTextEditorWindowGestureRect({
      ...windows['notes/brief.md'],
      x: -8,
      y: 27
    }, { kind: 'move' }, viewport);
    expect(commitTextEditorWindowRect(windows, 'notes/brief.md', preview)['notes/brief.md']).toMatchObject({
      x: 0,
      y: 27
    });
  });

  it('keeps floating text editor windows contained and caps oversized windows to the viewport', () => {
    const windows = {
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 200,
        y: 200,
        width: 1400,
        height: 900
      },
      'notes/closed.md': {
        projectRelativePath: 'notes/closed.md',
        open: false,
        x: 2000,
        y: 2000,
        width: 600,
        height: 500
      }
    };

    const next = constrainOpenTextEditorWindowsToViewport(windows, viewport);

    expect(next['notes/brief.md']).toEqual({
      projectRelativePath: 'notes/brief.md',
      open: true,
      x: 0,
      y: 0,
      width: 1280,
      height: 720
    });
    expect(next['notes/closed.md']).toEqual(windows['notes/closed.md']);
  });

  it('resizes expanded text editor windows and clamps undersized west-edge drags', () => {
    const windows = {
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 100,
        y: 120,
        width: 600,
        height: 420
      }
    };

    const expanded = resolveTextEditorWindowGestureRect({
      x: 100,
      y: 120,
      width: 720,
      height: 500
    }, { kind: 'resize', direction: 'se' }, viewport);

    expect(commitTextEditorWindowRect(windows, 'missing.md', expanded)).toBe(windows);
    expect(commitTextEditorWindowRect(windows, 'notes/brief.md', expanded)['notes/brief.md']).toMatchObject({
      x: 100,
      y: 120,
      width: 720,
      height: 500
    });

    const clamped = resolveTextEditorWindowGestureRect({
      x: 660,
      y: 120,
      width: 40,
      height: 420
    }, { kind: 'resize', direction: 'w' }, viewport);
    expect(commitTextEditorWindowRect(windows, 'notes/brief.md', clamped)['notes/brief.md']).toMatchObject({
      x: 280,
      y: 120,
      width: 420,
      height: 420
    });
  });

  it('resolves preview geometry without changing text editor state until commit', () => {
    const windows = {
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 100,
        y: 120,
        width: 600,
        height: 420
      }
    };
    const preview = resolveTextEditorWindowGestureRect({
      x: 660,
      y: 120,
      width: 40,
      height: 420
    }, { kind: 'resize', direction: 'w' }, viewport);

    expect(preview).toEqual({ x: 280, y: 120, width: 420, height: 420 });
    expect(commitTextEditorWindowRect(windows, 'notes/brief.md', preview)['notes/brief.md']).toEqual({
      ...windows['notes/brief.md'],
      ...preview
    });
    expect(windows['notes/brief.md'].x).toBe(100);
  });

  it('does not surface the default saved text buffer state', () => {
    expect(textBufferStatus(
      {
        projectRelativePath: 'notes/brief.md',
        content: '# Brief',
        language: 'markdown',
        wordWrap: false,
        dirty: false,
        saving: false,
        baseRevision: 'rev-a',
        externalChange: false
      },
      statusLabels
    )).toBeUndefined();
  });
});
