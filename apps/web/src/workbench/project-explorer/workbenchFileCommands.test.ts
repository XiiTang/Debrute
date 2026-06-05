import { describe, expect, it } from 'vitest';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';
import {
  clearClipboardAfterDeletedPath,
  clearClipboardAfterPaste,
  clearCanvasSelectionAfterDeletedPath,
  nearestExistingParentSelection,
  permanentDeleteConfirmationMessage,
  notificationMessageForFileCommandError
} from './workbenchFileCommands';

describe('workbench file command helpers', () => {
  it('clears only completed cut clipboards after paste', () => {
    const copy: WorkbenchFileClipboard = { operation: 'copy', projectRelativePath: 'a.md', kind: 'file' };
    const cut: WorkbenchFileClipboard = { operation: 'cut', projectRelativePath: 'a.md', kind: 'file' };

    expect(clearClipboardAfterPaste(copy)).toBe(copy);
    expect(clearClipboardAfterPaste(cut)).toBeUndefined();
  });

  it('finds the nearest existing parent selection after deletion', () => {
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['assets', 'assets/pages']))).toBe('assets/pages');
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['assets']))).toBe('assets');
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['briefs']))).toBeUndefined();
  });

  it('clears Canvas node selections for deleted project paths', () => {
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'node', projectRelativePath: 'assets/pages/page.png' }, 'assets')).toBeUndefined();
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'node', projectRelativePath: 'assets/pages/page.png' }, 'assets/pages/page.png')).toBeUndefined();
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'node', projectRelativePath: 'briefs/concept.md' }, 'assets')).toEqual({
      kind: 'node',
      projectRelativePath: 'briefs/concept.md'
    });
    expect(clearCanvasSelectionAfterDeletedPath({
      kind: 'multi',
      items: [
        { kind: 'node', projectRelativePath: 'assets/cover.png' },
        { kind: 'node', projectRelativePath: 'briefs/concept.md' }
      ]
    }, 'assets')).toEqual({ kind: 'node', projectRelativePath: 'briefs/concept.md' });
  });

  it('clears clipboard sources affected by deleted paths', () => {
    const source: WorkbenchFileClipboard = {
      operation: 'copy',
      projectRelativePath: 'assets/pages/page.png',
      kind: 'file'
    };

    expect(clearClipboardAfterDeletedPath(source, 'assets')).toBeUndefined();
    expect(clearClipboardAfterDeletedPath(source, 'assets/pages/page.png')).toBeUndefined();
    expect(clearClipboardAfterDeletedPath(source, 'briefs')).toBe(source);
  });

  it('formats permanent delete confirmations by target kind', () => {
    expect(permanentDeleteConfirmationMessage({
      projectRelativePath: 'assets',
      kind: 'directory'
    })).toBe('Permanently delete directory "assets"? This cannot be undone.');
    expect(permanentDeleteConfirmationMessage({
      projectRelativePath: 'briefs/concept.md',
      kind: 'file'
    })).toBe('Permanently delete file "briefs/concept.md"? This cannot be undone.');
  });

  it('formats command errors for notifications', () => {
    expect(notificationMessageForFileCommandError('Paste failed', new Error('File exists'))).toBe('Paste failed: File exists');
    expect(notificationMessageForFileCommandError('Rename failed', 'bad')).toBe('Rename failed: bad');
  });
});
