import { describe, expect, it } from 'vitest';
import {
  closeTextEditorWindowState,
  dragTextEditorWindowState,
  openTextEditorWindowState,
  textBufferStatus
} from './textEditorWindows';

describe('text editor window state', () => {
  it('opens existing windows and creates new windows with stable defaults', () => {
    expect(openTextEditorWindowState({}, 'notes/brief.md')).toEqual({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 420,
        y: 110,
        width: 820,
        height: 620
      }
    });

    expect(openTextEditorWindowState({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: false,
        x: 32,
        y: 48,
        width: 600,
        height: 500
      }
    }, 'notes/brief.md')).toEqual({
      'notes/brief.md': {
        projectRelativePath: 'notes/brief.md',
        open: true,
        x: 32,
        y: 48,
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
    expect(dragTextEditorWindowState(windows, 'notes/brief.md', { dx: -20, dy: 7 })['notes/brief.md']).toMatchObject({
      x: 8,
      y: 27
    });
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
