import { describe, expect, it } from 'vitest';
import {
  closeTextEditorWindowState,
  constrainOpenTextEditorWindowsToViewport,
  dragTextEditorWindowState,
  openTextEditorWindowState,
  textBufferStatus
} from './textEditorWindows';

const viewport = { x: 0, y: 0, width: 1280, height: 720 };

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

  it('closes and drags existing windows without inventing missing entries', () => {
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
    expect(dragTextEditorWindowState(windows, 'notes/brief.md', { dx: -20, dy: 7 }, viewport)['notes/brief.md']).toMatchObject({
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

  it('does not surface the default saved text buffer state', () => {
    expect(textBufferStatus({
      projectRelativePath: 'notes/brief.md',
      content: '# Brief',
      language: 'markdown',
      wordWrap: false,
      dirty: false,
      saving: false,
      diskRevision: 'rev-a',
      lastSavedRevision: 'rev-a',
      externalChange: false
    })).toBeUndefined();
  });
});
